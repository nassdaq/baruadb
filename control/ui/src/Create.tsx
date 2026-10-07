// The "+" menu in the table list: everything you can make inside a database.
// Each form builds SQL and runs it through the same query endpoint the rest of
// the console uses, so nothing here can do more than the database's own role.
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import {
  ArrowUpTrayIcon,
  PlusIcon,
  RectangleGroupIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
  TableCellsIcon,
  UserPlusIcon,
  ViewColumnsIcon,
} from "@heroicons/react/20/solid";
import { useState } from "react";
import { ident, literal, type QueryResult } from "./api";
import { Button, cx, ErrorNote, Modal, Select, TextField } from "./components";

export type Kind = "schema" | "table" | "view" | "enum" | "role" | "policy" | "csv";

const ITEMS: { kind: Kind; label: string; icon: typeof PlusIcon }[] = [
  { kind: "schema", label: "Create schema", icon: Squares2X2Icon },
  { kind: "table", label: "Create table", icon: TableCellsIcon },
  { kind: "view", label: "Create view", icon: ViewColumnsIcon },
  { kind: "enum", label: "Create enum", icon: RectangleGroupIcon },
  { kind: "role", label: "Create role", icon: UserPlusIcon },
  { kind: "policy", label: "Create policy", icon: ShieldCheckIcon },
];

