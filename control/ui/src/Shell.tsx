import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDownIcon, MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { useState, type ReactNode } from "react";
import type { Me } from "./api";
import { cx } from "./components";
import { applyTheme, readTheme, type Theme } from "./theme";

export { Mark } from "./Logo";
import { Logo, Mark } from "./Logo";

export type NavItem = {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  onClick?: () => void;
};

export function Shell({
  me,
  onSignOut,
  onAccount,
  onSearch,
  sidebar,
  children,
  footer,
}: {
  me: Me;
  onSignOut: () => void;
  onAccount?: () => void;
  onSearch: () => void;
  sidebar: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <div className="flex w-[164px] items-center">
          <Logo size={19} />
        </div>
        <button
          onClick={onSearch}
          className="mx-auto hidden w-full max-w-[360px] items-center gap-2 rounded-md border border-line bg-base px-3 py-1.5 text-[13px] text-faint hover:border-edge md:flex"
        >
          <MagnifyingGlassIcon className="size-4" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded border border-line px-1.5 py-px font-mono text-[11px] text-faint">⌘K</kbd>
        </button>
        <Menu>
          <MenuButton className="ml-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-hover:bg-raise">
            <span className="grid size-6 place-items-center rounded bg-accent/15 text-[11px] font-semibold text-accent">
              {me.email[0]?.toUpperCase()}
            </span>
            <span className="hidden text-dim sm:inline">{me.name || me.email.split("@")[0]}</span>
            <ChevronDownIcon className="size-4 text-faint" />
          </MenuButton>
          <MenuItems
            anchor="bottom end"
            transition
            className="z-50 mt-1 w-56 rounded-lg border border-line bg-panel p-1 text-[13px] shadow-panel focus:outline-none origin-top-right transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
          >
            <div className="border-b border-line px-2.5 py-2">
              <div className="truncate text-[13px] text-text">{me.name || me.email.split("@")[0]}</div>
              <div className="truncate text-xs text-faint">{me.email}</div>
            </div>
            <div className="border-b border-line px-2.5 py-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">Appearance</div>
              <div className="grid grid-cols-3 gap-0.5 rounded-md bg-base p-0.5">
                {(["system", "light", "dark"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      applyTheme(t);
                      setTheme(t);
                    }}
                    className={cx(
                      "rounded px-1.5 py-1 text-[12px] capitalize transition",
                      theme === t ? "bg-raise text-text" : "text-dim hover:text-text",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {onAccount && (
              <MenuItem>
                <button
                  onClick={onAccount}
                  className="mt-1 block w-full rounded px-2.5 py-1.5 text-left text-dim data-focus:bg-raise data-focus:text-text"
                >
                  Account
                </button>
              </MenuItem>
            )}
            <MenuItem>
              <button
                onClick={onSignOut}
                className="mt-1 block w-full rounded px-2.5 py-1.5 text-left text-dim data-focus:bg-raise data-focus:text-text"
              >
                Sign out
              </button>
            </MenuItem>
          </MenuItems>
        </Menu>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[180px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="min-h-0 flex-1 overflow-y-auto py-3">{sidebar}</div>
          {footer && <div className="border-t border-line p-3">{footer}</div>}
        </aside>
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

export function NavGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="mb-4 px-2">
      {title && <div className="mb-1.5 px-2 text-[10px] uppercase tracking-[0.08em] text-faint">{title}</div>}
      {children}
    </div>
  );
}

export function NavLink({ label, icon, active, onClick }: NavItem) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition",
        active ? "bg-raise text-text" : "text-dim hover:bg-raise/60 hover:text-text",
      )}
    >
      <span className={cx("grid size-4 shrink-0 place-items-center", active ? "text-accent" : "text-faint")}>
        {icon ?? <Mark />}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The page header strip: title on the left, actions on the right. */
export function PageHead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-0.5 text-[13px] text-dim">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
