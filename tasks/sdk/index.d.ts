// Types for @barua/tasks. The runtime is index.mjs; this file only describes it.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type TaskStatus = "pending" | "running" | "done" | "dead" | "cancelled";

/** What you pass to tasks.create(). Only `name` is required. */
export interface CreateTask {
  /** Letters, digits, `_ . : -`; up to 100 characters. Your handler switches on it. */
  name: string;
  /** Any JSON, up to 64 KB. Delivered to your handler as `task.payload`. */
  payload?: Json;
  /** Deliver this one task somewhere other than the project's handler. */
  url?: string;
  /** Run in this many seconds (up to 30 days). */
  delay?: number;
  /** Run at this ISO timestamp (up to 30 days out). */
  run_at?: string;
  /** Five-field cron, UTC. The task runs on every match and never dies. */
  cron?: string;
  /** 1–25, default 5. */
  max_attempts?: number;
  /** Creating again with the same key returns the first task instead of a second. */
  idempotency_key?: string;
}

export interface Task {
  id: string;
  name: string;
  payload: Json;
  url: string | null;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string | null;
  cron: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** The last delivery's error, when there was one. */
  last_error: string | null;
  /** The body your handler answered with on success (up to 4 KB). */
  result: string | null;
  /** Set when an idempotency_key matched an existing task. */
  deduplicated?: boolean;
}

/** One delivery attempt. */
export interface Run {
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  status: "ok" | "retry" | "dead" | string;
  http_status: number | null;
  error: string | null;
  ms: number | null;
}

export interface Stats {
  handler_url: string;
  tasks: { pending: number; running: number; done: number; dead: number; cancelled: number };
  next_due: string | null;
  alarm: string | null;
}

/** What your handler receives, parsed from the delivery body. */
export interface Delivery {
  id: string;
  name: string;
  payload: Json;
  attempt: number;
  max_attempts: number;
  scheduled_at: string;
}

export interface Tasks {
  create(task: CreateTask): Promise<Task>;
  get(id: string): Promise<Task & { runs: Run[] }>;
  list(q?: { status?: TaskStatus; name?: string; limit?: number }): Promise<Task[]>;
  /** The dead-letter: tasks that ran out of attempts or failed for good. */
  failed(limit?: number): Promise<Task[]>;
  /** Back in the queue, to run now. */
  retry(id: string): Promise<Task>;
  cancel(id: string): Promise<Task>;
  stats(): Promise<Stats>;
  setHandler(handler_url: string): Promise<{ handler_url: string }>;
}

export function createTasks(options: { key: string; url?: string }): Tasks;

/** True when `signature` (the x-barua-signature header) is the HMAC-SHA256 of `body` under your key. */
export function verify(input: { key: string; body: string; signature: string }): Promise<boolean>;

/**
 * Your task function as a `(Request) => Response` handler, for Workers,
 * Next.js route handlers, Hono, Deno and Bun. Return a value (or nothing) to
 * finish the task; throw to have it retried; throw an error with
 * `status: 400` to fail it for good.
 */
export function handler(
  key: string,
  fn: (task: Delivery) => Promise<Json | void> | Json | void,
): (request: Request) => Promise<Response>;