export function CreateMenu({ onPick }: { onPick: (k: Kind) => void }) {
  return (
    <Menu>
      <MenuButton
        title="Create"
        className="rounded-md border border-line bg-panel p-1.5 text-dim data-hover:bg-raise data-hover:text-text"
      >
        <PlusIcon className="size-4" />
      </MenuButton>
      <MenuItems
        anchor="bottom start"
        className="z-50 mt-1 w-52 rounded-md border border-line bg-panel p-1 text-[13px] shadow-2xl focus:outline-none"
      >
        {ITEMS.map((it) => (
          <MenuItem key={it.kind}>
            <button
              onClick={() => onPick(it.kind)}
              className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-dim data-focus:bg-raise data-focus:text-text"
            >
              <it.icon className="size-4 text-faint" />
              {it.label}
            </button>
          </MenuItem>
        ))}
        <div className="my-1 border-t border-line" />
        <MenuItem>
          <button
            onClick={() => onPick("csv")}
            className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-dim data-focus:bg-raise data-focus:text-text"
          >
            <ArrowUpTrayIcon className="size-4 text-faint" />
            Import CSV
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}

// ---------------------------------------------------------------- dialogs

const TYPES = [
  "text",
  "varchar(255)",
  "integer",
  "bigint",
  "numeric(12,2)",
  "boolean",
  "date",
  "timestamptz",
  "uuid",
  "jsonb",
  "serial",
  "bigserial",
];

type Col = { name: string; type: string; notNull: boolean; pk: boolean; default: string };

export function CreateDialogs({
  kind,
  schema,
  schemas,
  tables,
  onClose,
  run,
  onDone,
}: {
  kind: Kind | null;
  schema: string;
  schemas: string[];
  tables: string[];
  onClose: () => void;
  run: (sql: string, limit?: number) => Promise<QueryResult>;
  onDone: (message: string, newTable?: string) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const execute = async (sql: string, message: string, newTable?: string) => {
    setBusy(true);
    setError("");
    try {
      await run(sql, 1);
      onDone(message, newTable);
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const common = { error, busy, execute, schema, schemas, tables, onClose };

  return (
    <>
      <Modal open={kind === "schema"} onClose={onClose} title="Create schema">
        <SchemaForm {...common} />
      </Modal>
      <Modal open={kind === "table"} onClose={onClose} title="Create table">
        <TableForm {...common} />
      </Modal>
      <Modal open={kind === "view"} onClose={onClose} title="Create view">
        <ViewForm {...common} />
      </Modal>
      <Modal open={kind === "enum"} onClose={onClose} title="Create enum">
        <EnumForm {...common} />
      </Modal>
      <Modal open={kind === "role"} onClose={onClose} title="Create role">
        <RoleForm {...common} />
      </Modal>
      <Modal open={kind === "policy"} onClose={onClose} title="Create policy">
        <PolicyForm {...common} />
      </Modal>
      <Modal open={kind === "csv"} onClose={onClose} title="Import CSV">
        <CsvForm {...common} run={run} />
      </Modal>
    </>
  );
}

type FormProps = {
  error: string;
  busy: boolean;
  execute: (sql: string, message: string, newTable?: string) => Promise<void>;
  schema: string;
  schemas: string[];
  tables: string[];
  onClose: () => void;
};

const Actions = ({ busy, onClose, label = "Create" }: { busy: boolean; onClose: () => void; label?: string }) => (
  <div className="mt-4 flex gap-2">
    <Button type="submit" variant="accent" disabled={busy}>
      {busy ? "Working…" : label}
    </Button>
    <Button onClick={onClose}>Cancel</Button>
  </div>
);

function SchemaForm({ error, busy, execute, onClose }: FormProps) {
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        execute(`create schema ${ident(name)}`, `Schema ${name} created`);
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <TextField label="Name" value={name} onChange={setName} placeholder="reporting" autoFocus mono />
      <Actions busy={busy} onClose={onClose} />
    </form>
  );
}

function TableForm({ error, busy, execute, schema, schemas, onClose }: FormProps) {
  const [target, setTarget] = useState(schema);
  const [name, setName] = useState("");
  const [cols, setCols] = useState<Col[]>([
    { name: "id", type: "bigserial", notNull: true, pk: true, default: "" },
    { name: "name", type: "text", notNull: false, pk: false, default: "" },
  ]);

  const set = (i: number, patch: Partial<Col>) =>
    setCols((c) => c.map((x, j) => (i === j ? { ...x, ...patch } : x)));

  const sql = () => {
    const defs = cols
      .filter((c) => c.name.trim())
      .map((c) => {
        const bits = [ident(c.name), c.type];
        if (c.notNull) bits.push("not null");
        if (c.default.trim()) bits.push(`default ${c.default}`);
        return "  " + bits.join(" ");
      });
    const pks = cols.filter((c) => c.pk && c.name.trim()).map((c) => ident(c.name));
    if (pks.length) defs.push(`  primary key (${pks.join(", ")})`);
    return `create table ${ident(target)}.${ident(name)} (\n${defs.join(",\n")}\n)`;
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        execute(sql(), `Table ${name} created`, name);
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="mb-3 flex gap-2">
        <div className="w-36">
          <div className="mb-1.5 text-[12px] text-dim">Schema</div>
          <Select value={target} onChange={setTarget} options={schemas} />
        </div>
        <div className="flex-1">
          <TextField label="Name" value={name} onChange={setName} placeholder="orders" autoFocus mono />
        </div>
      </div>

      <div className="mb-1.5 text-[12px] text-dim">Columns</div>
      <div className="max-h-[38vh] space-y-1.5 overflow-y-auto pr-1">
        {cols.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={c.name}
              onChange={(e) => set(i, { name: e.target.value })}
              placeholder="column"
              className="w-28 rounded-md border border-line bg-base px-2 py-1.5 font-mono text-[12px] focus:border-edge focus:outline-none"
            />
            <div className="w-36">
              <Select value={c.type} onChange={(t) => set(i, { type: t })} options={TYPES} />
            </div>
            <input
              value={c.default}
              onChange={(e) => set(i, { default: e.target.value })}
              placeholder="default"
              className="w-24 rounded-md border border-line bg-base px-2 py-1.5 font-mono text-[12px] focus:border-edge focus:outline-none"
            />
            <label className="flex items-center gap-1 text-[11px] text-dim" title="Not null">
              <input type="checkbox" checked={c.notNull} onChange={(e) => set(i, { notNull: e.target.checked })} />
              nn
            </label>
            <label className="flex items-center gap-1 text-[11px] text-dim" title="Primary key">
              <input type="checkbox" checked={c.pk} onChange={(e) => set(i, { pk: e.target.checked })} />
              pk
            </label>
            <button
              type="button"
              onClick={() => setCols((x) => x.filter((_, j) => j !== i))}
              className="px-1 text-faint hover:text-rose"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setCols((c) => [...c, { name: "", type: "text", notNull: false, pk: false, default: "" }])}
        className="mt-2 text-[12px] text-dim hover:text-text"
      >
        + add column
      </button>

      <pre className="mt-3 max-h-28 overflow-auto rounded-md border border-line bg-base p-2.5 font-mono text-[11px] text-faint">
        {sql()}
      </pre>
      <Actions busy={busy} onClose={onClose} />
    </form>
  );
}

function ViewForm({ error, busy, execute, schema, schemas, onClose }: FormProps) {
  const [target, setTarget] = useState(schema);
  const [name, setName] = useState("");
  const [body, setBody] = useState("select * from ");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        execute(`create view ${ident(target)}.${ident(name)} as ${body}`, `View ${name} created`);
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="mb-3 flex gap-2">
        <div className="w-36">
          <div className="mb-1.5 text-[12px] text-dim">Schema</div>
          <Select value={target} onChange={setTarget} options={schemas} />
        </div>
        <div className="flex-1">
          <TextField label="Name" value={name} onChange={setName} placeholder="active_customers" autoFocus mono />
        </div>
      </div>
      <div className="mb-1.5 text-[12px] text-dim">Query</div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        spellCheck={false}
        className="w-full rounded-md border border-line bg-base p-2.5 font-mono text-[12px] text-text focus:border-edge focus:outline-none"
      />
      <Actions busy={busy} onClose={onClose} />
    </form>
  );
}

function EnumForm({ error, busy, execute, schema, schemas, onClose }: FormProps) {
  const [target, setTarget] = useState(schema);
  const [name, setName] = useState("");
  const [values, setValues] = useState("draft\nsent\npaid");
  const list = values.split("\n").map((v) => v.trim()).filter(Boolean);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        execute(
          `create type ${ident(target)}.${ident(name)} as enum (${list.map(literal).join(", ")})`,
          `Enum ${name} created`,
        );
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="mb-3 flex gap-2">
        <div className="w-36">
          <div className="mb-1.5 text-[12px] text-dim">Schema</div>
          <Select value={target} onChange={setTarget} options={schemas} />
        </div>
        <div className="flex-1">
          <TextField label="Name" value={name} onChange={setName} placeholder="invoice_status" autoFocus mono />
        </div>
      </div>
      <div className="mb-1.5 text-[12px] text-dim">Values, one per line</div>
      <textarea
        value={values}
        onChange={(e) => setValues(e.target.value)}
        rows={5}
        spellCheck={false}
        className="w-full rounded-md border border-line bg-base p-2.5 font-mono text-[12px] text-text focus:border-edge focus:outline-none"
      />
      <Actions busy={busy} onClose={onClose} />
    </form>
  );
}

function RoleForm({ error, busy, execute, onClose }: FormProps) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [login, setLogin] = useState(true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const bits = [ident(name)];
        if (login) bits.push("login");
        if (password) bits.push(`password ${literal(password)}`);
        execute(`create role ${bits.join(" ")}`, `Role ${name} created`);
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <TextField label="Name" value={name} onChange={setName} placeholder="reporting" autoFocus mono />
      <TextField label="Password" value={password} onChange={setPassword} type="password" placeholder="optional" />
      <label className="mb-1 flex items-center gap-2 text-[13px] text-dim">
        <input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} />
        Can log in
      </label>
      <p className="mt-2 text-xs text-faint">
        Creating roles needs the CREATEROLE privilege. If your role does not have it, Postgres will say so.
      </p>
      <Actions busy={busy} onClose={onClose} />
    </form>
  );
}

