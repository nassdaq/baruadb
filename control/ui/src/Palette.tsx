import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions, Dialog, DialogPanel } from "@headlessui/react";
import { MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import type { Database } from "./api";
import { cx } from "./components";
import { Mark } from "./Shell";

type Target = { id: string; label: string; hint: string; path: string };

/** ⌘K. Jumps to a database, or to a section of the one you are in. */
export function Palette({
  open,
  onClose,
  databases,
  current,
  go,
}: {
  open: boolean;
  onClose: () => void;
  databases: Database[];
  current: Database | null;
  go: (path: string) => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const targets = useMemo<Target[]>(() => {
    const out: Target[] = databases.map((d) => ({
      id: d.id,
      label: d.name,
      hint: d.parent_id ? `branch · ${d.id}` : d.id,
      path: `/databases/${d.id}/overview`,
    }));
    if (current) {
      for (const [label, section] of [
        ["Tables", "tables"],
        ["SQL Editor", "sql"],
        ["Branches", "branches"],
        ["Monitoring", "monitoring"],
        ["Backup & Restore", "backups"],
        ["Roles", "roles"],
      ] as const) {
        out.push({
          id: `${current.id}:${section}`,
          label,
          hint: `in ${current.name}`,
          path: `/databases/${current.id}/${section}`,
        });
      }
    }
    return out;
  }, [databases, current]);

  const matches = query
    ? targets.filter((t) => (t.label + t.hint).toLowerCase().includes(query.toLowerCase()))
    : targets.slice(0, 8);

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/70" aria-hidden="true" />
      <div className="fixed inset-0 flex items-start justify-center p-4 pt-[14vh]">
        <DialogPanel className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
          <Combobox
            onChange={(t: Target | null) => {
              if (!t) return;
              go(t.path);
              onClose();
            }}
          >
            <div className="flex items-center gap-2 border-b border-line px-3.5">
              <MagnifyingGlassIcon className="size-4 shrink-0 text-faint" />
              <ComboboxInput
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search databases and pages…"
                className="w-full bg-transparent py-3 text-[14px] text-text placeholder:text-faint focus:outline-none"
              />
              <kbd className="rounded border border-line px-1.5 py-px font-mono text-[11px] text-faint">esc</kbd>
            </div>
            <ComboboxOptions static className="max-h-80 overflow-y-auto p-1.5">
              {matches.length === 0 ? (
                <div className="px-3 py-6 text-center text-[13px] text-faint">Nothing matches.</div>
              ) : (
                matches.map((t) => (
                  <ComboboxOption
                    key={t.id}
                    value={t}
                    className={cx(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px]",
                      "text-dim data-focus:bg-raise data-focus:text-text",
                    )}
                  >
                    <Mark className="size-3.5 shrink-0 text-neon" />
                    <span className="truncate">{t.label}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{t.hint}</span>
                  </ComboboxOption>
                ))
              )}
            </ComboboxOptions>
          </Combobox>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

/** Opens on ⌘K / Ctrl-K anywhere. */
export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);
}
