import { Textarea } from "@headlessui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, CATALOG, ident, literal, type Database, type QueryResult } from "./api";
import {
  ago,
  Badge,
  Button,
  Card,
  CopyField,
  cx,
  Dot,
  Empty,
  ErrorNote,
  Modal,
  SearchBox,
  Select,
  Stat,
  TextField,
} from "./components";
import { NavGroup, NavLink, PageHead } from "./Shell";

export type Section = "overview" | "branches" | "tables" | "sql" | "backups" | "roles";
const PAGE = 50;

// ---------------------------------------------------------------- sidebar

export function DatabaseSidebar({
  db,
  section,
  onSection,
  onBack,
  onConnect,
}: {
  db: Database;
  section: Section;
  onSection: (s: Section) => void;
  onBack: () => void;
  onConnect: () => void;
}) {
  return (
    <>
      <div className="px-3 pb-3">
        <button
          onClick={onBack}
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-line bg-base px-2.5 py-2 text-left text-[13px] hover:bg-raise"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{db.name}</span>
            <span className="block truncate text-[11px] text-faint">
              ↳ {db.parent_id ? "branch" : "primary"} · {db.database}
            </span>
          </span>
          <span className="text-faint">⌃⌄</span>
        </button>
        <Button variant="accent" className="w-full justify-center" onClick={onConnect}>
          Connect
        </Button>
      </div>

      <NavGroup>
        <NavLink label="Overview" active={section === "overview"} onClick={() => onSection("overview")} />
        <NavLink label="Branches" active={section === "branches"} onClick={() => onSection("branches")} />
      </NavGroup>

      <NavGroup title="Postgres database">
        <NavLink label="Tables" active={section === "tables"} onClick={() => onSection("tables")} />
        <NavLink label="SQL Editor" active={section === "sql"} onClick={() => onSection("sql")} />
        <NavLink label="Backup & Restore" active={section === "backups"} onClick={() => onSection("backups")} />
        <NavLink label="Roles" active={section === "roles"} onClick={() => onSection("roles")} />
      </NavGroup>
    </>
  );
}

// ---------------------------------------------------------------- router

