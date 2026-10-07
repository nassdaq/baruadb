import { useEffect, useState } from "react";
import { api, type AdminStats, type Box } from "./api";
import { ago, Card, Dot, Empty, ErrorNote, Stat } from "./components";

/** The admin plane: how much is being used, never whose. No one's databases,
 *  no one's data - just the numbers an operator needs. */
export function Admin() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminStats().then(setStats).catch((e) => setError(e.message));
    // Only the operator's token can list boxes; an admin user simply sees none.
    api.boxes().then(setBoxes).catch(() => setBoxes([]));
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!stats) return <Empty>loading…</Empty>;

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-7">
      <h2 className="mb-5 text-[22px] font-semibold tracking-tight">Admin</h2>

      <Card className="mb-3.5 p-4">
        <div className="flex flex-wrap gap-10">
          <Stat label="Users" value={stats.users.total} />
          <Stat label="Admins" value={stats.users.admins} />
          <Stat label="Databases" value={stats.databases.total} />
          <Stat label="Awake" value={stats.databases.awake} />
          <Stat label="Cold in R2" value={stats.databases.cold} />
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
