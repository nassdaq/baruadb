import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, parseCron } from "../src/cron.ts";

const at = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();

test("every five minutes", () => {
  assert.equal(iso(nextRun("*/5 * * * *", at("2026-10-14T12:03:00Z"))), "2026-10-14T12:05:00.000Z");
  assert.equal(iso(nextRun("*/5 * * * *", at("2026-10-14T12:05:00Z"))), "2026-10-14T12:10:00.000Z", "strictly after");
});
test("weekdays at nine", () => {
  // 2026-10-17 is a Saturday
  assert.equal(iso(nextRun("0 9 * * 1-5", at("2026-10-17T10:00:00Z"))), "2026-10-19T09:00:00.000Z");
});
test("first of the month, hour rolls over a year end", () => {
  assert.equal(iso(nextRun("30 2 1 * *", at("2026-12-20T00:00:00Z"))), "2027-01-01T02:30:00.000Z");
});
test("sunday as 0 and 7", () => {
  assert.equal(nextRun("0 0 * * 0", at("2026-10-14T00:00:00Z")), nextRun("0 0 * * 7", at("2026-10-14T00:00:00Z")));
});
test("dom OR dow when both restricted", () => {
  // 13th or any Friday: from Wed 14 Oct 2026, the next is Fri 16 Oct
  assert.equal(iso(nextRun("0 0 13 * 5", at("2026-10-14T01:00:00Z"))), "2026-10-16T00:00:00.000Z");
});
test("ranges, lists and steps", () => {
  const c = parseCron("0,30 9-17/4 * 1,6 *");
  assert.deepEqual([...c.minute.set], [0, 30]);
  assert.deepEqual([...c.hour.set], [9, 13, 17]);
  assert.deepEqual([...c.month.set], [1, 6]);
});
test("garbage is refused", () => {
  assert.throws(() => parseCron("60 * * * *"), /invalid/);
  assert.throws(() => parseCron("* * * *"), /five fields/);
  assert.throws(() => parseCron("*/0 * * * *"), /invalid/);
});
