// Five-field cron, in UTC: minute hour day-of-month month day-of-week.
// Understands *, numbers, ranges (a-b), steps (*/n, a-b/n) and lists
// (a,b,c); Sunday is 0 or 7. One cron quirk is honoured on purpose: when
// both day-of-month and day-of-week are restricted, a day matches if
// either does - that is what every cron since Vixie has meant by it.

interface Field {
  any: boolean;
  set: Set<number>;
}

function field(spec: string, min: number, max: number): Field {
  if (spec === "*") return { any: true, set: new Set() };
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(Number) as [number, number];
    else {
      lo = Number(range);
      hi = stepText === undefined ? lo : max;
    }
    if (![lo, hi, step].every(Number.isInteger) || step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid: cron field "${spec}"`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { any: false, set };
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("invalid: cron needs five fields - minute hour day month weekday");
  const dow = field(parts[4], 0, 7);
  if (dow.set.has(7)) {
    dow.set.delete(7);
    dow.set.add(0);
  }
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    dom: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12),
    dow,
  };
}

/** The first moment strictly after `from` that matches, as epoch ms (UTC). */
export function nextRun(expr: string, from: number): number {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  // Whole months, days and hours are skipped at a time, so even a date that
  // comes once a year is found in a few thousand steps.
  for (let i = 0; i < 100_000; i++) {
    if (!c.month.any && !c.month.set.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domOk = c.dom.any || c.dom.set.has(d.getUTCDate());
    const dowOk = c.dow.any || c.dow.set.has(d.getUTCDay());
    const dayOk = c.dom.any && c.dow.any ? true : c.dom.any ? dowOk : c.dow.any ? domOk : domOk || dowOk;
    if (!dayOk) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.any && !c.hour.set.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.any && !c.minute.set.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  throw new Error("invalid: cron never matches in the next few years");
}
