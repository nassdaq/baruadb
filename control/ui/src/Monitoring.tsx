import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useCallback, useEffect, useState } from "react";
import { api, type Database, type MetricSample, type QueryResult } from "./api";
import { Chart, RangePicker, type Series } from "./Chart";
import { ago, Badge, Button, Card, cx, Dot, Empty, ErrorNote, Stat } from "./components";
import { DataGrid } from "./Grid";
import { PageHead } from "./Shell";

const C = { live: "#00e599", sky: "#60a5fa", amber: "#fbbf24", rose: "#f87171", violet: "#a78bfa" };

/** Counters are cumulative. A graph wants the rate, and a restarted Postgres
 *  resets its counters, so a drop is "no data" rather than a negative rate. */
function rate(samples: MetricSample[], key: keyof MetricSample): (number | null)[] {
  return samples.map((s, i) => {
    if (i === 0) return null;
    const prev = samples[i - 1]!;
    const a = prev[key] as number | null;
    const b = s[key] as number | null;
    if (a === null || b === null || b < a) return null;
    const secs = (Date.parse(s.at) - Date.parse(prev.at)) / 1000;
    return secs > 0 ? (b - a) / secs : null;
  });
}

export function Monitoring({ db }: { db: Database }) {
  const [hours, setHours] = useState(1);
  const [samples, setSamples] = useState<MetricSample[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .metrics(db.id, hours)
      .then((r) => setSamples(r.samples))
      .catch((e) => setError(e.message));
  }, [db.id, hours]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const tabClass = ({ selected }: { selected: boolean }) =>
    cx(
      "rounded-md px-3 py-1 text-[13px] focus:outline-none",
      selected ? "bg-raise text-text" : "text-dim hover:text-text",
    );

  const s = samples ?? [];
  const times = s.map((x) => Date.parse(x.at));

  const memory: Series[] = [
    { label: "used", color: C.live, points: s.map((x) => (x.memory_bytes ?? 0) / 1048576) },
  ];
  const cpu: Series[] = [
    {
      label: "cores",
      color: C.sky,
      // cpu_usec is microseconds of CPU time; per second of wall clock that is
      // a fraction of a core.
      points: rate(s, "cpu_usec").map((v) => (v === null ? null : v / 1_000_000)),
    },
  ];
  const rows: Series[] = [
    { label: "inserted", color: C.live, points: rate(s, "tup_inserted") },
    { label: "updated", color: C.sky, points: rate(s, "tup_updated") },
    { label: "deleted", color: C.rose, points: rate(s, "tup_deleted") },
  ];
  const transactions: Series[] = [
    { label: "commits", color: C.live, points: rate(s, "xact_commit") },
    { label: "rollbacks", color: C.amber, points: rate(s, "xact_rollback") },
  ];
  const cache: Series[] = [
    {
      label: "hit rate",
      color: C.violet,
      points: s.map((x, i) => {
        if (i === 0) return null;
        const p = s[i - 1]!;
        const hit = (x.blks_hit ?? 0) - (p.blks_hit ?? 0);
        const read = (x.blks_read ?? 0) - (p.blks_read ?? 0);
        return hit + read > 0 ? (hit / (hit + read)) * 100 : null;
      }),
    },
  ];
  const connections: Series[] = [{ label: "connections", color: C.sky, points: s.map((x) => x.connections) }];
  const deadlocks: Series[] = [{ label: "deadlocks", color: C.rose, points: rate(s, "deadlocks") }];

  return (
    <div className="mx-auto max-w-[1180px] px-8 py-7">
      <PageHead
        title="Monitoring"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Dot state={db.status === "ready" ? db.state : db.status} />
            {db.name} · {db.status === "ready" ? db.state : db.status}
          </span>
        }
        actions={
          <>
            <RangePicker hours={hours} onChange={setHours} />
            <Button onClick={load}>
              <ArrowPathIcon className="size-3.5" /> Refresh
            </Button>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <TabGroup>
        <TabList className="mb-5 flex gap-1">
          <Tab className={tabClass}>Metrics</Tab>
          <Tab className={tabClass}>Active queries</Tab>
          <Tab className={tabClass}>Query performance</Tab>
          <Tab className={tabClass}>System operations</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            {samples === null ? (
              <Empty>Loading…</Empty>
            ) : (
              <>
                <div className="mb-4 grid gap-4 lg:grid-cols-[260px_1fr]">
                  <Card className="p-4">
                    <div className="mb-3 flex items-center gap-2 text-[13px]">
                      <Dot state={db.status === "ready" ? db.state : db.status} />
                      Compute
                      <Badge>{db.status === "ready" ? db.state : db.status}</Badge>
                    </div>
                    <div className="space-y-3">
                      <Stat label="Memory limit" value="512 MB" hint="Per-database cgroup limit" />
                      <Stat label="CPU limit" value="1 core" />
                      <Stat label="Scale to zero after" value="5 minutes" />
                      <Stat label="Samples" value={s.length} hint="One a minute while the box is up" />
                    </div>
                  </Card>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Chart
                      title="RAM"
                      unit="megabytes"
                      times={times}
                      series={memory}
                      max={512}
                      format={(v) => `${Math.round(v)}`}
                    />
                    <Chart title="CPU" unit="cores" times={times} series={cpu} max={1} format={(v) => v.toFixed(2)} />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Chart title="Rows" unit="per second" times={times} series={rows} format={(v) => v.toFixed(1)} />
                  <Chart
                    title="Transactions"
                    unit="per second"
                    times={times}
                    series={transactions}
                    format={(v) => v.toFixed(1)}
                  />
                  <Chart
                    title="Cache hit rate"
                    unit="percentage"
                    times={times}
                    series={cache}
                    max={100}
                    format={(v) => `${Math.round(v)}`}
                  />
                  <Chart title="Connections" unit="count" times={times} series={connections} format={(v) => String(Math.round(v))} />
                  <Chart title="Deadlocks" unit="per second" times={times} series={deadlocks} format={(v) => v.toFixed(2)} />
                </div>
              </>
            )}
          </TabPanel>

          <TabPanel>
            <ActiveQueries db={db} />
          </TabPanel>

          <TabPanel>
            <QueryPerformance db={db} />
          </TabPanel>

          <TabPanel>
            <SystemOperations db={db} samples={s} />
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </div>
  );
}