function PolicyForm({ error, busy, execute, schema, tables, onClose }: FormProps) {
  const [table, setTable] = useState(tables[0] ?? "");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("ALL");
  const [using, setUsing] = useState("true");
  const [enable, setEnable] = useState(true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const policy = `create policy ${ident(name)} on ${ident(schema)}.${ident(table)} for ${command} using (${using})`;
        const sql = enable
          ? `alter table ${ident(schema)}.${ident(table)} enable row level security; ${policy}`
          : policy;
        execute(sql, `Policy ${name} created`);
      }}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      {tables.length === 0 ? (
        <p className="text-[13px] text-dim">Create a table first.</p>
      ) : (
        <>
          <div className="mb-3">
            <div className="mb-1.5 text-[12px] text-dim">Table</div>
            <Select value={table} onChange={setTable} options={tables} />
          </div>
          <TextField label="Policy name" value={name} onChange={setName} placeholder="own_rows" autoFocus mono />
          <div className="mb-3">
            <div className="mb-1.5 text-[12px] text-dim">Command</div>
            <Select value={command} onChange={setCommand} options={["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"]} />
          </div>
          <div className="mb-1.5 text-[12px] text-dim">USING expression</div>
          <input
            value={using}
            onChange={(e) => setUsing(e.target.value)}
            className="w-full rounded-md border border-line bg-base px-2.5 py-2 font-mono text-[12px] focus:border-edge focus:outline-none"
          />
          <label className="mt-3 flex items-center gap-2 text-[13px] text-dim">
            <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
            Enable row level security on the table
          </label>
        </>
      )}
      <Actions busy={busy} onClose={onClose} />
    </form>
  );
}

