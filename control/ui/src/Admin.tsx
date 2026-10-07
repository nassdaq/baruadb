import { useEffect, useState } from "react";
import { api, type AdminStats, type Box } from "./api";
import { ago, Card, Dot, Empty, ErrorNote, Metric } from "./components";

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
    <>
      <h2 className="mb-5 text-[15px] font-medium">Admin</h2>

      <Card className="mb-3.5 p-4">
        <div className="flex flex-wrap gap-10">
          <Metric label="Users" value={stats.users.total} />
          <Metric label="Admins" value={stats.users.admins} tone="plain" />
          <Metric label="Databases" value={stats.databases.total} />
          <Metric label="Awake" value={stats.databases.awake} />
          <Metric label="Cold in R2" value={stats.databases.cold} tone="plain" />
          <Metric label="Failed" value={stats.databases.failed} tone="plain" />
          <Metric label="Connections" value={stats.databases.connections} />
        </div>
      </Card>

      {boxes && boxes.length > 0 && (
        <>
          <div className="mb-2.5 mt-6 text-[11px] uppercase tracking-[0.06em] text-mute-500">Boxes</div>
          {boxes.map((b) => {
            const used = b.mem_total_mb - b.mem_available_mb;
            const pct = b.mem_total_mb ? Math.round((used / b.mem_total_mb) * 100) : 0;
            return (
              <Card key={b.id} className="mb-3.5">
                <div className="flex items-center gap-2.5 p-4">
                  <Dot state={b.online ? "online" : "offline"} />
                  <span className="font-medium">{b.name}</span>
                  <span className="text-xs text-mute-400">{b.online ? "online" : "offline"}</span>
                  <span className="font-mono text-xs text-mute-500">
                    {b.id} · {b.public_ip}
                  </span>
                  <span className="ml-auto text-xs text-mute-500">seen {ago(b.last_seen)}</span>
                </div>
                <div className="flex flex-wrap gap-10 px-4 pb-4">
                  <Metric label="CPU" value={`${b.cpus} core${b.cpus === 1 ? "" : "s"}`} />
                  <Metric label="RAM" value={`${used}/${b.mem_total_mb} MB (${pct}%)`} />
                  <Metric label="Disk free" value={`${(b.disk_free_mb / 1024).toFixed(1)} GiB`} />
                  <Metric label="Databases awake" value={b.databases_awake} />
                </div>
              </Card>
            );
          })}
        </>
      )}

      <div className="mb-2.5 mt-6 text-[11px] uppercase tracking-[0.06em] text-mute-500">Sign-ups</div>
      <Card className="p-4">
        {stats.signups.length === 0 ? (
          <div className="text-[13px] text-mute-500">No accounts yet.</div>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {stats.signups.map((s) => (
                <tr key={s.day} className="border-b border-ink-850 last:border-0">
                  <td className="py-2 text-mute-400">{s.day}</td>
                  <td className="py-2 text-right text-paper">{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