// ---------------------------------------------------------------- live tabs

function ActiveQueries({ db }: { db: Database }) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (db.state !== "awake") return;
    api
      .query(
        db.id,
        `select pid, state, application_name as app,
                round(extract(epoch from (now() - query_start))::numeric, 2) as seconds,
                wait_event_type as waiting, left(query, 200) as query
           from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
          order by query_start`,
        100,
      )
      .then(setResult)
      .catch((e) => setError(e.message));
  }, [db.id, db.state]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (db.state !== "awake") return <Empty>The database is {db.state}. Nothing is running.</Empty>;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!result) return <Empty>Loading…</Empty>;
  if (result.rows.length === 0) return <Empty>No queries running right now. Refreshes every 5 seconds.</Empty>;
  return (
    <Card className="overflow-x-auto">
      <DataGrid result={result} />
    </Card>
  );
}

function QueryPerformance({ db }: { db: Database }) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (db.state !== "awake") return;
    api
      .query(
        db.id,
        `select calls, round(total_exec_time::numeric, 1) as total_ms,
                round(mean_exec_time::numeric, 2) as mean_ms, rows,
                left(query, 160) as query
           from pg_stat_statements
          where dbid = (select oid from pg_database where datname = current_database())
          order by total_exec_time desc limit 50`,
        50,
      )
      .then(setResult)
      .catch((e) => setError(e.message));
  }, [db.id, db.state]);

  if (db.state !== "awake") return <Empty>The database is {db.state}.</Empty>;
  if (error) {
    return (
      <Card className="p-5">
        <div className="mb-2 text-[13px] font-medium">pg_stat_statements is not available</div>
        <p className="text-[13px] text-dim">
          Per-query timings come from the pg_stat_statements extension, which has to be loaded when Postgres starts.
          It is not enabled on this box yet, so there is nothing to show rather than something invented.
        </p>
        <p className="mt-2 font-mono text-[11px] text-faint">{error}</p>
      </Card>
    );
  }
  if (!result) return <Empty>Loading…</Empty>;
  return (
    <Card className="overflow-x-auto">
      <DataGrid result={result} />
    </Card>
  );
}

function SystemOperations({ db, samples }: { db: Database; samples: MetricSample[] }) {
  const [points, setPoints] = useState<{ taken_at: string; kind: string }[] | null>(null);

  useEffect(() => {
    api
      .restorePoints(db.id)
      .then((r) => setPoints(r.snapshots))
      .catch(() => setPoints([]));
  }, [db.id]);

  // Every change of running state is a wake or a sleep, which is the operation
  // history that matters on a database that scales to zero.
  const transitions: { at: string; what: string }[] = [];
  samples.forEach((s, i) => {
    if (i === 0) return;
    const before = samples[i - 1]!.running;
    if (before !== s.running) transitions.push({ at: s.at, what: s.running ? "woke" : "went to sleep" });
  });

  const events = [
    ...transitions.map((t) => ({ at: t.at, what: t.what, kind: "compute" })),
    ...(points ?? []).map((p) => ({ at: p.taken_at, what: `snapshot to R2 (${p.kind})`, kind: "storage" })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  if (events.length === 0) return <Empty>Nothing recorded in this window.</Empty>;
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-dim">
            <th className="px-4 py-2.5 font-normal">When</th>
            <th className="px-4 py-2.5 font-normal">Operation</th>
            <th className="px-4 py-2.5 font-normal">Kind</th>
          </tr>
        </thead>
        <tbody>
          {events.slice(0, 100).map((e, i) => (
            <tr key={i} className="border-b border-line-soft last:border-0">
              <td className="px-4 py-2.5 text-dim">{ago(e.at)}</td>
              <td className="px-4 py-2.5 text-text">{e.what}</td>
              <td className="px-4 py-2.5">
                <Badge>{e.kind}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
