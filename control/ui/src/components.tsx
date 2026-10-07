// Shared pieces, all built on Headless UI so the keyboard and screen-reader
// behaviour comes from a library rather than from us guessing.
import {
  Button as HButton,
  Dialog,
  DialogPanel,
  DialogTitle,
  Field,
  Input,
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Transition,
} from "@headlessui/react";
import { CheckIcon, ChevronDownIcon, EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import { Fragment, type ReactNode } from "react";

export const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- button

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  className?: string;
};

export function Button({ children, variant = "default", className, ...rest }: ButtonProps) {
  return (
    <HButton
      {...rest}
      className={cx(
        "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] transition",
        "data-disabled:cursor-default data-disabled:opacity-45",
        "data-focus:outline-none data-focus:ring-1 data-focus:ring-ink-500",
        variant === "primary"
          ? "border-live/40 text-paper data-hover:bg-live/10"
          : variant === "danger"
            ? "border-ink-600 text-paper data-hover:border-bad/50 data-hover:text-bad"
            : "border-ink-600 text-paper data-hover:border-ink-500 data-hover:bg-ink-800",
        className,
      )}
    >
      {children}
    </HButton>
  );
}

// ---------------------------------------------------------------- status dot

const TONE: Record<string, string> = {
  awake: "bg-live shadow-[0_0_8px_--theme(--color-live)]",
  asleep: "bg-mute-500",
  cold: "bg-cold",
  failed: "bg-bad",
  creating: "bg-warn",
  online: "bg-live shadow-[0_0_8px_--theme(--color-live)]",
  offline: "bg-bad",
};

export function Dot({ state }: { state: string }) {
  return <span className={cx("size-[7px] shrink-0 rounded-full", TONE[state] ?? "bg-mute-500")} />;
}

export function StatusPill({ state }: { state: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-mute-400">
      <Dot state={state} />
      {state}
    </span>
  );
}

// ---------------------------------------------------------------- metric

export function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: "live" | "plain" }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.06em] text-mute-500">{label}</div>
      <div className={cx("mt-1 text-[13px]", tone === "plain" ? "text-paper" : "text-live")}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------- card

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-[10px] border border-ink-700 bg-ink-900", className)}>{children}</div>;
}

// ---------------------------------------------------------------- modal

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Transition show={open} as={Fragment}>
      <Dialog onClose={onClose} className="relative z-50">
        <Transition.Child
          as={Fragment}
          enter="duration-150 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="duration-100 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
        </Transition.Child>
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Transition.Child
            as={Fragment}
            enter="duration-150 ease-out"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="duration-100 ease-in"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5">
              <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
              <div className="mt-4">{children}</div>
            </DialogPanel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}

// ---------------------------------------------------------------- text field

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <Field className="mb-3">
      <Label className="mb-1.5 block text-[11px] uppercase tracking-[0.06em] text-mute-500">{label}</Label>
      <Input
        type={type}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-[13px] text-paper",
          "placeholder:text-mute-500 data-focus:border-ink-500 data-focus:outline-none",
          mono && "font-mono",
        )}
      />
    </Field>
  );
}

// ---------------------------------------------------------------- select

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: T[];
  label?: string;
}) {
  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative">
        <ListboxButton className="flex items-center gap-2 rounded-md border border-ink-600 px-3 py-1.5 text-[13px] data-hover:bg-ink-800">
          {label && <span className="text-mute-500">{label}</span>}
          {value}
          <ChevronDownIcon className="size-4 text-mute-500" />
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-72 w-52 overflow-auto rounded-md border border-ink-700 bg-ink-900 p-1 text-[13px] shadow-xl focus:outline-none"
        >
          {options.map((o) => (
            <ListboxOption
              key={o}
              value={o}
              className="flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-mute-400 data-focus:bg-ink-800 data-focus:text-paper"
            >
              <span className="truncate">{o}</span>
              {o === value && <CheckIcon className="size-4 text-live" />}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

// ---------------------------------------------------------------- row menu

export function RowMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  return (
    <Menu>
      <MenuButton className="rounded-md border border-ink-600 p-1.5 data-hover:bg-ink-800">
        <EllipsisHorizontalIcon className="size-4 text-mute-400" />
      </MenuButton>
      <MenuItems
        anchor="bottom end"
        className="z-50 mt-1 w-48 rounded-md border border-ink-700 bg-ink-900 p-1 text-[13px] shadow-xl focus:outline-none"
      >
        {items.map((it) => (
          <MenuItem key={it.label}>
            <button
              onClick={it.onClick}
              className={cx(
                "block w-full rounded px-2.5 py-1.5 text-left",
                it.danger ? "text-bad/90 data-focus:bg-bad/10" : "text-mute-400 data-focus:bg-ink-800 data-focus:text-paper",
              )}
            >
              {it.label}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
}

// ---------------------------------------------------------------- misc

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center text-[13px] text-mute-500">{children}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="my-3 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-[13px] text-bad/90">{children}</div>
  );
}

export function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
