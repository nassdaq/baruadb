import { Tab, TabGroup, TabList, TabPanel, TabPanels, Textarea } from "@headlessui/react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, CATALOG, ident, type Database, type QueryResult } from "./api";
import { ago, Button, Card, cx, Dot, Empty, ErrorNote, Metric, Select } from "./components";

const ROW_LIMIT = 100;

export function DatabaseDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [db, setDb] = useState<Database | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.database(id).then(setDb).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!db) return <Empty>loading…</Empty>;

  const tabClass = ({ selected }: { selected: boolean }) =>
    cx(
      "border-b-2 px-0.5 pb-2 text-[13px] focus:outline-none",
      selected ? "border-paper text-paper" : "border-transparent text-mute-400 hover:text-paper",
    );

  return (
    <>
      <button onClick={onBack} className="mb-4 text-[13px] text-mute-400 hover:text-paper">
        ← all databases
      </button>
      <div className="mb-5 flex items-center gap-2.5">
        <Dot state={db.status === "ready" ? db.state : db.status} />
        <h2 className="text-[15px] font-medium">{db.name}</h2>
        <span className="font-mono text-xs text-mute-500">{db.id}</span>
      </div>

      <TabGroup>
        <TabList className="mb-5 flex gap-6 border-b border-ink-700">
          <Tab className={tabClass}>Overview</Tab>
          <Tab className={tabClass}>Tables</Tab>
          <Tab className={tabClass}>SQL</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <Overview db={db} />
          </TabPanel>
          <TabPanel>
            <Tables id={id} />
          </TabPanel>
          <TabPanel>
            <SqlEditor id={id} />
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ db }: { db: Database }) {
  const [points, setPoints] = useState<{ earliest: string | null; snapshots: { taken_at: string; kind: string }[] } | null>(
    null,
  );
  useEffect(() => {
    api.restorePoints(db.id).then(setPoints).catch(() => setPoints(null));
  }, [db.id]);

  return (
    <>
      <Card className="mb-3.5 p-4">
        <div className="mb-4 flex flex-wrap gap-10">
          <Metric label="State" value={db.status === "ready" ? db.state : db.status} />
          <Metric label="Connections" value={db.connections} />
          <Metric label="Where" value={db.state === "cold" ? "R2 only" : "box disk"} />
          <Metric label="Created" value={ago(db.created_at)} tone="plain" />
          {db.parent_id && <Metric label="Branched from" value={db.parent_id} tone="plain" />}
        </div>
        <div className="text-[11px] uppercase tracking-[0.06em] text-mute-500">Connection string</div>
        <div className="mt-2 overflow-auto whitespace-nowrap rounded-md border border-ink-700 bg-ink-950 px-3 py-2.5 font-mono text-xs text-mute-400">
          {db.connection_uri}
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => navigator.clipboard.writeText(db.connection_uri)}>Copy</Button>
        </div>
        <p className="mt-3 text-xs text-mute-500">
          The password appears only when a database is created or its password reset.
        </p>
      </Card>

      <Card className="p-4">
        <div className="mb-3 text-[11px] uppercase tracking-[0.06em] text-mute-500">Restore points</div>
        {!points ? (
          <div className="text-[13px] text-mute-500">…</div>
        ) : points.snapshots.length === 0 ? (
          <div className="text-[13px] text-mute-500">No snapshots yet.</div>
        ) : (
          <>
            <table className="w-full text-[13px]">
              <tbody>
                {points.snapshots.map((s) => (
                  <tr key={s.taken_at} className="border-b border-ink-850 last:border-0">
                    <td className="py-2 text-mute-400">{new Date(s.taken_at).toLocaleString()}</td>
                    <td className="py-2 text-right text-mute-500">{s.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-mute-500">
              Earliest moment you can branch from: {points.earliest ? new Date(points.earliest).toLocaleString() : "—"}
            </p>
          </>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- tables

type Column = { name: string; type: string; not_null: string; default_value: string | null; is_primary_key: string };

function Tables({ id }: { id: string }) {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("public");
  const [tables, setTables] = useState<{ name: string; kind: string; rows: string; size: string }[]>([]);
  const [table, setTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback((sql: string, limit = ROW_LIMIT) => api.query(id, sql, limit), [id]);

  useEffect(() => {
    run(CATALOG.schemas, 200)
      .then((r) => {
        const names = r.rows.map((row) => row[0] as string);
        setSchemas(names);
        if (!names.includes("public") && names[0]) setSchema(names[0]);
      })
      .catch((e) => setError(e.message));
  }, [run]);

  useEffect(() => {
    setTable(null);
    setRows(null);
    run(CATALOG.tables(schema), 500)
      .then((r) => setTables(r.rows.map((x) => ({ name: x[0]!, kind: x[1]!, rows: x[2]!, size: x[3]! }))))
      .catch((e) => setError(e.message));
  }, [schema, run]);

  const open = async (name: string) => {
    setTable(name);
    setBusy(true);
    setError("");
    try {
      const [cols, data] = await Promise.all([
        run(CATALOG.columns(schema, name), 500),
        run(`select * from ${ident(schema)}.${ident(name)} limit ${ROW_LIMIT}`),
      ]);
      setColumns(
        cols.rows.map((c) => ({
          name: c[0]!,
          type: c[1]!,
          not_null: c[2]!,
          default_value: c[3],
          is_primary_key: c[4]!,
        })),
      );
      setRows(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <Select value={schema} onChange={setSchema} options={schemas.length ? schemas : ["public"]} label="schema" />
        <span className="text-[13px] text-mute-500">
          {tables.length} {tables.length === 1 ? "table" : "tables"}
        </span>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex gap-4">
        <Card className="w-60 shrink-0 overflow-hidden">
          {tables.length === 0 ? (
            <div className="p-4 text-[13px] text-mute-500">No tables in this schema.</div>
          ) : (
            tables.map((t) => (
              <button
                key={t.name}
                onClick={() => open(t.name)}
                className={cx(
                  "block w-full border-b border-ink-850 px-3.5 py-2.5 text-left last:border-0",
                  table === t.name ? "bg-ink-850 text-paper" : "text-mute-400 hover:bg-ink-850",
                )}
              >
                <div className="truncate text-[13px]">{t.name}</div>
                <div className="mt-0.5 text-[11px] text-mute-500">
                  {t.kind} · {t.size}
                </div>
              </button>
            ))
          )}
        </Card>

        <div className="min-w-0 flex-1">
          {!table ? (
            <Empty>Pick a table.</Empty>
          ) : busy ? (
            <Empty>loading…</Empty>
          ) : (
            <>
              <Card className="mb-3.5 overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-ink-700 text-[11px] uppercase tracking-[0.06em] text-mute-500">
                      <th className="px-4 py-3 text-left font-normal">Column</th>
                      <th className="px-4 py-3 text-left font-normal">Type</th>
                      <th className="px-4 py-3 text-left font-normal">Nullable</th>
                      <th className="px-4 py-3 text-left font-normal">Default</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((c) => (
                      <tr key={c.name} className="border-b border-ink-850 last:border-0">
                        <td className="px-4 py-2.5 text-paper">
                          {c.name}
                          {c.is_primary_key === "t" && <span className="ml-2 text-[11px] text-live">pk</span>}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-mute-400">{c.type}</td>
                        <td className="px-4 py-2.5 text-mute-400">{c.not_null === "t" ? "no" : "yes"}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-mute-500">{c.default_value ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              {rows && <Grid result={rows} />}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- sql

function SqlEditor({ id }: { id: string }) {
  const [sql, setSql] = useState("select * from information_schema.tables\nwhere table_schema = 'public';");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await api.query(id, sql, ROW_LIMIT));
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="mb-3.5 overflow-hidden">
        <Textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
          }}
          rows={8}
          spellCheck={false}
          className="w-full resize-y bg-ink-950 p-4 font-mono text-[12.5px] text-paper focus:outline-none"
        />
        <div className="flex items-center gap-3 border-t border-ink-700 px-4 py-2.5">
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run"}
          </Button>
          <span className="text-xs text-mute-500">⌘↵ runs · statements run as your database role</span>
          {result && (
            <span className="ml-auto text-xs text-mute-500">
              {result.ms} ms{result.rows_affected !== null && ` · ${result.rows_affected} rows`}
            </span>
          )}
        </div>
      </Card>
      {error && <ErrorNote>{error}</ErrorNote>}
      {result && <Grid result={result} />}
    </>
  );
}

// ---------------------------------------------------------------- grid

function Grid({ result }: { result: QueryResult }) {
  if (result.columns.length === 0) {
    return (
      <Card className="p-4 text-[13px] text-mute-400">
        No rows returned{result.rows_affected !== null && ` · ${result.rows_affected} affected`}.
      </Card>
    );
  }
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-ink-700 text-[11px] uppercase tracking-[0.06em] text-mute-500">
            {result.columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-4 py-3 text-left font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="border-b border-ink-850 last:border-0 hover:bg-ink-850">
              {row.map((cell, j) => (
                <td key={j} className="max-w-xs truncate px-4 py-2.5 font-mono text-xs text-mute-400">
                  {cell === null ? <span className="text-mute-500 italic">null</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated && (
        <div className="border-t border-ink-700 px-4 py-2.5 text-xs text-warn">
          Showing the first {result.rows.length} rows. Add a LIMIT or a WHERE to see the rest.
        </div>
      )}
    </Card>
  );
}
