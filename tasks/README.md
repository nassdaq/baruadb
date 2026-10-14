# Barua Tasks

Durable background work for any application. Give an app a reliable way to run
work after the request ends — send the email, process the upload, retry the
webhook, run the nightly report — without running a queue, workers, a
scheduler or a retry system of its own.

```js
await tasks.create({ name: "send-welcome-email", payload: { userId: "user_123" } });
```

Behind that one call, Barua stores the task durably, delivers it to your app,
retries with backoff when your app fails, runs schedules, and keeps every
attempt and every error where you — or the AI that wrote your handler — can
read it and put the task back.

It works with an application on any host. Barua does not run your code; it
runs the part nobody wants to build twice.

## How it works

Each project is one Durable Object. It holds the project's tasks in its own
SQLite storage and runs them with its alarm — the object *is* the queue, the
scheduler and the retry engine, single-threaded and durable, and it costs
nothing while there is nothing to run.

A task is delivered by `POST`ing it to your handler URL.

| Your handler answers | Barua does |
|---|---|
| `2xx` | marks the task **done**; the body (≤ 4 KB) is kept as its result |
| `5xx`, `408`, `429`, a timeout, or no connection | **retries** with backoff: ~10 s, 20 s, 40 s … capped at an hour, with jitter |
| any other `4xx` | fails it **for good** — a handler that says "bad request" will say it again |
| out of attempts | the task goes to the **dead-letter** with its last error |

Delivery is **at least once**. Make handlers idempotent, or pass an
`idempotency_key` when creating a task so a retry on *your* side never
creates a second one.

A **cron** task never dies: a failed occurrence is recorded and the next one
is booked.

## The handler contract

Barua `POST`s JSON to your handler:

```json
{ "id": "tsk_…", "name": "send-welcome-email", "payload": { "userId": "user_123" },
  "attempt": 1, "max_attempts": 5, "scheduled_at": "2026-10-14T08:00:00.000Z" }
```

with headers `x-barua-task-id`, `x-barua-task-name`, `x-barua-attempt` and
`x-barua-signature` — an HMAC-SHA256 of the raw body, hex, keyed with your
project key. Verify it; nothing else can forge a delivery. You have 30 seconds.

## The SDK

Full integration docs — quickstart, every framework, API reference:
**https://barua.app/docs/tasks**

`sdk/index.mjs` — web-standard (`fetch` + WebCrypto), no dependencies; the
same file runs in Node 18+, Workers, Deno, Bun and browsers. Get it any of
three ways:

```
npm install barua-tasks                                        # the package
curl -O https://barua-tasks.kelvineffect.workers.dev/sdk.mjs    # one file, vendor it
import { … } from "https://barua-tasks.kelvineffect.workers.dev/sdk.mjs"   # Deno, browsers
```

```js
import { createTasks, handler } from "./sdk/index.mjs";

// Sending work
const tasks = createTasks({ key: process.env.BARUA_TASKS_KEY });
await tasks.create({ name: "send-welcome-email", payload: { userId: "user_123" } });
await tasks.create({ name: "remind", payload: { id: 7 }, delay: 3600 });           // in an hour
await tasks.create({ name: "nightly-report", cron: "0 2 * * *" });                 // every night, UTC
await tasks.create({ name: "charge", payload: { order: 9 }, idempotency_key: "order-9" });

// Reading back
await tasks.failed();        // the dead-letter
await tasks.get(id);         // one task with every attempt
await tasks.retry(id);       // back in the queue, now
await tasks.stats();

// Receiving work: your function as a fetch handler (Workers, Next.js route
// handlers, Hono, Deno, Bun). Return to finish; throw to retry; throw with
// { status: 400 } to fail for good.
export default {
  fetch: handler(process.env.BARUA_TASKS_KEY, async (task) => {
    if (task.name === "send-welcome-email") return sendEmail(task.payload.userId);
    throw Object.assign(new Error(`no handler for ${task.name}`), { status: 400 });
  }),
};
```

`verify({ key, body, signature })` is exported for frameworks where you handle
the request yourself.

## The API

Base URL `https://barua-tasks.kelvineffect.workers.dev`, header
`Authorization: Bearer tk_…` (your project key).

| | |
|---|---|
| `POST /tasks` | `{ name, payload?, delay?, run_at?, cron?, max_attempts?, idempotency_key?, url? }` → `201` the task; `200` + `deduplicated: true` on an idempotency hit |
| `GET /tasks?status=&name=&limit=` | newest first; `status` is `pending` `running` `done` `dead` `cancelled` |
| `GET /tasks/:id` | the task with every run: attempt, timing, HTTP status, error |
| `POST /tasks/:id/retry` | a dead, done or cancelled task, back in the queue now |
| `DELETE /tasks/:id` | cancel a pending task |
| `GET /stats` | counts by status, handler URL, next due |
| `POST /handler` | `{ handler_url }` — change where tasks are delivered |
| `POST /mcp` | the queue as tools (below) |
| `POST /projects` | operator only (`TASKS_ADMIN_TOKEN`): `{ handler_url }` → `{ project_key }` |

`delay` is seconds (up to 30 days); `run_at` an ISO timestamp; `cron` five
fields in UTC (`*`, lists, ranges, steps; Sunday is 0 or 7); `url` delivers
this one task somewhere other than the project's handler.

## For the agent: MCP

The same queue as tools, so the assistant that wrote a handler can see its
tasks fail, read why, fix the code and put them back — without a human
reading a dashboard in between.

Tools: `failed_tasks`, `get_task`, `list_tasks`, `retry_task`, `create_task`,
`cancel_task`, `queue_stats`.

```
claude mcp add --transport http barua-tasks \
  https://barua-tasks.kelvineffect.workers.dev/mcp \
  --header "Authorization: Bearer tk_…"
```

## Limits, stated plainly

- payload ≤ 64 KB; results kept to 4 KB, errors to 2 KB
- `max_attempts` 1–25, default 5
- a task can be scheduled at most 30 days out
- 10 deliveries in flight per project at a time; 30 s per delivery
- finished tasks and their runs are kept 7 days
- at-least-once delivery

## Running it

```
npm install
npm test                       # the cron parser
npx wrangler deploy
npx wrangler secret put TASKS_ADMIN_TOKEN
```

`demo/` is a small application that receives tasks, deployed on its own so it
stands in for any app on any host. Its first version has the kind of bug an
assistant plausibly writes; the dead-letter, read over MCP, says exactly what.