// ---------------------------------------------------------------- csv

/** Minimal RFC-4180 parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ""));
}

const MAX_ROWS = 5000;
const BATCH = 200;

function CsvForm({
  error,
  busy,
  schema,
  tables,
  onClose,
  run,
  execute,
}: FormProps & { run: (sql: string, limit?: number) => Promise<QueryResult> }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [target, setTarget] = useState("__new__");
  const [newName, setNewName] = useState("");
  const [localError, setLocalError] = useState("");
  const [progress, setProgress] = useState("");
  const [working, setWorking] = useState(false);

  const header = rows?.[0] ?? [];
  const body = rows?.slice(1) ?? [];

  const load = async (file: File) => {
    setFileName(file.name);
    setLocalError("");
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setLocalError("That file has no data rows.");
    if (parsed.length - 1 > MAX_ROWS) {
      setLocalError(`${parsed.length - 1} rows is more than this importer handles (${MAX_ROWS}). Use \\copy instead.`);
      return;
    }
    setRows(parsed);
    setNewName(file.name.replace(/\.csv$/i, "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase());
  };

  const importRows = async () => {
    if (!rows) return;
    setWorking(true);
    setLocalError("");
    const table = target === "__new__" ? newName : target;
    try {
      if (target === "__new__") {
        // Everything lands as text: guessing types from a sample is how
        // importers corrupt data. Change the types afterwards if you want.
        const defs = header.map((h) => `  ${ident(h || "column")} text`).join(",\n");
        await run(`create table ${ident(schema)}.${ident(table)} (\n${defs}\n)`, 1);
      }
      const cols = header.map((h) => ident(h || "column")).join(", ");
      for (let i = 0; i < body.length; i += BATCH) {
        const slice = body.slice(i, i + BATCH);
        const values = slice
          .map((r) => `(${header.map((_, j) => (r[j] === undefined || r[j] === "" ? "null" : literal(r[j]!))).join(", ")})`)
          .join(", ");
        await run(`insert into ${ident(schema)}.${ident(table)} (${cols}) values ${values}`, 1);
        setProgress(`${Math.min(i + BATCH, body.length)} of ${body.length} rows`);
      }
      await execute("select 1", `Imported ${body.length} rows into ${table}`, table);
    } catch (e) {
      setLocalError(String((e as Error).message ?? e));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div>
      {(error || localError) && <ErrorNote>{error || localError}</ErrorNote>}
      <label
        className={cx(
          "mb-3 flex cursor-pointer items-center justify-center rounded-md border border-dashed border-line",
          "bg-base px-3 py-6 text-[13px] text-dim hover:border-edge",
        )}
      >
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && load(e.target.files[0])}
        />
        {fileName || "Choose a CSV file"}
      </label>

      {rows && (
        <>
          <div className="mb-3 text-[12px] text-dim">
            {header.length} columns, {body.length} rows
          </div>
          <div className="mb-3 max-h-32 overflow-auto rounded-md border border-line">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-line">
                  {header.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-normal text-text">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 3).map((r, i) => (
                  <tr key={i} className="border-b border-line-soft last:border-0">
                    {r.map((v, j) => (
                      <td key={j} className="max-w-32 truncate px-2 py-1 font-mono text-faint">
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mb-1.5 text-[12px] text-dim">Destination</div>
          <Select
            value={target}
            onChange={setTarget}
            options={["__new__", ...tables]}
          />
          {target === "__new__" && (
            <div className="mt-2">
              <TextField label="New table name" value={newName} onChange={setNewName} mono />
              <p className="-mt-1 text-xs text-faint">Columns are created as text.</p>
            </div>
          )}
          {progress && <div className="mt-2 text-[12px] text-dim">{progress}</div>}
        </>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="accent" disabled={!rows || working || busy} onClick={importRows}>
          {working ? "Importing…" : "Import"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
