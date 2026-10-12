import { useEffect, useState } from "react";
import { api, type AdminStats, type AdminUser, type Box, type Move } from "./api";
import { UsersIcon } from "@heroicons/react/24/outline";
import { ago, Badge, Card, Dot, Empty, EmptyState, ErrorNote, Stat } from "./components";

/** The admin plane: who has an account and how much each person uses. It
 *  stops at the door of their databases - names and counts, never contents. */
export function Admin() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminStats().then(setStats).catch((e) => setError(e.message));
    api.adminUsers().then(setUsers).catch((e) => setError(e.message));
    // Only the operator's token can list boxes; an admin user simply sees none.
    api.boxes().then(setBoxes).catch(() => setBoxes([]));
    api.adminMoves().then(setMoves).catch(() => setMoves([]));
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!stats) return <Empty>loading…</Empty>;

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-7">
      <h2 className="mb-5 text-[22px] font-semibold tracking-tight">Admin</h2>

      <Card className="mb-3.5 p-4">
        <div className="grid grid-cols-4 gap-x-10 gap-y-6 lg:grid-cols-8">
          <Stat label="Users" value={stats.users.total} />
          <Stat label="Admins" value={stats.users.admins} />
          <Stat label="Databases" value={stats.databases.total} />
          <Stat label="Light" value={stats.databases.light ?? 0} hint="Cost nothing while idle" />
          <Stat label="Awake" value={stats.databases.awake} />
          <Stat label="Archived" value={stats.databases.cold} />
          <Stat label="Failed" value={stats.databases.failed} />
          <Stat label="Connections" value={stats.databases.connections} />
        </div>
      </Card>

      {boxes && boxes.length > 0 && (
        <>
          <div className="mb-2.5 mt-6 text-[12px] text-dim">Boxes</div>
          {boxes.map((b) => {
            const used = b.mem_total_mb - b.mem_available_mb;
            const pct = b.mem_total_mb ? Math.round((used / b.mem_total_mb) * 100) : 0;
            return (
              <Card key={b.id} className="mb-3.5">
                <div className="flex items-center gap-2.5 p-4">
                  <Dot state={b.online ? "online" : "offline"} />
                  <span className="font-medium">{b.name}</span>
                  <span className="text-xs text-dim">{b.online ? "online" : "offline"}</span>
                  <span className="font-mono text-xs text-faint">
                    {b.id} · {b.public_ip}
                  </span>
                  <span className="ml-auto text-xs text-faint">seen {ago(b.last_seen)}</span>
                </div>
                <div className="flex flex-wrap gap-10 px-4 pb-4">
                  <Stat label="CPU" value={`${b.cpus} core${b.cpus === 1 ? "" : "s"}`} />
                  <Stat label="RAM" value={`${used}/${b.mem_total_mb} MB (${pct}%)`} />
                  <Stat label="Disk free" value={`${(b.disk_free_mb / 1024).toFixed(1)} GiB`} />
                  <Stat label="Databases awake" value={b.databases_awake} />
                </div>
              </Card>
            );
          })}
        </>
      )}

      <div className="mb-2.5 mt-6 text-[12px] text-dim">Users</div>
      <Card className="mb-3.5 overflow-hidden">
        {users === null ? (
          <div className="p-4 text-[13px] text-faint">…</div>
        ) : users.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No one yet">
            Accounts appear here as people sign up.
          </EmptyState>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-dim">
                <th className="px-4 py-2.5 font-normal">Person</th>
                <th className="px-4 py-2.5 font-normal">Databases</th>
                <th className="px-4 py-2.5 font-normal">Awake</th>
                <th className="px-4 py-2.5 font-normal">Connections</th>
                <th className="px-4 py-2.5 font-normal">Joined</th>
                <th className="px-4 py-2.5 font-normal">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line-soft last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="grid size-6 shrink-0 place-items-center rounded bg-accent/15 text-[11px] font-semibold text-accent">
                        {u.email[0]?.toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{u.name || u.email.split("@")[0]}</span>
                          {u.is_admin && <Badge tone="accent">Admin</Badge>}
                        </div>
                        <div className="truncate text-xs text-faint">{u.email}</div>
                        {u.linked_email && (
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-amber">
                            Same device as {u.linked_email}
                            {u.db_quota === 0 && (
                              <button
                                onClick={() =>
                                  api.adminSetQuota(u.id, 3).then(() => api.adminUsers().then(setUsers)).catch((e) => setError(e.message))
                                }
                                className="rounded border border-line px-1.5 py-px text-[11px] text-dim hover:text-text"
                              >
                                Allow 3
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-dim">
                    {u.databases} <span className="text-faint">/ {u.db_quota}</span>
                    {u.branches > 0 && <span className="ml-1.5 text-xs text-faint">({u.branches} branch{u.branches === 1 ? "" : "es"})</span>}
                  </td>
                  <td className="px-4 py-2.5 text-dim">{u.awake}</td>
                  <td className="px-4 py-2.5 text-dim">{u.connections}</td>
                  <td className="px-4 py-2.5 text-dim">{ago(u.created_at)}</td>
                  <td className="px-4 py-2.5 text-dim">{u.last_seen_at ? ago(u.last_seen_at) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {moves.length > 0 && (
        <>
          <div className="mb-2.5 mt-6 text-[12px] text-dim">Moves between engines</div>
          <Card className="mb-3.5 overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} className="border-b border-line-soft last:border-0">
                    <td className="px-4 py-2 font-mono text-xs text-faint">{m.db_id}</td>
                    <td className="px-4 py-2">
                      <Badge tone={m.ok ? "accent" : "neutral"}>{m.direction === "up" ? "to a box" : m.direction === "down" ? "to light" : "between regions"}</Badge>
                    </td>
                    <td className="px-4 py-2 text-dim">{m.reason}</td>
                    <td className="px-4 py-2 text-xs text-faint">{m.ok ? m.detail : `failed: ${m.detail}`}</td>
                    <td className="px-4 py-2 text-right text-xs text-faint">
                      {m.ms != null && `${(m.ms / 1000).toFixed(1)} s · `}
                      {ago(m.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      <div className="mb-2.5 mt-6 text-[12px] text-dim">Sign-ups</div>
      <Card className="p-4">
        {stats.signups.length === 0 ? (
          <div className="text-[13px] text-faint">No accounts yet.</div>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {stats.signups.map((s) => (
                <tr key={s.day} className="border-b border-line-soft last:border-0">
                  <td className="py-2 text-dim">{s.day}</td>
                  <td className="py-2 text-right text-text">{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