export function DatabaseView({
  db,
  section,
  reload,
  onBack,
}: {
  db: Database;
  section: Section;
  reload: () => void;
  onBack: () => void;
}) {
  if (section === "tables") return <TablesConsole db={db} />;
  if (section === "sql") return <SqlEditor db={db} />;
  return (
    <div className="mx-auto max-w-[1100px] px-8 py-7">
      {section === "overview" && <Overview db={db} />}
      {section === "branches" && <Branches db={db} reload={reload} onOpen={onBack} />}
      {section === "backups" && <Backups db={db} />}
      {section === "roles" && <Roles db={db} />}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ db }: { db: Database }) {
  const [size, setSize] = useState<string | null>(null);

  useEffect(() => {
    // Only ask a database that is already up: waking one just to print a
    // number would defeat the point of scaling to zero.
    if (db.state !== "awake") return;
    api
      .query(db.id, "select pg_size_pretty(pg_database_size(current_database()))", 1)
      .then((r) => setSize(r.rows[0]?.[0] ?? null))
      .catch(() => setSize(null));
  }, [db.id, db.state]);

  return (
    <>
      <PageHead
        title={db.name}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Dot state={db.status === "ready" ? db.state : db.status} />
            {db.status === "ready" ? db.state : db.status} · Linode EU (Amsterdam) · Postgres 16
          </span>
        }
      />
      <Card className="mb-4 p-5">
        <div className="flex flex-wrap gap-8">
          <Stat label="State" value={db.status === "ready" ? db.state : db.status} />
          <Stat label="Connections" value={db.connections} />
          <Stat label="Storage" value={size ?? (db.state === "awake" ? "…" : "—")} hint="Size on disk when awake" />
          <Stat label="Created" value={ago(db.created_at)} />
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <div className="mb-2 text-[13px] font-medium">Connection string</div>
        <CopyField value={db.connection_uri} />
        <p className="mt-2.5 text-xs text-faint">
          The password appears once, when the database is created or its password reset.
        </p>
        <div className="mt-4 border-t border-line-soft pt-4">
          <div className="mb-2 text-[13px] font-medium">psql</div>
          <CopyField value={`psql "${db.connection_uri}"`} />
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- branches

function Branches({ db, reload, onOpen }: { db: Database; reload: () => void; onOpen: () => void }) {
  const [all, setAll] = useState<Database[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api.databases().then(setAll).catch((e) => setError(e.message));
  }, [db.id]);

  const children = all.filter((d) => d.parent_id === db.id);
  const parent = all.find((d) => d.id === db.parent_id);

  return (
    <>
      <PageHead
        title="Branches"
        subtitle="A branch is a full copy taken at a moment in time, with its own storage and its own connection string."
        actions={
          <Button
            variant="accent"
            onClick={async () => {
              const name = prompt("Branch name");
              if (!name) return;
              try {
                await api.branch(db.id, name);
                reload();
                onOpen();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            Create branch
          </Button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Card className="overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-dim">
              <th className="px-4 py-2.5 font-normal">Name</th>
              <th className="px-4 py-2.5 font-normal">Relationship</th>
              <th className="px-4 py-2.5 font-normal">State</th>
              <th className="px-4 py-2.5 font-normal">Created</th>
            </tr>
          </thead>
          <tbody>
            {parent && <BranchRow d={parent} rel="parent" />}
            <BranchRow d={db} rel="this database" />
            {children.map((d) => (
              <BranchRow key={d.id} d={d} rel="branch of this" />
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

const BranchRow = ({ d, rel }: { d: Database; rel: string }) => (
  <tr className="border-b border-line-soft last:border-0">
    <td className="px-4 py-2.5">
      <span className="font-medium">{d.name}</span>
      <span className="ml-2 font-mono text-xs text-faint">{d.id}</span>
    </td>
    <td className="px-4 py-2.5 text-dim">{rel}</td>
    <td className="px-4 py-2.5">
      <span className="inline-flex items-center gap-2 text-dim">
        <Dot state={d.status === "ready" ? d.state : d.status} />
        {d.status === "ready" ? d.state : d.status}
      </span>
    </td>
    <td className="px-4 py-2.5 text-dim">{ago(d.created_at)}</td>
  </tr>
);

// ---------------------------------------------------------------- backups

function Backups({ db }: { db: Database }) {
  const [points, setPoints] = useState<{ earliest: string | null; snapshots: { taken_at: string; kind: string }[] } | null>(
    null,
  );
  const [error, setError] = useState("");
  useEffect(() => {
    api.restorePoints(db.id).then(setPoints).catch((e) => setError(e.message));
  }, [db.id]);

  return (
    <>
      <PageHead
        title="Backup & Restore"
        subtitle="Snapshots and write-ahead log live in R2. Branch from any moment inside the window to recover."
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <Card className="mb-4 p-5">
        <Stat
          label="Earliest restore point"
          value={points?.earliest ? new Date(points.earliest).toLocaleString() : "—"}
        />
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-dim">
              <th className="px-4 py-2.5 font-normal">Taken at</th>
              <th className="px-4 py-2.5 font-normal">Kind</th>
            </tr>
          </thead>
          <tbody>
            {!points ? (
              <tr>
                <td colSpan={2} className="px-4 py-10 text-center text-faint">
                  Loading…
                </td>
              </tr>
            ) : points.snapshots.length === 0 ? (
              <tr>
                <td colSpan={2} className="px-4 py-10 text-center text-faint">
                  No snapshots yet.
                </td>
              </tr>
            ) : (
              points.snapshots.map((s) => (
                <tr key={s.taken_at} className="border-b border-line-soft last:border-0">
                  <td className="px-4 py-2.5 text-dim">{new Date(s.taken_at).toLocaleString()}</td>
                  <td className="px-4 py-2.5">
                    <Badge>{s.kind}</Badge>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- roles

function Roles({ db }: { db: Database }) {
  const [rows, setRows] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .query(
        db.id,
        `select r.rolname as name, r.rolcanlogin::text as can_login, r.rolsuper::text as superuser,
                r.rolcreatedb::text as create_db
           from pg_roles r where r.rolname not like 'pg\\_%' order by 1`,
        50,
      )
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [db.id]);

  return (
    <>
      <PageHead title="Roles" subtitle="Roles inside this database. Yours owns the data; none of them is a superuser." />
      {error && <ErrorNote>{error}</ErrorNote>}
      {rows && <Grid result={rows} />}
    </>
  );
}

// ---------------------------------------------------------------- tables

type TableRow = { name: string; kind: string; rows: string; size: string };

function TablesConsole({ db }: { db: Database }) {
  const [schemas, setSchemas] = useState<string[]>(["public"]);
  const [schema, setSchema] = useState("public");
  const [tables, setTables] = useState<TableRow[]>([]);
  const [filter, setFilter] = useState("");
  const [table, setTable] = useState<string | null>(null);
  const [view, setView] = useState<"data" | "structure">("data");
  const [columns, setColumns] = useState<QueryResult | null>(null);
  const [rows, setRows] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const run = useCallback((sql: string, limit = PAGE) => api.query(db.id, sql, limit), [db.id]);

  useEffect(() => {
    run(CATALOG.schemas, 200)
      .then((r) => {
        const names = r.rows.map((x) => x[0]!);
        if (names.length) setSchemas(names);
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

  const loadRows = useCallback(
    async (name: string, p: number, s: typeof sort) => {
      setBusy(true);
      setError("");
      try {
        const order = s ? ` order by ${ident(s.col)} ${s.dir === "asc" ? "asc" : "desc"}` : "";
        const data = await run(
          `select * from ${ident(schema)}.${ident(name)}${order} limit ${PAGE} offset ${p * PAGE}`,
        );
        setRows(data);
      } catch (e) {
        setRows(null);
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [run, schema],
  );

  const open = async (name: string) => {
    setTable(name);
    setPage(0);
    setSort(null);
    setView("data");
    run(CATALOG.columns(schema, name), 500).then(setColumns).catch(() => setColumns(null));
    loadRows(name, 0, null);
  };

  const meta = columns?.rows ?? [];
  const pk = meta.filter((c) => c[4] === "t").map((c) => c[0]!);
  const isView = (tables.find((t) => t.name === table)?.kind ?? "table") !== "table";
  const editPlan: EditPlan | null =
    table && pk.length > 0 && !isView
      ? {
          pk,
          readOnly: new Set(meta.filter((c) => c[5] === "t").map((c) => c[0]!)),
          nullable: new Set(meta.filter((c) => c[2] !== "t").map((c) => c[0]!)),
          save: async (row, column, value) => {
            const at = (name: string) => rows!.columns.indexOf(name);
            const where = pk
              .map((k) => {
                const v = row[at(k)];
                if (v === null) throw new Error(`cannot edit a row whose ${k} is null`);
                return `${ident(k)} = ${literal(v)}`;
              })
              .join(" and ");
            const set = value === null ? "null" : literal(value);
            const r = await run(
              `update ${ident(schema)}.${ident(table)} set ${ident(column)} = ${set} where ${where}`,
              1,
            );
            if (r.rows_affected === 0) throw new Error("no row matched; it may have been deleted");
            await loadRows(table, page, sort);
          },
        }
      : null;

  const whyReadOnly = !table
    ? null
    : isView
      ? "This is a view. Edit the tables underneath it."
      : pk.length === 0
        ? "This table has no primary key, so a row cannot be identified safely. Add one to edit here."
        : null;

  const estimated = tables.find((t) => t.name === table)?.rows;
  const visible = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex h-full min-h-0">
      {/* table list */}
      <div className="flex w-[250px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[17px] font-semibold">Tables</h2>
          <div className="mt-0.5 truncate text-[11px] text-faint">
            {db.name} / {db.database}
          </div>
        </div>
        <div className="space-y-2 border-b border-line p-3">
          <Select value={schema} onChange={setSchema} options={schemas} />
          <SearchBox value={filter} onChange={setFilter} placeholder="Search…" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-faint">No tables</div>
          ) : (
            visible.map((t) => (
              <button
                key={t.name}
                onClick={() => open(t.name)}
                className={cx(
                  "mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                  table === t.name ? "bg-raise text-text" : "text-dim hover:bg-raise/60 hover:text-text",
                )}
              >
                <span className={cx("text-xs", table === t.name ? "text-neon" : "text-faint")}>▦</span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="shrink-0 text-[10px] text-faint">{t.size}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* data pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!table ? (
          <Empty>Pick a table to see its rows.</Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <div className="flex overflow-hidden rounded-md border border-line">
                {(["data", "structure"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={cx(
                      "px-3 py-1 text-[12px] uppercase tracking-wide",
                      view === v ? "bg-neon/15 text-neon" : "text-dim hover:bg-raise",
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <Button size="sm" onClick={() => setAdding(true)}>
                ⊕ Add record
              </Button>
              <Button size="sm" onClick={() => loadRows(table, page, sort)} title="Refresh">
                ↻
              </Button>
              {sort && (
                <Badge>
                  sorted by {sort.col} {sort.dir}
                </Badge>
              )}
              {whyReadOnly ? (
                <span className="text-[11px] text-faint" title={whyReadOnly}>
                  read only
                </span>
              ) : (
                <span className="text-[11px] text-faint">double-click a cell to edit</span>
              )}
              <div className="ml-auto flex items-center gap-3 text-[12px] text-dim">
                {rows && <span className="text-faint">{rows.ms} ms</span>}
                <span>
                  {page * PAGE + 1} – {page * PAGE + (rows?.rows.length ?? 0)}
                  {estimated && Number(estimated) > 0 && ` of ~${Number(estimated).toLocaleString()}`}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    disabled={page === 0}
                    onClick={() => {
                      setPage(page - 1);
                      loadRows(table, page - 1, sort);
                    }}
                  >
                    ‹
                  </Button>
                  <Button
                    size="sm"
                    disabled={(rows?.rows.length ?? 0) < PAGE}
                    onClick={() => {
                      setPage(page + 1);
                      loadRows(table, page + 1, sort);
                    }}
                  >
                    ›
                  </Button>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
              {busy ? (
                <Empty>Loading…</Empty>
              ) : view === "structure" ? (
                columns && <Structure result={columns} />
              ) : (
                rows && (
                  <Grid
                    result={rows}
                    types={columnTypes(columns)}
                    edit={editPlan}
                    sort={sort}
                    onSort={(col) => {
                      const next: typeof sort =
                        sort?.col === col ? { col, dir: sort.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" };
                      setSort(next);
                      setPage(0);
                      loadRows(table, 0, next);
                    }}
                    flush
                  />
                )
              )}
            </div>
          </>
        )}
      </div>

      {table && columns && (
        <AddRecord
          open={adding}
          onClose={() => setAdding(false)}
          columns={columns}
          onInsert={async (cols, values) => {
            await run(
              `insert into ${ident(schema)}.${ident(table)} (${cols.map(ident).join(", ")})
               values (${values.map((v) => (v === "" ? "default" : literal(v))).join(", ")})`,
              1,
            );
            setAdding(false);
            loadRows(table, page, sort);
          }}
        />
      )}
    </div>
  );
}

type EditPlan = {
  /** Columns that identify a row. Without them an UPDATE could hit many rows. */
  pk: string[];
  /** Columns Postgres computes; writing them is an error. */
  readOnly: Set<string>;
  nullable: Set<string>;
  save: (row: (string | null)[], column: string, value: string | null) => Promise<void>;
};

const columnTypes = (columns: QueryResult | null): Record<string, string> =>
  Object.fromEntries((columns?.rows ?? []).map((c) => [c[0]!, c[1]!]));

function Structure({ result }: { result: QueryResult }) {
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-panel">
        <tr className="border-b border-line text-left text-[12px] text-dim">
          <th className="px-4 py-2.5 font-normal">Column</th>
          <th className="px-4 py-2.5 font-normal">Type</th>
          <th className="px-4 py-2.5 font-normal">Nullable</th>
          <th className="px-4 py-2.5 font-normal">Default</th>
        </tr>
      </thead>
      <tbody>
        {result.rows.map((c) => (
          <tr key={c[0]} className="border-b border-line-soft last:border-0 hover:bg-raise/40">
            <td className="px-4 py-2.5">
              {c[0]}
              {c[4] === "t" && <span className="ml-2 text-[11px] text-neon">pk</span>}
            </td>
            <td className="px-4 py-2.5 font-mono text-xs text-dim">{c[1]}</td>
            <td className="px-4 py-2.5 text-dim">{c[2] === "t" ? "no" : "yes"}</td>
            <td className="px-4 py-2.5 font-mono text-xs text-faint">{c[3] ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddRecord({
  open,
  onClose,
  columns,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  columns: QueryResult;
  onInsert: (cols: string[], values: string[]) => Promise<void>;
}) {
  const editable = useMemo(
    () => columns.rows.filter((c) => !(c[3] ?? "").startsWith("nextval(")),
    [columns],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="Add record">
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="mb-3 text-xs text-faint">Leave a field empty to use its default.</p>
      <div className="max-h-[50vh] overflow-y-auto pr-1">
        {editable.map((c) => (
          <TextField
            key={c[0]}
            label={`${c[0]}  ·  ${c[1]}`}
            value={values[c[0]!] ?? ""}
            onChange={(v) => setValues((s) => ({ ...s, [c[0]!]: v }))}
            mono
          />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          variant="accent"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const cols = editable.map((c) => c[0]!).filter((n) => (values[n] ?? "") !== "");
              if (cols.length === 0) throw new Error("fill at least one column");
              await onInsert(cols, cols.map((n) => values[n]!));
              setValues({});
            } catch (e) {
              setError(e instanceof ApiError ? e.message : String((e as Error).message ?? e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Inserting…" : "Insert"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- sql

function SqlEditor({ db }: { db: Database }) {
  const [sql, setSql] = useState("select * from information_schema.tables\nwhere table_schema = 'public';");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await api.query(db.id, sql, 200));
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[15px] font-medium">SQL Editor</h2>
        <span className="text-xs text-faint">runs as {db.role}</span>
        <div className="ml-auto flex items-center gap-3">
          {result && (
            <span className="text-xs text-faint">
              {result.ms} ms{result.rows_affected !== null && ` · ${result.rows_affected} rows`}
            </span>
          )}
          <Button variant="accent" size="sm" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run ⌘↵"}
          </Button>
        </div>
      </div>
      <Textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
        }}
        spellCheck={false}
        className="h-48 w-full shrink-0 resize-y border-b border-line bg-base p-4 font-mono text-[12.5px] text-text focus:outline-none"
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : result ? (
          <Grid result={result} flush />
        ) : (
          <Empty>Results appear here.</Empty>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- grid

function Grid({
  result,
  types,
  sort,
  onSort,
  edit,
  flush,
}: {
  result: QueryResult;
  types?: Record<string, string>;
  sort?: { col: string; dir: "asc" | "desc" } | null;
  onSort?: (col: string) => void;
  edit?: EditPlan | null;
  flush?: boolean;
}) {
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null);
  const [error, setError] = useState("");
  if (result.columns.length === 0) {
    return (
      <div className={cx("text-[13px] text-dim", flush ? "p-4" : "")}>
        No rows returned{result.rows_affected !== null && ` · ${result.rows_affected} affected`}.
      </div>
    );
  }
  const body = (
    <table className="w-full border-separate border-spacing-0">
      <thead className="sticky top-0 z-10">
        <tr>
          <th className="w-9 border-b border-r border-line bg-panel px-2 py-2" />
          {result.columns.map((c) => (
            <th
              key={c}
              onClick={() => onSort?.(c)}
              className={cx(
                "whitespace-nowrap border-b border-r border-line bg-panel px-3 py-2 text-left text-[12px] font-normal last:border-r-0",
                onSort && "cursor-pointer hover:bg-raise",
              )}
            >
              <span className="text-text">{c}</span>
              {types?.[c] && <span className="ml-2 font-mono text-[11px] text-faint">{types[c]}</span>}
              {sort?.col === c && <span className="ml-1 text-neon">{sort.dir === "asc" ? "↑" : "↓"}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr key={i} className="group">
            <td className="border-b border-r border-line-soft px-2 py-1.5 text-center text-[11px] text-faint group-hover:bg-raise/40">
              {i + 1}
            </td>
            {row.map((cell, j) => {
              const col = result.columns[j]!;
              const writable = Boolean(edit) && !edit!.readOnly.has(col);
              const active = editing?.row === i && editing.col === col;
              return (
                <td
                  key={j}
                  onDoubleClick={() => writable && setEditing({ row: i, col })}
                  className={cx(
                    "max-w-[320px] border-b border-r border-line-soft px-3 py-1.5 font-mono text-[12px] text-dim last:border-r-0",
                    active ? "bg-raise p-0" : "truncate group-hover:bg-raise/40",
                    writable && !active && "cursor-text",
                  )}
                  title={writable ? (cell ?? "null") : edit ? `${col} is generated by the database` : (cell ?? "null")}
                >
                  {active ? (
                    <CellEditor
                      initial={cell}
                      nullable={edit!.nullable.has(col)}
                      onCancel={() => setEditing(null)}
                      onSave={async (value) => {
                        setError("");
                        try {
                          await edit!.save(row, col, value);
                          setEditing(null);
                        } catch (e) {
                          setError(e instanceof ApiError ? e.message : String((e as Error).message ?? e));
                        }
                      }}
                    />
                  ) : cell === null ? (
                    <span className="text-faint italic">NULL</span>
                  ) : (
                    cell
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      {error && (
        <div className="sticky left-0 border-t border-line bg-rose/5 px-4 py-2 text-xs text-rose/90">{error}</div>
      )}
      {flush ? body : <Card className="overflow-x-auto">{body}</Card>}
      {result.truncated && (
        <div className="border-t border-line px-4 py-2 text-xs text-amber">
          Showing the first {result.rows.length} rows.
        </div>
      )}
    </>
  );
}


/** One cell, open for editing. Enter saves, Escape cancels, ∅ writes NULL.
 *  Typing "NULL" is deliberately not special: a text column may hold that word. */
function CellEditor({
  initial,
  nullable,
  onSave,
  onCancel,
}: {
  initial: string | null;
  nullable: boolean;
  onSave: (value: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);

  const commit = async (v: string | null) => {
    if (v === initial) return onCancel();
    setBusy(true);
    await onSave(v);
    setBusy(false);
  };

  return (
    <div className="flex items-center gap-1 px-1 py-0.5">
      <input
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => commit(value)}
        className="w-full min-w-0 rounded border border-neon/50 bg-base px-1.5 py-1 font-mono text-[12px] text-text focus:outline-none"
      />
      {nullable && (
        <button
          onMouseDown={(e) => {
            // mousedown, not click: blur would commit the text value first.
            e.preventDefault();
            commit(null);
          }}
          title="Set NULL"
          className="shrink-0 rounded border border-line px-1 text-[11px] text-faint hover:text-text"
        >
          ∅
        </button>
      )}
    </div>
  );
}
