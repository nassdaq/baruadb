# @barua/tasks

Durable background work for any application. Enqueue a task with one call;
Barua keeps it, delivers it to your app when it is due, retries with backoff
when your app fails, runs schedules, and keeps every attempt where you can
read it and put the task back.

One file, no dependencies, web-standard (`fetch` + WebCrypto): the same
module runs in Node 18+, Cloudflare Workers, Next.js, Deno, Bun and browsers.

```js
import { createTasks, handler } from "@barua/tasks";

// send work
const tasks = createTasks({ key: process.env.BARUA_TASKS_KEY });
await tasks.create({ name: "send-welcome-email", payload: { userId: "user_123" } });
await tasks.create({ name: "nightly-report", cron: "0 2 * * *" });

// receive work (Workers, Next.js route handlers, Hono, Deno, Bun)
export const POST = handler(process.env.BARUA_TASKS_KEY, async (task) => {
  if (task.name === "send-welcome-email") return sendEmail(task.payload.userId);
  throw Object.assign(new Error(`no handler for ${task.name}`), { status: 400 });
});
```

Get a key: in the Barua console, open a database → **Add-ons → Tasks → Enable**.

Full documentation: https://barua.app/docs/tasks
