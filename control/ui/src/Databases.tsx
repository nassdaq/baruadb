import { useEffect, useMemo, useState } from "react";
import { api, ApiError, BRANCHES_PER_DB, type Database, type Me } from "./api";
import {
  ago,
  Badge,
  Button,
  Card,
  Confirm,
  CopyField,
  cx,
  Dot,
  EmptyState,
  ErrorNote,
  Ask,
  Modal,
  RowMenu,
  SearchBox,
  Stat,
  TextField,
} from "./components";
import { PlusIcon } from "@heroicons/react/20/solid";
import { CircleStackIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { Mark, PageHead } from "./Shell";
import { Spinner } from "./Spinner";

const PER_PAGE = 10;

export function Databases({ me, onOpen }: { me: Me; onOpen: (id: string) => void }) {
  const [list, setList] = useState<Database[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; uri: string } | null>(null);
  const [branching, setBranching] = useState<Database | null>(null);
  const [deleting, setDeleting] = useState<Database | null>(null);

  const load = () => api.databases().then(setList).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  // A branch lives under its database: the list is primaries, each followed
  // by its branches, and a search that matches a branch keeps its parent.
  const branchesOf = (id: string) => (list ?? []).filter((d) => d.parent_id === id);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const hit = (d: Database) => (d.name + d.id).toLowerCase().includes(q);
    return (list ?? []).filter((d) => !d.parent_id && (hit(d) || branchesOf(d.id).some(hit)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const shown = filtered
    .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
    .flatMap((d) => [d, ...branchesOf(d.id)]);
  const primaries = (list ?? []).filter((d) => !d.parent_id).length;

  const awake = (list ?? []).filter((d) => d.state === "awake").length;
  const cold = (list ?? []).filter((d) => d.state === "cold").length;
  const connections = (list ?? []).reduce((n, d) => n + d.connections, 0);

  return (
    <div className="mx-auto max-w-[1180px] px-8 py-7">
      <PageHead
        title={`${me.name || me.email.split("@")[0]}'s databases`}
        actions={
          <>
            <Button variant="primary" onClick={() => setCreating(true)}>
<PlusIcon className="size-4" /> New database
            </Button>
          </>
        }
      />

      <Card className="mb-7 p-5">
        <div className="flex flex-wrap gap-8">
          <Stat label="Databases" value={list ? primaries : "—"} hint="Branches sit under their database and are not counted here" />
          <Stat label="Awake" value={awake} hint="Running right now on a box" />
          <Stat label="Cold" value={cold} hint="Archived, and restored on the next connection" />
          <Stat label="Connections" value={connections} hint="Open client connections" />
          <Stat label="Quota" value={`${list ? primaries : 0} / ${me.db_quota}`} hint={`Plus up to ${BRANCHES_PER_DB} branches on each`} />
        </div>
        <p className="mt-4 border-t border-line-soft pt-3 text-xs text-faint">
          A database sleeps after five idle minutes and wakes on the next connection. Sleeping costs nothing but storage.
        </p>
      </Card>

      <h2 className="mb-3 text-[15px] font-medium">
        {filtered.length} {filtered.length === 1 ? "Database" : "Databases"}
      </h2>
      <SearchBox value={search} onChange={(v) => (setSearch(v), setPage(0))} className="mb-3" />

      {error && <ErrorNote>{error}</ErrorNote>}
      {me.linked_to && me.db_quota === 0 && (
        <ErrorNote>
          This device already has a Barua account, so this one starts without a free allowance. Sign in with the
          other account, or write to us and we will raise the limit here.
        </ErrorNote>
      )}

      <Card className="overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-dim">
              <th className="px-4 py-2.5 font-normal">Name</th>
              <th className="px-4 py-2.5 font-normal">Region</th>
              <th className="px-4 py-2.5 font-normal">Created at</th>
              <th className="px-4 py-2.5 font-normal">State</th>
              <th className="px-4 py-2.5 font-normal">Connections</th>
              <th className="px-4 py-2.5 font-normal">Branches</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-0">
                  {list === null ? (
                    <div className="py-12 text-center text-[13px] text-faint">…</div>
                  ) : search ? (
                    <EmptyState icon={MagnifyingGlassIcon} title="Nothing matches that">
                      No database here is called “{search}”.
                    </EmptyState>
                  ) : (
                    <EmptyState
                      icon={CircleStackIcon}
                      title="No databases yet"
                      action={
                        <Button variant="accent" onClick={() => setCreating(true)}>
                          <PlusIcon className="size-4" /> Create your first database
                        </Button>
                      }
                    >
                      Postgres 16, asleep after five idle minutes, awake again on the next connection.
                    </EmptyState>
                  )}
                </td>
              </tr>
            ) : (
              shown.map((d) => (
                <tr key={d.id} className={cx("group border-b border-line-soft last:border-0 hover:bg-raise/50", d.parent_id && "bg-base/40")}>
                  <td className={cx("py-2.5", d.parent_id ? "pl-10 pr-4" : "px-4")}>
                    <button onClick={() => onOpen(d.id)} className="flex items-center gap-2 text-left">
                      {d.parent_id ? (
                        <span className="text-faint" aria-hidden="true">↳</span>
                      ) : (
                        <Mark className="size-3.5 shrink-0 text-accent" />
                      )}
                      <span className={cx("group-hover:underline", d.parent_id ? "text-dim" : "font-medium")}>{d.name}</span>
                      {d.parent_id ? <Badge>Branch</Badge> : <Badge tone="accent">Primary</Badge>}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-dim">Europe (Amsterdam)</td>
                  <td className="px-4 py-2.5 text-dim">{ago(d.created_at)}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2 text-dim">
                      <Dot state={d.status === "ready" ? d.state : d.status} />
                      {d.status === "ready" ? d.state : d.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-dim">{d.connections}</td>
                  <td className="px-4 py-2.5 text-dim">
                    {d.parent_id ? "" : <>{branchesOf(d.id).length} <span className="text-faint">/ {BRANCHES_PER_DB}</span></>}
                  </td>
                  <td className="px-2 py-2.5">
                    <RowMenu
                      items={[
                        { label: "Open", onClick: () => onOpen(d.id) },
                        { label: "Copy connection string", onClick: () => navigator.clipboard.writeText(d.connection_uri) },
                        ...(!d.parent_id && branchesOf(d.id).length < BRANCHES_PER_DB
                          ? [{ label: "Create branch", onClick: () => setBranching(d) }]
                          : []),
                        {
                          label: "Reset password",
                          onClick: () =>
                            act(async () => {
                              const r = await api.resetPassword(d.id);
                              setSecret({ title: `New password for ${d.name}`, uri: r.connection_uri });
                            }),
                        },
                        { label: "Delete", danger: true, onClick: () => setDeleting(d) },
                      ]}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-[12px] text-dim">
          <span>Items per page: {PER_PAGE}</span>
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 text-faint">
              {filtered.length === 0 ? "0" : `${page * PER_PAGE + 1} – ${Math.min(filtered.length, (page + 1) * PER_PAGE)}`} of{" "}
              {filtered.length}
            </span>
            <PageBtn onClick={() => setPage(0)} disabled={page === 0}>
              «
            </PageBtn>
            <PageBtn onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              ‹
            </PageBtn>
            <PageBtn onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>
              ›
            </PageBtn>
          </div>
        </div>
      </Card>

      <div className="mt-8 flex items-center justify-center gap-3 text-xs text-faint">
        <span>Connect with psql:</span>
        <code className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-dim">
          psql "postgresql://…@&lt;id&gt;.pg.barua.app/app?sslmode=require"
        </code>
      </div>

      <Ask
        open={branching !== null}
        onClose={() => setBranching(null)}
        title={branching ? `Branch ${branching.name}` : "Create branch"}
        label="Branch name"
        placeholder="staging"
        hint="A branch is a full copy of the data as it is right now, with its own connection string."
        onSubmit={(name) => {
          const from = branching;
          setBranching(null);
          if (from) act(() => api.branch(from.id, name));
        }}
      />

      <Confirm
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : "Delete database"}
        onConfirm={() => {
          const d = deleting;
          setDeleting(null);
          if (d) act(() => api.deleteDatabase(d.id));
        }}
      >
        The database and everything in it goes, along with every saved copy, so there will be nothing left to
        restore from. This cannot be undone.
      </Confirm>

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(uri, name) => {
          setCreating(false);
          setSecret({ title: `${name} is ready`, uri });
          load();
        }}
      />

      <Modal open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ""}>
        <p className="mb-3 text-[13px] text-dim">
          Copy this now. The password is not shown again, though you can reset it whenever you like.
        </p>
        <CopyField value={secret?.uri ?? ""} />
        <div className="mt-4 flex gap-2">
          <Button
            variant="accent"
            onClick={() => {
              navigator.clipboard.writeText(secret?.uri ?? "");
              setSecret(null);
            }}
          >
            Copy and close
          </Button>
          <Button onClick={() => setSecret(null)}>Close</Button>
        </div>
      </Modal>
    </div>
  );
}

const PageBtn = ({ children, onClick, disabled }: { children: string; onClick: () => void; disabled: boolean }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={cx(
      "rounded border border-line px-2 py-0.5",
      disabled ? "text-faint/40" : "text-dim hover:bg-raise hover:text-text",
    )}
  >
    {children}
  </button>
);

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (uri: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.createDatabase(name || "main");
      onCreated(r.connection_uri, r.database.name);
      setName("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New database">
      {error && <ErrorNote>{error}</ErrorNote>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} placeholder="shop" autoFocus />
        <div className="mb-4 rounded-md border border-line bg-base px-3 py-2.5 text-xs text-dim">
          Postgres 16 · Europe (Amsterdam) · sleeps after 5 idle minutes
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="accent" disabled={busy}>
            {busy && <Spinner size={16} noSheen />}
            {busy ? "Creating" : "Create database"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}
