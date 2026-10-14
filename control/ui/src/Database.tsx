import { Input, Textarea } from "@headlessui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, BRANCHES_PER_DB, CATALOG, ident, literal, type Addon, type Database, type QueryResult, type TaskItem, type TasksStats, type Zone } from "./api";
import { ArrowPathIcon, PlusIcon } from "@heroicons/react/20/solid";
import {
  ArrowUturnLeftIcon,
  ChartBarIcon,
  CircleStackIcon,
  CommandLineIcon,
  Squares2X2Icon,
  TableCellsIcon,
  UsersIcon,
  ArchiveBoxIcon,
  BoltIcon,
  CursorArrowRaysIcon,
} from "@heroicons/react/24/outline";
import {
  ago,
  Choice,
  EmptyState,
  Badge,
  Button,
  Card,
  Confirm,
  ConnectPanel,
  CopyField,
  cx,
  Dot,
  ErrorNote,
  Modal,
  RegionSelect,
  regionFlag,
  TableSkeleton,
  SearchBox,
  Select,
  Stat,
  TextField,
} from "./components";
import { NavGroup, NavLink, PageHead } from "./Shell";
import { DataGrid, type EditPlan, type Filter, FilterBar, SelectionBar, SortMenu, whereClause } from "./Grid";
import { CreateDialogs, CreateMenu, type Kind } from "./Create";
import { Monitoring } from "./Monitoring";
import { Spinner } from "./Spinner";

