// Small time-series charts, drawn as SVG. A charting library would be larger
// than the rest of this application put together, and these only ever draw a
// handful of series over one axis of time.
import { useMemo, useState } from "react";
import { cx } from "./components";

export type Series = { label: string; color: string; points: (number | null)[] };

const PAD = { l: 44, r: 10, t: 10, b: 20 };
const H = 150;

export function Chart({
  title,
  unit,
  times,
  series,
  stacked,
  format = (v) => String(Math.round(v * 100) / 100),
  max: forcedMax,
}: {
  title: string;
  unit?: string;
  times: number[];
  series: Series[];
  stacked?: boolean;
  format?: (v: number) => string;
  max?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 560;

  const { max, paths, areas } = useMemo(() => {
    const totals = times.map((_, i) =>
      stacked
        ? series.reduce((sum, s) => sum + (s.points[i] ?? 0), 0)
        : Math.max(...series.map((s) => s.points[i] ?? 0)),
    );
    const max = Math.max(forcedMax ?? 0, ...totals, 1);
    const x = (i: number) => PAD.l + (i / Math.max(times.length - 1, 1)) * (width - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);

    const running = times.map(() => 0);
    const paths: string[] = [];
    const areas: string[] = [];
    for (const s of series) {
      let d = "";
      let area = "";
      times.forEach((_, i) => {
        const base = stacked ? running[i]! : 0;
        const v = (s.points[i] ?? 0) + base;
        if (stacked) running[i] = v;
        d += `${i === 0 ? "M" : "L"}${x(i)},${y(v)} `;
      });
      area =
        d +
        `L${x(times.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
      paths.push(d);
      areas.push(area);
    }
    return { max, paths, areas };
  }, [times, series, stacked, forcedMax]);

  const x = (i: number) => PAD.l + (i / Math.max(times.length - 1, 1)) * (width - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, max / 2, max];

  const label = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-[13px] font-medium">{title}</h3>
        {unit && <span className="text-[11px] uppercase tracking-wide text-faint">{unit}</span>}
        <div className="ml-auto flex flex-wrap gap-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {times.length === 0 ? (
        <div className="grid h-[150px] place-items-center text-[12px] text-faint">
          No samples yet. They arrive about once a minute.
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${H}`}
          className="w-full"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const rel = ((e.clientX - box.left) / box.width) * width;
            const i = Math.round(((rel - PAD.l) / (width - PAD.l - PAD.r)) * (times.length - 1));
            setHover(i >= 0 && i < times.length ? i : null);
          }}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="#1f1f23" strokeWidth="1" />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-[#6a6a73] text-[9px]">
                {format(t)}
              </text>
            </g>
          ))}
          {series.map((s, i) => (
            <g key={s.label}>
              <path d={areas[i]} fill={s.color} opacity={0.14} />
              <path d={paths[i]} fill="none" stroke={s.color} strokeWidth="1.5" />
            </g>
          ))}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="#34343a" strokeWidth="1" />
          )}
          <text x={PAD.l} y={H - 5} className="fill-[#6a6a73] text-[9px]">
            {label(times[0]!)}
          </text>
          <text x={width - PAD.r} y={H - 5} textAnchor="end" className="fill-[#6a6a73] text-[9px]">
            {label(times[times.length - 1]!)}
          </text>
        </svg>
      )}

      {hover !== null && times[hover] && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 border-t border-line-soft pt-2 text-[11px]">
          <span className="text-faint">{new Date(times[hover]!).toLocaleTimeString()}</span>
          {series.map((s) => (
            <span key={s.label} className="text-dim">
              <span className="mr-1 inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
              {format(s.points[hover] ?? 0)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Buttons for the time window, as on every console. */
export function RangePicker({ hours, onChange }: { hours: number; onChange: (h: number) => void }) {
  const options: [string, number][] = [
    ["Last hour", 1],
    ["Last 6 hours", 6],
    ["Last day", 24],
    ["Last week", 168],
  ];
  return (
    <div className="flex overflow-hidden rounded-md border border-line">
      {options.map(([label, h]) => (
        <button
          key={h}
          onClick={() => onChange(h)}
          className={cx(
            "px-2.5 py-1 text-[12px]",
            hours === h ? "bg-raise text-text" : "text-dim hover:bg-raise/60",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
