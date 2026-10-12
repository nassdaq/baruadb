// Cuts a stream of SQL (pg_dump's plain output) into chunks that end on a
// statement boundary, so a large dump can be played back piece by piece
// without ever holding all of it. It knows enough of the lexical rules to
// never cut inside a string, a quoted name, a dollar-quoted body or a
// comment; lines that are psql meta-commands (\restrict, \unrestrict) are
// dropped, since the engine is not psql.

type State = "sql" | "quote" | "escaped" | "ident" | "dollar" | "line" | "block" | "meta";

export interface Chunk {
  sql: string;
  /** Statements that end in this chunk. */
  count: number;
}

export class SqlSplitter {
  #buf = "";
  #pos = 0; // scanned this far
  #cut = 0; // end of the last complete statement
  #count = 0;
  #state: State = "sql";
  #tag = ""; // the $tag$ that closes the current dollar quote
  #lineStart = true;

  constructor(readonly target = 256 * 1024) {}

  push(text: string): Chunk[] {
    this.#buf += text;
    this.#scan();
    const out: Chunk[] = [];
    // Hand out complete statements once there are enough of them; the last
    // partial statement always stays behind.
    while (this.#cut > 0 && this.#cut >= this.target) {
      out.push(this.#take());
    }
    return out;
  }

  flush(): Chunk {
    this.#scan();
    const sql = this.#buf;
    const count = this.#count;
    this.#buf = "";
    this.#pos = this.#cut = this.#count = 0;
    return { sql, count };
  }

  #take(): Chunk {
    const sql = this.#buf.slice(0, this.#cut);
    const count = this.#count;
    this.#buf = this.#buf.slice(this.#cut);
    this.#pos -= this.#cut;
    this.#cut = 0;
    this.#count = 0;
    return { sql, count };
  }

  #scan(): void {
    const b = this.#buf;
    let i = this.#pos;
    while (i < b.length) {
      const c = b[i];
      switch (this.#state) {
        case "sql":
          if (c === "'") {
            // E'...' takes backslash escapes; a plain literal does not.
            const prev = b[i - 1];
            this.#state = (prev === "E" || prev === "e") && !/[A-Za-z0-9_]/.test(b[i - 2] ?? "") ? "escaped" : "quote";
            this.#lineStart = false;
          } else if (c === '"') {
            this.#state = "ident";
            this.#lineStart = false;
          } else if (c === "-" && b[i + 1] === "-") {
            this.#state = "line";
            i++;
          } else if (c === "/" && b[i + 1] === "*") {
            this.#state = "block";
            i++;
          } else if (c === "$") {
            const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(b.slice(i, i + 64));
            if (m) {
              this.#tag = m[0];
              this.#state = "dollar";
              i += m[0].length - 1;
            } else if (i + 64 >= b.length) {
              // A tag may be cut off here; wait for more text.
              this.#pos = i;
              return;
            }
            this.#lineStart = false;
          } else if (c === "\\" && this.#lineStart) {
            // A psql meta-command: cut the whole line out.
            const end = b.indexOf("\n", i);
            if (end < 0) {
              this.#pos = i;
              return;
            }
            this.#buf = b.slice(0, i) + b.slice(end + 1);
            return this.#scan();
          } else if (c === ";") {
            this.#count++;
            this.#cut = i + 1;
            this.#lineStart = false;
          } else if (c === "\n") {
            this.#lineStart = true;
          } else if (c !== " " && c !== "\t" && c !== "\r") {
            this.#lineStart = false;
          }
          break;
        case "quote":
          if (c === "'") {
            if (b[i + 1] === "'") i++;
            else this.#state = "sql";
          }
          break;
        case "escaped":
          if (c === "\\") i++;
          else if (c === "'") {
            if (b[i + 1] === "'") i++;
            else this.#state = "sql";
          }
          break;
        case "ident":
          if (c === '"') {
            if (b[i + 1] === '"') i++;
            else this.#state = "sql";
          }
          break;
        case "dollar":
          if (c === "$" && b.startsWith(this.#tag, i)) {
            i += this.#tag.length - 1;
            this.#state = "sql";
          }
          break;
        case "line":
          if (c === "\n") {
            this.#state = "sql";
            this.#lineStart = true;
          }
          break;
        case "block":
          if (c === "*" && b[i + 1] === "/") {
            i++;
            this.#state = "sql";
          }
          break;
        case "meta":
          break;
      }
      i++;
    }
    this.#pos = i;
  }
}