export type Section = "overview" | "branches" | "monitoring" | "tables" | "sql" | "backups" | "roles" | "addons";
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
        <NavLink
          label="Overview"
          icon={<Squares2X2Icon className="size-4" />}
          active={section === "overview"}
          onClick={() => onSection("overview")}
        />
        <NavLink
          label="Branches"
          icon={<CircleStackIcon className="size-4" />}
          active={section === "branches"}
          onClick={() => onSection("branches")}
        />
        <NavLink
          label="Monitoring"
          icon={<ChartBarIcon className="size-4" />}
          active={section === "monitoring"}
          onClick={() => onSection("monitoring")}
        />
      </NavGroup>

      <NavGroup title="Postgres database">
        <NavLink
          label="Tables"
          icon={<TableCellsIcon className="size-4" />}
          active={section === "tables"}
          onClick={() => onSection("tables")}
        />
        <NavLink
          label="SQL Editor"
          icon={<CommandLineIcon className="size-4" />}
          active={section === "sql"}
          onClick={() => onSection("sql")}
        />
        <NavLink
          label="Backup & Restore"
          icon={<ArrowUturnLeftIcon className="size-4" />}
          active={section === "backups"}
          onClick={() => onSection("backups")}
        />
        <NavLink
          label="Roles"
          icon={<UsersIcon className="size-4" />}
          active={section === "roles"}
          onClick={() => onSection("roles")}
        />
      </NavGroup>

      <NavGroup title="Add-ons">
        <NavLink
          label="Tasks"
          icon={<BoltIcon className="size-4" />}
          active={section === "addons"}
          onClick={() => onSection("addons")}
        />
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
  if (section === "monitoring") return <Monitoring db={db} />;
  if (section === "sql") return <SqlEditor db={db} />;
  return (
    <div className="mx-auto max-w-[1100px] px-8 py-7">
      {section === "overview" && <Overview db={db} reload={reload} />}
      {section === "branches" && <Branches db={db} reload={reload} onOpen={onBack} />}
      {section === "backups" && <Backups db={db} />}
      {section === "roles" && <Roles db={db} />}
      {section === "addons" && <TasksAddon db={db} />}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ db, reload }: { db: Database; reload: () => void }) {
  const [size, setSize] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [zones, setZones] = useState<Zone[]>([]);
  const [target, setTarget] = useState(db.zone ?? "auto");
  const [moving, setMoving] = useState(false);
  const [moveErr, setMoveErr] = useState("");
  useEffect(() => { if (picking) api.zones().then((r) => setZones(r.zones)).catch(() => setZones([])); }, [picking]);
  const move = async () => {
    setMoving(true); setMoveErr("");
    try { await api.setZone(db.id, target); setPicking(false); reload(); }
    catch (e) { setMoveErr(String((e as Error).message ?? e)); }
    finally { setMoving(false); }
  };

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
            {db.status === "ready" ? db.state : db.status}
            {" · "}
            <span className="inline-flex items-center gap-1">{regionFlag(db.zone)} {db.region ?? "Automatic"}</span>
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
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[12px] text-dim">Region</div>
            <div className="mt-1 flex items-center gap-2 text-[15px]">
              <span>{regionFlag(db.zone)}</span>
              {db.region ?? "Automatic"}
            </div>
          </div>
          {!db.parent_id && (
            <Button onClick={() => { setTarget(db.zone ?? "auto"); setPicking(true); }}>Change region</Button>
          )}
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <ConnectPanel db={db} />
      </Card>

      <Modal open={picking} onClose={() => setPicking(false)} title="Move to another region">
        {moveErr && <ErrorNote>{moveErr}</ErrorNote>}
        <p className="mb-3 text-[13px] text-dim">
          Your connection string stays the same. The database is copied to the new region; during the switch it
          briefly says “moving, try again”, then settles there.
        </p>
        <RegionSelect value={target} onChange={setTarget} zones={zones} />
        <div className="mt-4 flex gap-2">
          <Button variant="accent" disabled={moving || target === (db.zone ?? "auto")} onClick={move}>
            {moving ? "Moving…" : "Move"}
          </Button>
          <Button onClick={() => setPicking(false)}>Cancel</Button>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- branches

function Branches({ db, reload, onOpen }: { db: Database; reload: () => void; onOpen: () => void }) {
  const [all, setAll] = useState<Database[]>([]);
  const [error, setError] = useState("");
  const [branching, setBranching] = useState(false);
  const [earliest, setEarliest] = useState<string | null>(null);
  useEffect(() => {
    api.databases().then(setAll).catch((e) => setError(e.message));
    api.restorePoints(db.id).then((r) => setEarliest(r.earliest)).catch(() => setEarliest(null));
  }, [db.id]);

  const children = all.filter((d) => d.parent_id === db.id);
  const parent = all.find((d) => d.id === db.parent_id);

  return (
    <>
      <PageHead
        title="Branches"
        subtitle={
          db.parent_id
            ? "This is a branch. New branches come from the primary database, not from here."
            : children.length >= BRANCHES_PER_DB
              ? `Both branches are in use. Delete one to make another.`
              : `A branch is a full copy taken at a moment in time, with its own storage and connection string. Up to ${BRANCHES_PER_DB} per database.`
        }
        actions={
          !db.parent_id &&
          children.length < BRANCHES_PER_DB && (
            <Button variant="accent" onClick={() => setBranching(true)}>
              Create branch
            </Button>
          )
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

      <BranchDialog
        open={branching}
        onClose={() => setBranching(false)}
        db={db}
        earliest={earliest}
        onCreated={() => {
          setBranching(false);
          reload();
          onOpen();
        }}
      />
    </>
  );
}

/** Branch from now, or from any moment still inside the restore window. */
function BranchDialog({
  open,
  onClose,
  db,
  earliest,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  db: Database;
  earliest: string | null;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState<"now" | "time">("now");
  const [when, setWhen] = useState(() => new Date(Date.now() - 60_000).toISOString().slice(0, 16));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const tooEarly = from === "time" && earliest !== null && Date.parse(when) < Date.parse(earliest);

  return (
    <Modal open={open} onClose={onClose} title={`Branch ${db.name}`}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api.branch(db.id, name, from === "time" ? new Date(when).toISOString() : undefined);
            onCreated();
            setName("");
          } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label="Branch name" value={name} onChange={setName} placeholder="staging" autoFocus mono />
        <div className="mb-1.5 text-[12px] text-dim">Branch from</div>
        <Choice
          label="branch point"
          value={from}
          onChange={setFrom}
          className="mb-3"
          options={[
            ["now", "Now"],
            ["time", "A moment in time"],
          ] as const}
        />
        {from === "time" && (
          <>
            <Input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label="point in time"
              className="mb-2 w-full rounded-md border border-line bg-base px-2.5 py-2 font-mono text-[13px] text-text data-focus:border-edge data-focus:outline-none"
            />
            <p className={cx("mb-2 text-xs", tooEarly ? "text-rose" : "text-faint")}>
              {earliest
                ? `Earliest point you can go back to: ${new Date(earliest).toLocaleString()}`
                : "No saved copies yet, so only branching from now will work."}
            </p>
          </>
        )}
        <p className="mb-3 text-xs text-faint">
          A branch is a whole copy taken from a saved point, with its own storage and connection string. It does not share pages
          with its parent.
        </p>
        <div className="flex gap-2">
          <Button type="submit" variant="accent" disabled={busy || !name || tooEarly}>
            {busy ? "Creating…" : "Create branch"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
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
        subtitle="Every change is kept for a week. Branch from any moment inside that window to recover."
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
                <td colSpan={2} className="p-0">
                  <EmptyState icon={ArchiveBoxIcon} title="No snapshots yet">
                    A copy is saved shortly after a database is created, then whenever it has written enough since the
                    last one, and at least once a week while it is in use.
                  </EmptyState>
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

// ---------------------------------------------------------------- add-ons: tasks
// Background work, switched on inside this database. The console speaks to
// the queue through the control plane, so the add-on's key stays sealed
// unless the owner asks to see it.

const STATUS_TONE: Record<string, "accent" | "neutral"> = { done: "accent" };

/** "in 40s", "in 12 min", "in 3 h" - the other direction from ago(). */
function due(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "now";
  if (ms < 90_000) return `in ${Math.round(ms / 1000)}s`;
  if (ms < 90 * 60_000) return `in ${Math.round(ms / 60_000)} min`;
  return `in ${Math.round(ms / 3_600_000)} h`;
}

function TasksAddon({ db }: { db: Database }) {
  // undefined: still loading · null: not switched on
  const [addon, setAddon] = useState<(Addon & { stats: TasksStats | null }) | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [handler, setHandler] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [failed, setFailed] = useState<TaskItem[]>([]);
  const [recent, setRecent] = useState<TaskItem[]>([]);
  const [disabling, setDisabling] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const a = await api.tasksAddon(db.id);
      setAddon(a);
      setHandler((h) => h || a.settings.handler_url || "");
      const [f, r] = await Promise.all([api.taskList(db.id, "dead", 20), api.taskList(db.id, undefined, 15)]);
      setFailed(f);
      setRecent(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setAddon(null);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [db.id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      if (done) setNote(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (addon === undefined) {
    return (
      <>
        <PageHead title="Tasks" />
        <div className="py-12 text-center text-[13px] text-faint">…</div>
      </>
    );
  }

  if (addon === null) {
    return (
      <>
        <PageHead
          title="Tasks"
          subtitle="Background work for this database - emails, reports, webhooks - run reliably, retried when your app fails, nothing lost."
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        <Card className="mb-4 p-5">
          <p className="mb-4 max-w-[640px] text-[13px] text-dim">
            Your app enqueues a task with one call. Barua keeps it safe, delivers it to your app when it is due,
            retries with backoff if your app fails, runs schedules, and keeps every attempt where you - or the
            assistant that wrote your code - can read it and put it back.
          </p>
          <TextField
            label="Where your app receives tasks"
            value={handler}
            onChange={setHandler}
            placeholder="https://your-app.example/api/tasks"
            mono
          />
          <p className="-mt-1 mb-4 text-xs text-faint">An HTTPS address your app answers on. You can change it later.</p>
          <Button
            variant="accent"
            disabled={busy || !handler}
            onClick={() =>
              act(async () => {
                const r = await api.enableTasks(db.id, handler);
                setKey(r.key);
              })
            }
          >
            {busy ? "Enabling…" : "Enable tasks"}
          </Button>
        </Card>
      </>
    );
  }

  const s = addon.stats?.tasks;
  return (
    <>
      <PageHead
        title="Tasks"
        subtitle={s ? `${s.pending} waiting · ${s.done} done · ${s.dead} need attention` : "Background work for this database."}
        actions={
          <Button
            disabled={busy}
            onClick={() => act(() => api.taskCreate(db.id, { name: "test", payload: { hello: "barua" }, max_attempts: 2 }), "Test task sent - watch it below.")}
          >
            Send a test task
          </Button>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <p className="mb-3 text-[13px] text-accent">{note}</p>}

      {key && (
        <Card className="mb-4 p-5">
          <div className="mb-1.5 text-[12px] text-dim">Your key - save it now</div>
          <CopyField value={key} />
          <p className="mt-2 text-xs text-faint">Deliveries to your app are signed with it. You can reveal it again from here.</p>
        </Card>
      )}

      <Card className="mb-4 p-5">
        <div className="flex flex-wrap gap-8">
          <Stat label="Waiting" value={s?.pending ?? "—"} />
          <Stat label="Done" value={s?.done ?? "—"} />
          <Stat label="Need attention" value={s?.dead ?? "—"} />
          <Stat label="Next due" value={addon.stats?.next_due ? due(addon.stats.next_due) : "nothing"} />
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <TextField label="Where your app receives tasks" value={handler} onChange={setHandler} mono />
        <div className="flex items-center gap-2">
          <Button variant="accent" disabled={busy || handler === addon.settings.handler_url} onClick={() => act(() => api.updateTasks(db.id, handler), "Saved.")}>
            Save
          </Button>
          {!key && (
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await api.tasksKey(db.id);
                  setKey(r.key);
                })
              }
            >
              Reveal key
            </Button>
          )}
          <Button className="ml-auto" onClick={() => setDisabling(true)}>
            Turn off
          </Button>
        </div>
      </Card>

      <h3 className="mb-2 text-[13px] font-medium">Needs attention</h3>
      <Card className="mb-4 overflow-hidden">
        {failed.length === 0 ? (
          <div className="p-4 text-[13px] text-faint">Nothing failed. A task that runs out of attempts appears here with the reason.</div>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {failed.map((t) => (
                <tr key={t.id} className="border-b border-line-soft align-top last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{t.name}</div>
                    <div className="font-mono text-[11px] text-faint">{t.id}</div>
                  </td>
                  <td className="px-4 py-2.5 text-dim">
                    <div className="max-w-[460px] break-words font-mono text-[11px]">{t.last_error}</div>
                    <div className="mt-1 text-xs text-faint">
                      after {t.attempts} attempt{t.attempts === 1 ? "" : "s"}
                      {t.finished_at ? ` · ${ago(t.finished_at)}` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button disabled={busy} onClick={() => act(() => api.taskRetry(db.id, t.id), "Back in the queue.")}>
                      Retry
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <h3 className="mb-2 text-[13px] font-medium">Recent</h3>
      <Card className="mb-4 overflow-hidden">
        {recent.length === 0 ? (
          <div className="p-4 text-[13px] text-faint">No tasks yet. Send a test task, or enqueue one from your app.</div>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {recent.map((t) => (
                <tr key={t.id} className="border-b border-line-soft last:border-0">
                  <td className="px-4 py-2 font-medium">{t.name}</td>
                  <td className="px-4 py-2">
                    <Badge tone={STATUS_TONE[t.status] ?? "neutral"}>{t.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-dim">
                    {t.attempts} / {t.max_attempts}
                  </td>
                  <td className="px-4 py-2 text-dim">
                    {t.cron ? `every · ${t.cron}` : t.next_run_at && t.status === "pending" ? `due ${due(t.next_run_at)}` : ""}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-faint">{ago(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[12px] text-dim">From your app</span>
          <a href="https://barua.app/docs/tasks" target="_blank" rel="noreferrer" className="text-[12px] text-accent hover:underline">
            Read the docs →
          </a>
        </div>
        <pre className="overflow-auto rounded-md border border-line bg-base p-3 font-mono text-[11px] text-dim">{`// one file, no dependencies: npm install barua-tasks, or vendor sdk.mjs
import { createTasks } from "barua-tasks";
const tasks = createTasks({ key: process.env.BARUA_TASKS_KEY });

await tasks.create({ name: "send-welcome-email", payload: { userId: "user_123" } });
await tasks.create({ name: "nightly-report", cron: "0 2 * * *" });`}</pre>
      </Card>

      <Confirm
        open={disabling}
        onClose={() => setDisabling(false)}
        title="Turn off tasks?"
        onConfirm={() => {
          setDisabling(false);
          act(async () => {
            await api.disableTasks(db.id);
            setAddon(null);
            setKey(null);
          });
        }}
      >
        Your app stops being able to enqueue work here, and tasks still waiting are not delivered.
      </Confirm>
    </>
  );
}

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
      {rows && <DataGrid result={rows} />}
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
  const [filters, setFilters] = useState<Filter[]>([]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState<Kind | null>(null);
  const [notice, setNotice] = useState("");

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

  const reloadTables = useCallback(
    () =>
      run(CATALOG.tables(schema), 500)
        .then((r) => setTables(r.rows.map((x) => ({ name: x[0]!, kind: x[1]!, rows: x[2]!, size: x[3]! }))))
        .catch((e) => setError(e.message)),
    [run, schema],
  );

  const reloadSchemas = useCallback(
    () =>
      run(CATALOG.schemas, 200)
        .then((r) => {
          const names = r.rows.map((x) => x[0]!);
          if (names.length) setSchemas(names);
        })
        .catch(() => {}),
    [run],
  );

  useEffect(() => {
    setTable(null);
    setRows(null);
    reloadTables();
  }, [schema, reloadTables]);

  const loadRows = useCallback(
    async (name: string, p: number, s: typeof sort, f: Filter[] = []) => {
      setBusy(true);
      setError("");
      setSelection(new Set());
      try {
        const order = s ? ` order by ${ident(s.col)} ${s.dir === "asc" ? "asc" : "desc"}` : "";
        const data = await run(
          `select * from ${ident(schema)}.${ident(name)}${whereClause(f)}${order} limit ${PAGE} offset ${p * PAGE}`,
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
    setFilters([]);
    setView("data");
    run(CATALOG.columns(schema, name), 500).then(setColumns).catch(() => setColumns(null));
    loadRows(name, 0, null, filters);
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
          // One statement, one row back. The grid patches that row in place
          // instead of re-reading the page: editing a cell should not cost a
          // second query, nor pull 50 rows over the wire to change one value.
          save: async (index, row, column, value) => {
            const cols = rows!.columns;
            const at = (name: string) => cols.indexOf(name);
            const where = pk
              .map((k) => {
                const v = row[at(k)];
                if (v === null) throw new Error(`cannot edit a row whose ${k} is null`);
                return `${ident(k)} = ${literal(v)}`;
              })
              .join(" and ");
            const set = value === null ? "null" : literal(value);
            // RETURNING lists the same columns in the same order as the grid,
            // so triggers and computed columns show up without another read.
            const r = await run(
              `update ${ident(schema)}.${ident(table)} set ${ident(column)} = ${set} where ${where}
               returning ${cols.map(ident).join(", ")}`,
              1,
            );
            const updated = r.rows[0];
            if (!updated) throw new Error("no row matched; it may have been deleted");
            setRows((prev) =>
              prev ? { ...prev, rows: prev.rows.map((x, i) => (i === index ? updated : x)) } : prev,
            );
          },
        }
      : null;

  const deleteSelected = async () => {
    setConfirmDelete(false);
    if (!table || !rows || selection.size === 0 || pk.length === 0) return;
    const at = (name: string) => rows.columns.indexOf(name);
    const chosen = [...selection].map((i) => rows.rows[i]!);
    const where = chosen
      .map((row) => "(" + pk.map((k) => `${ident(k)} = ${literal(row[at(k)] ?? "")}`).join(" and ") + ")")
      .join(" or ");
    try {
      await run(`delete from ${ident(schema)}.${ident(table)} where ${where}`, 1);
      setRows((prev) => (prev ? { ...prev, rows: prev.rows.filter((_, i) => !selection.has(i)) } : prev));
      setSelection(new Set());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

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
          <div className="flex items-center gap-1.5">
            <SearchBox value={filter} onChange={setFilter} placeholder="Search…" className="min-w-0 flex-1" />
            <button
              onClick={() => reloadTables()}
              title="Refresh"
              className="shrink-0 rounded-md border border-line bg-panel p-1.5 text-dim transition hover:bg-raise hover:text-text"
            >
              <ArrowPathIcon className="size-4" />
            </button>
            <CreateMenu onPick={setCreating} />
          </div>
        </div>
        {notice && (
          <div className="border-b border-accent/20 bg-accent/5 px-3 py-2 text-[12px] text-accent">{notice}</div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <TableCellsIcon className="mx-auto mb-2 size-7 text-faint/60" />
              <div className="text-xs text-faint">No tables in this schema</div>
            </div>
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
                <span className={cx("text-xs", table === t.name ? "text-accent" : "text-faint")}>▦</span>
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
          <EmptyState icon={CursorArrowRaysIcon} title="No table selected">
            Pick a table on the left to browse its rows, or create one with the + button.
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <Choice
                label="view"
                value={view}
                onChange={setView}
                options={[
                  ["data", "DATA"],
                  ["structure", "STRUCTURE"],
                ] as const}
              />
              <Button size="sm" onClick={() => setAdding(true)}>
                <PlusIcon className="size-3.5" /> Add record
              </Button>
              <FilterBar
                columns={rows?.columns ?? []}
                filters={filters}
                onChange={(f) => {
                  setFilters(f);
                  setPage(0);
                  loadRows(table, 0, sort, f);
                }}
              />
              <SortMenu
                columns={rows?.columns ?? []}
                sort={sort}
                onChange={(next) => {
                  setSort(next);
                  setPage(0);
                  loadRows(table, 0, next, filters);
                }}
              />
              <Button size="sm" onClick={() => loadRows(table, page, sort, filters)} title="Refresh">
                <ArrowPathIcon className="size-3.5" />
              </Button>
              {whyReadOnly ? (
                <span className="text-[11px] text-faint" title={whyReadOnly}>
                  read only
                </span>
              ) : (
                <span className="text-[11px] text-faint">click a cell to edit</span>
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
                      loadRows(table, page - 1, sort, filters);
                    }}
                  >
                    ‹
                  </Button>
                  <Button
                    size="sm"
                    disabled={(rows?.rows.length ?? 0) < PAGE}
                    onClick={() => {
                      setPage(page + 1);
                      loadRows(table, page + 1, sort, filters);
                    }}
                  >
                    ›
                  </Button>
                </div>
              </div>
            </div>

            <SelectionBar
              count={selection.size}
              onClear={() => setSelection(new Set())}
              onDelete={() => setConfirmDelete(true)}
            />

            <Confirm
              open={confirmDelete}
              onClose={() => setConfirmDelete(false)}
              onConfirm={deleteSelected}
              title={`Delete ${selection.size} ${selection.size === 1 ? "row" : "rows"}?`}
            >
              {selection.size === 1 ? "This row is" : "These rows are"} removed from {table} straight away. This
              cannot be undone.
            </Confirm>
            <div className="min-h-0 flex-1 overflow-auto">
              {error && <div className="p-3"><ErrorNote>{error}</ErrorNote></div>}
              {busy ? (
                <TableSkeleton rows={9} cols={5} />
              ) : view === "structure" ? (
                columns && <Structure result={columns} />
              ) : (
                rows && (
                  <DataGrid
                    result={rows}
                    types={columnTypes(columns)}
                    edit={editPlan}
                    selection={editPlan ? selection : undefined}
                    onSelection={editPlan ? setSelection : undefined}
                    sort={sort}
                    onSort={(col: string) => {
                      const next: { col: string; dir: "asc" | "desc" } =
                        sort?.col === col
                          ? { col, dir: sort.dir === "asc" ? "desc" : "asc" }
                          : { col, dir: "asc" };
                      setSort(next);
                      setPage(0);
                      loadRows(table, 0, next, filters);
                    }}
                    flush
                  />
                )
              )}
            </div>
          </>
        )}
      </div>

      <CreateDialogs
        kind={creating}
        schema={schema}
        schemas={schemas}
        tables={tables.map((t) => t.name)}
        onClose={() => setCreating(null)}
        run={run}
        onDone={async (message, newTable) => {
          setNotice(message);
          setTimeout(() => setNotice(""), 4000);
          await Promise.all([reloadSchemas(), reloadTables()]);
          if (newTable) open(newTable);
        }}
      />

      {table && columns && (
        <AddRecord
          open={adding}
          onClose={() => setAdding(false)}
          columns={columns}
          onInsert={async (cols, values) => {
            const shown = rows?.columns ?? [];
            const r = await run(
              `insert into ${ident(schema)}.${ident(table)} (${cols.map(ident).join(", ")})
               values (${values.map((v) => (v === "" ? "default" : literal(v))).join(", ")})
               returning ${shown.length ? shown.map(ident).join(", ") : "*"}`,
              1,
            );
            setAdding(false);
            // Append what the database stored, defaults and triggers included.
            const created = r.rows[0];
            if (created) setRows((prev) => (prev ? { ...prev, rows: [...prev.rows, created] } : prev));
            else loadRows(table, page, sort, filters);
          }}
        />
      )}
    </div>
  );
}

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
              {c[4] === "t" && <span className="ml-2 text-[11px] text-accent">pk</span>}
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
          <Spinner
            size={16}
            noSheen
            state={busy ? "loading" : error ? "error" : result ? "success" : "idle"}
            label={busy ? "Running" : error ? "Query failed" : "Ready"}
          />
          <Button variant="accent" size="sm" onClick={run} disabled={busy}>
            {busy ? "Running" : "Run ⌘↵"}
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
          <DataGrid result={result} flush />
        ) : (
          <EmptyState icon={CommandLineIcon} title="Results appear here">
            Write a query above and press <span className="font-mono text-faint">⌘↵</span>. Statements run as your
            database role.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

