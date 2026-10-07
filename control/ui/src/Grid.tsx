// The data grid: selection, in-place editing, sorting, and the filter bar that
// drives the WHERE clause. Kept apart from the page layout because all four of
// those things talk to each other.
import { Input, Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { ArrowsUpDownIcon, FunnelIcon, NoSymbolIcon, TrashIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import { ApiError, ident, literal, type QueryResult } from "./api";
import { Button, CheckBox, cx, Select } from "./components";

// ---------------------------------------------------------------- filters

export type Op = "=" | "≠" | ">" | "<" | "≥" | "≤" | "contains" | "starts with" | "is null" | "is not null";
export type Filter = { column: string; op: Op; value: string };

export const OPS: Op[] = ["=", "≠", ">", "<", "≥", "≤", "contains", "starts with", "is null", "is not null"];
const NO_VALUE: Op[] = ["is null", "is not null"];

/** Turn the filter chips into SQL. Values are quoted, never interpolated. */
export function whereClause(filters: Filter[]): string {
  if (filters.length === 0) return "";
  const parts = filters.map((f) => {
    const col = ident(f.column);
    switch (f.op) {
      case "is null":
        return `${col} is null`;
      case "is not null":
        return `${col} is not null`;
      case "contains":
        return `${col}::text ilike ${literal(`%${f.value}%`)}`;
      case "starts with":
        return `${col}::text ilike ${literal(`${f.value}%`)}`;
      case "≠":
        return `${col}::text <> ${literal(f.value)}`;
      case ">":
      case "<":
      case "≥":
      case "≤": {
        const sql = { ">": ">", "<": "<", "≥": ">=", "≤": "<=" }[f.op];
        // Compare as text unless both sides look numeric, which keeps this
        // working for dates and strings without guessing the column type.
        return /^-?\d+(\.\d+)?$/.test(f.value)
          ? `${col} ${sql} ${f.value}`
          : `${col}::text ${sql} ${literal(f.value)}`;
      }
      default:
        return `${col}::text = ${literal(f.value)}`;
    }
  });
  return ` where ${parts.join(" and ")}`;
}

export function FilterBar({
  columns,
  filters,
  onChange,
}: {
  columns: string[];
  filters: Filter[];
  onChange: (f: Filter[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover className="relative">
        <PopoverButton
          as={Button}
          size="sm"
          className={cx(filters.length > 0 && "border-neon/40 text-neon")}
        >
          <FunnelIcon className="size-3.5" />
          {filters.length > 0 ? `Filters · ${filters.length}` : "Filters"}
        </PopoverButton>
        <PopoverPanel
          anchor="bottom start"
          transition
          className="z-50 mt-1 w-80 rounded-lg border border-line bg-panel p-3 shadow-panel
            origin-top transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
        >
          {({ close }) => (
            <AddFilter
              columns={columns}
              onAdd={(f) => {
                onChange([...filters, f]);
                close();
              }}
            />
          )}
        </PopoverPanel>
      </Popover>

      {filters.map((f, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raise px-2 py-1 text-[11px] text-dim"
        >
          <span className="font-mono text-text">{f.column}</span>
          <span>{f.op}</span>
          {!NO_VALUE.includes(f.op) && <span className="font-mono text-text">{f.value}</span>}
          <button
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
            className="text-faint hover:text-rose"
            title="Remove"
          >
            <XMarkIcon className="size-3.5" />
          </button>
        </span>
      ))}
      {filters.length > 1 && (
        <button onClick={() => onChange([])} className="text-[11px] text-faint hover:text-text">
          clear all
        </button>
      )}
    </div>
  );
}

function AddFilter({ columns, onAdd }: { columns: string[]; onAdd: (f: Filter) => void }) {
  const [column, setColumn] = useState(columns[0] ?? "");
  const [op, setOp] = useState<Op>("=");
  const [value, setValue] = useState("");
  const needsValue = !NO_VALUE.includes(op);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (needsValue && value === "") return;
        onAdd({ column, op, value });
        setValue("");
      }}
    >
      <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">Add filter</div>
      <div className="space-y-2">
        <Select value={column} onChange={setColumn} options={columns} />
        <Select value={op} onChange={setOp} options={OPS} />
        {needsValue && (
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            className="w-full rounded-md border border-line bg-base px-2.5 py-1.5 font-mono text-[13px] text-text placeholder:text-faint data-focus:border-edge data-focus:outline-none"
          />
        )}
      </div>
      <Button type="submit" variant="accent" size="sm" className="mt-3 w-full justify-center">
        Apply
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- grid

export type EditPlan = {
  pk: string[];
  readOnly: Set<string>;
  nullable: Set<string>;
  /** index is the row position on screen, so the grid can patch just that row. */
  save: (index: number, row: (string | null)[], column: string, value: string | null) => Promise<void>;
};

export function DataGrid({
  result,
  types,
  sort,
  onSort,
  edit,
  selection,
  onSelection,
  flush,
}: {
  result: QueryResult;
  types?: Record<string, string>;
  sort?: { col: string; dir: "asc" | "desc" } | null;
  onSort?: (col: string) => void;
  edit?: EditPlan | null;
  /** Row indexes selected on this page. Omitted when a table has no key. */
  selection?: Set<number>;
  onSelection?: (next: Set<number>) => void;
  flush?: boolean;
}) {
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setEditing(null), [result]);

  if (result.columns.length === 0) {
    return (
      <div className={cx("text-[13px] text-dim", flush && "p-4")}>
        No rows returned{result.rows_affected !== null && ` · ${result.rows_affected} affected`}.
      </div>
    );
  }

  const selectable = Boolean(selection && onSelection);
  const allOnPage = selectable && result.rows.length > 0 && selection!.size === result.rows.length;
  const toggleAll = () => onSelection!(allOnPage ? new Set() : new Set(result.rows.map((_, i) => i)));
  const toggleRow = (i: number) => {
    const next = new Set(selection);
    next.has(i) ? next.delete(i) : next.add(i);
    onSelection!(next);
  };

  const table = (
    <table className="w-full border-separate border-spacing-0">
      <thead className="sticky top-0 z-10">
        <tr>
          <th className="w-10 border-b border-r border-line bg-panel px-2 py-2 text-center">
            {selectable ? (
              <CheckBox checked={allOnPage} onChange={toggleAll} title="Select all on this page" />
            ) : null}
          </th>
          {result.columns.map((c) => (
            <th
              key={c}
              onClick={() => onSort?.(c)}
              className={cx(
                "whitespace-nowrap border-b border-r border-line bg-panel px-3 py-2 text-left text-[12px] font-normal last:border-r-0",
                onSort && "cursor-pointer hover:bg-raise",
              )}
            >
              <span className="text-text">{c}</span>
              {types?.[c] && <span className="ml-2 font-mono text-[11px] text-faint">{types[c]}</span>}
              {sort?.col === c && <span className="ml-1 text-neon">{sort.dir === "asc" ? "↑" : "↓"}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => {
          const picked = selectable && selection!.has(i);
          return (
            <tr key={i} className={cx("group", picked && "bg-neon/5")}>
              <td
                className={cx(
                  "border-b border-r border-line-soft px-2 py-1.5 text-center text-[11px] text-faint",
                  !picked && "group-hover:bg-raise/40",
                )}
              >
                {selectable ? (
                  <span className="flex items-center justify-center">
                    <span className="hidden group-hover:block">
                      <CheckBox checked={picked} onChange={() => toggleRow(i)} />
                    </span>
                    <span className={cx("block group-hover:hidden", picked && "!hidden")}>{i + 1}</span>
                    {picked && (
                      <span className="block group-hover:hidden">
                        <CheckBox checked onChange={() => toggleRow(i)} />
                      </span>
                    )}
                  </span>
                ) : (
                  i + 1
                )}
              </td>
              {row.map((cell, j) => {
                const col = result.columns[j]!;
                const writable = Boolean(edit) && !edit!.readOnly.has(col);
                const active = editing?.row === i && editing.col === col;
                return (
                  <td
                    key={j}
                    onClick={() => writable && !active && setEditing({ row: i, col })}
                    className={cx(
                      "max-w-[320px] border-b border-r border-line-soft px-3 py-1.5 font-mono text-[12px] text-dim last:border-r-0",
                      active ? "bg-raise p-0" : "truncate",
                      !picked && !active && "group-hover:bg-raise/40",
                      writable && !active && "cursor-text hover:ring-1 hover:ring-inset hover:ring-edge",
                    )}
                    title={
                      writable
                        ? (cell ?? "null")
                        : edit
                          ? `${col} is generated by the database`
                          : (cell ?? "null")
                    }
                  >
                    {active ? (
                      <CellEditor
                        initial={cell}
                        nullable={edit!.nullable.has(col)}
                        onCancel={() => setEditing(null)}
                        onSave={async (value) => {
                          setError("");
                          try {
                            await edit!.save(i, row, col, value);
                            setEditing(null);
                          } catch (e) {
                            setError(e instanceof ApiError ? e.message : String((e as Error).message ?? e));
                          }
                        }}
                      />
                    ) : cell === null ? (
                      <span className="text-faint italic">NULL</span>
                    ) : (
                      cell
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <>
      {error && (
        <div className="sticky left-0 z-20 border-b border-line bg-rose/10 px-4 py-2 text-xs text-rose/90">{error}</div>
      )}
      {table}
      {result.truncated && (
        <div className="border-t border-line px-4 py-2 text-xs text-amber">
          Showing the first {result.rows.length} rows.
        </div>
      )}
    </>
  );
}

/** One cell, open for editing. Enter saves, Escape cancels, ∅ writes NULL.
 *  Typing "NULL" is deliberately not special: a text column may hold that word. */
function CellEditor({
  initial,
  nullable,
  onSave,
  onCancel,
}: {
  initial: string | null;
  nullable: boolean;
  onSave: (value: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const done = useRef(false);

  const commit = async (v: string | null) => {
    if (done.current) return;
    done.current = true;
    if (v === initial) return onCancel();
    setBusy(true);
    await onSave(v);
    setBusy(false);
  };

  return (
    <div className="flex items-center gap-1 px-1 py-0.5">
      <Input
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(value);
          if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => commit(value)}
        className="w-full min-w-0 rounded border border-neon/60 bg-base px-1.5 py-1 font-mono text-[12px] text-text data-focus:outline-none"
      />
      {nullable && (
        <button
          onMouseDown={(e) => {
            // mousedown, not click: blur would commit the typed value first.
            e.preventDefault();
            commit(null);
          }}
          title="Set NULL"
          className="shrink-0 rounded border border-line p-1 text-faint transition hover:border-edge hover:text-text"
        >
          <NoSymbolIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- selection bar

export function SelectionBar({
  count,
  onClear,
  onDelete,
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-3 border-b border-neon/20 bg-neon/5 px-3 py-2">
      <span className="text-[13px] text-text">
        {count} {count === 1 ? "row" : "rows"} selected
      </span>
      <Button size="sm" variant="danger" onClick={onDelete}>
        <TrashIcon className="size-3.5" /> Delete
      </Button>
      <button onClick={onClear} className="text-[12px] text-dim hover:text-text">
        Clear
      </button>
    </div>
  );
}


// ---------------------------------------------------------------- sort

export type Sort = { col: string; dir: "asc" | "desc" } | null;

/** Clicking a heading still sorts; this is for picking a column you cannot
 *  see without scrolling the grid sideways. */
export function SortMenu({
  columns,
  sort,
  onChange,
}: {
  columns: string[];
  sort: Sort;
  onChange: (s: Sort) => void;
}) {
  return (
    <Popover className="relative">
      <PopoverButton as={Button} size="sm" className={cx(sort && "border-neon/40 text-neon")}>
        <ArrowsUpDownIcon className="size-3.5" />
        {sort ? `Sorted by ${sort.col}` : "Sort"}
      </PopoverButton>
      <PopoverPanel
        anchor="bottom start"
        transition
        className="z-50 mt-1 w-72 rounded-lg border border-line bg-panel p-3 shadow-panel
          origin-top transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
      >
        {({ close }) => (
          <div>
            <div className="mb-2 text-[11px] uppercase tracking-wide text-faint">Sort by</div>
            <div className="max-h-56 overflow-y-auto">
              {columns.map((c) => (
                <div key={c} className="mb-0.5 flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim">{c}</span>
                  {(["asc", "desc"] as const).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => {
                        onChange({ col: c, dir });
                        close();
                      }}
                      className={cx(
                        "rounded border px-1.5 py-0.5 text-[11px]",
                        sort?.col === c && sort.dir === dir
                          ? "border-neon/40 bg-neon/10 text-neon"
                          : "border-line text-dim hover:bg-raise hover:text-text",
                      )}
                    >
                      {dir === "asc" ? "A→Z" : "Z→A"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {sort && (
              <button
                onClick={() => {
                  onChange(null);
                  close();
                }}
                className="mt-2 text-[12px] text-faint hover:text-text"
              >
                clear sort
              </button>
            )}
          </div>
        )}
      </PopoverPanel>
    </Popover>
  );
}
