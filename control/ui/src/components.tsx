// Console furniture: the small pieces every screen reuses. Behaviour comes
// from Headless UI, looks from Tailwind.
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
import { CheckIcon, ChevronDownIcon, EllipsisVerticalIcon, MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { Fragment, type ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- button

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "default" | "primary" | "accent" | "danger" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  title?: string;
};

export function Button({ children, variant = "default", size = "md", className, ...rest }: ButtonProps) {
  return (
    <HButton
      {...rest}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border font-medium transition",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-[13px]",
        "data-disabled:cursor-default data-disabled:opacity-40",
        "data-focus:outline-none data-focus:ring-1 data-focus:ring-edge",
        variant === "primary" && "border-transparent bg-text text-base data-hover:bg-white",
        variant === "accent" && "border-neon/40 bg-neon/10 text-neon data-hover:bg-neon/15",
        variant === "danger" && "border-line text-text data-hover:border-rose/50 data-hover:text-rose",
        variant === "ghost" && "border-transparent text-dim data-hover:bg-raise data-hover:text-text",
        variant === "default" && "border-line bg-panel text-text data-hover:border-edge data-hover:bg-raise",
        className,
      )}
    >
      {children}
    </HButton>
  );
}

// ---------------------------------------------------------------- status

const TONE: Record<string, string> = {
  awake: "bg-neon shadow-[0_0_6px_--theme(--color-neon)]",
  online: "bg-neon shadow-[0_0_6px_--theme(--color-neon)]",
  asleep: "bg-faint",
  cold: "bg-sky",
  creating: "bg-amber",
  failed: "bg-rose",
  offline: "bg-rose",
};

export const Dot = ({ state }: { state: string }) => (
  <span className={cx("size-[6px] shrink-0 rounded-full", TONE[state] ?? "bg-faint")} />
);

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span
      className={cx(
        "rounded border px-1.5 py-px text-[11px] font-medium",
        tone === "accent" ? "border-neon/30 bg-neon/10 text-neon" : "border-line bg-raise text-dim",
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- surfaces

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx("rounded-lg border border-line bg-panel", className)}>{children}</div>
);

export function Stat({ label, value, unit, hint }: { label: string; value: ReactNode; unit?: string; hint?: string }) {
  return (
    <div className="min-w-[140px] flex-1">
      <div className="flex items-center gap-1 text-[12px] text-dim" title={hint}>
        {label}
        {hint && <span className="text-faint">ⓘ</span>}
      </div>
      <div className="mt-1.5 text-[21px] font-medium tracking-tight">
        {value}
        {unit && <span className="ml-1 text-[13px] font-normal text-dim">{unit}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- inputs

export function SearchBox({
  value,
  onChange,
  placeholder = "Search...",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cx("relative", className)}>
      <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-line bg-panel py-2 pl-9 pr-3 text-[13px] text-text placeholder:text-faint focus:border-edge focus:outline-none"
      />
    </div>
  );
}

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
      <Label className="mb-1.5 block text-[12px] text-dim">{label}</Label>
      <Input
        type={type}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "w-full rounded-md border border-line bg-base px-3 py-2 text-[13px] text-text",
          "placeholder:text-faint data-focus:border-edge data-focus:outline-none",
          mono && "font-mono",
        )}
      />
    </Field>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  icon,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: T[];
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Listbox value={value} onChange={onChange}>
      <ListboxButton
        className={cx(
          "flex w-full items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[13px] data-hover:bg-raise",
          className,
        )}
      >
        {icon}
        <span className="truncate">{value}</span>
        <ChevronDownIcon className="ml-auto size-4 shrink-0 text-faint" />
      </ListboxButton>
      <ListboxOptions
        anchor="bottom start"
        className="z-50 mt-1 max-h-80 w-[--button-width] min-w-48 overflow-auto rounded-md border border-line bg-panel p-1 text-[13px] shadow-2xl focus:outline-none"
      >
        {options.map((o) => (
          <ListboxOption
            key={o}
            value={o}
            className="flex cursor-pointer items-center justify-between gap-2 rounded px-2.5 py-1.5 text-dim data-focus:bg-raise data-focus:text-text"
          >
            <span className="truncate">{o}</span>
            {o === value && <CheckIcon className="size-4 shrink-0 text-neon" />}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

// ---------------------------------------------------------------- menus

export function RowMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  return (
    <Menu>
      <MenuButton className="rounded p-1 text-faint data-hover:bg-raise data-hover:text-text">
        <EllipsisVerticalIcon className="size-4" />
      </MenuButton>
      <MenuItems
        anchor="bottom end"
        className="z-50 w-48 rounded-md border border-line bg-panel p-1 text-[13px] shadow-2xl focus:outline-none"
      >
        {items.map((it) => (
          <MenuItem key={it.label}>
            <button
              onClick={it.onClick}
              className={cx(
                "block w-full rounded px-2.5 py-1.5 text-left",
                it.danger ? "text-rose/90 data-focus:bg-rose/10" : "text-dim data-focus:bg-raise data-focus:text-text",
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
          <div className="fixed inset-0 bg-black/70" aria-hidden="true" />
        </Transition.Child>
        <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
          <Transition.Child
            as={Fragment}
            enter="duration-150 ease-out"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="duration-100 ease-in"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl">
              <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
              <div className="mt-4">{children}</div>
            </DialogPanel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  );
}

// ---------------------------------------------------------------- misc

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="py-14 text-center text-[13px] text-faint">{children}</div>
);

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <div className="my-3 rounded-md border border-rose/30 bg-rose/5 px-3 py-2 text-[13px] text-rose/90">{children}</div>
);

export function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-line bg-base">
      <code className="flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-xs text-dim">{value}</code>
      <button
        onClick={() => navigator.clipboard.writeText(value)}
        className="border-l border-line px-3 text-xs text-dim hover:bg-raise hover:text-text"
        title="Copy"
      >
        ⧉
      </button>
    </div>
  );
}

export function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "A few seconds ago";
  if (s < 90) return "A minute ago";
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 7200) return "An hour ago";
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 172800) return "A day ago";
  if (s < 2592000) return `${Math.floor(s / 86400)} days ago`;
  return `${Math.floor(s / 2592000)} months ago`;
}
