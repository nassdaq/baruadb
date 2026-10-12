// Rows as they are in D1.

export type Engine = "box" | "function";

export interface DbRow {
  id: string;
  name: string;
  owner: string;
  user_id: string | null;
  /** The box whose hostname fronts this database. On the box engine the
   *  cluster is there too; on the function engine the box only relays. */
  box_id: string;
  parent_id: string | null;
  role: string;
  dbname: string;
  status: string;
  location: string;
  running: number;
  connections: number;
  dns_record_id: string | null;
  password_enc: string | null;
  created_at: string;
  engine: Engine;
  engine_since: string | null;
  auth_verifier: string | null;
  /** Requested region; NULL = automatic placement. */
  zone: string | null;
}
