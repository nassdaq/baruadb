// Console furniture: the small pieces every screen reuses. Behaviour comes
// from Headless UI, looks from Tailwind.
import {
  Button as HButton,
  Checkbox as HCheckbox,
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Field,
  Fieldset,
  Input,
  Label,
  Legend,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Radio,
  RadioGroup,
  Switch,
  Transition,
  TransitionChild,
} from "@headlessui/react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "./api";
import {
  ArrowDownTrayIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/20/solid";
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
        "inline-flex items-center gap-1.5 rounded-md border font-medium transition active:scale-[0.98]",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-[13px]",
        "data-disabled:cursor-default data-disabled:opacity-40",
        "data-focus:outline-none data-focus:ring-2 data-focus:ring-accent/30 data-focus:ring-offset-0",
        variant === "primary" && "border-transparent bg-text text-base data-hover:opacity-90",
        variant === "accent" && "border-accent/40 bg-accent/10 text-accent data-hover:bg-accent/15",
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
  awake: "bg-accent shadow-[0_0_6px_--theme(--color-accent)]",
  online: "bg-accent shadow-[0_0_6px_--theme(--color-accent)]",
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
        tone === "accent" ? "border-accent/30 bg-accent/10 text-accent" : "border-line bg-raise text-dim",
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
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-line bg-panel py-2 pl-9 pr-3 text-[13px] text-text placeholder:text-faint data-focus:border-edge data-focus:outline-none"
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
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
  hint?: string;
}) {
  // A password field carries its own eye: people mistype, and a dot row
  // cannot tell them where. The input keeps its type for autofill; only the
  // rendering flips.
  const secret = type === "password";
  const [shown, setShown] = useState(false);
  return (
    <Field className="mb-3">
      <Label className="mb-1.5 block text-[12px] text-dim">{label}</Label>
      <div className="relative">
        <Input
          type={secret && shown ? "text" : type}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          autoComplete={secret ? "current-password" : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cx(
            "w-full rounded-md border border-line bg-base px-3 py-2 text-[13px] text-text",
            "placeholder:text-faint data-focus:border-edge data-focus:outline-none data-focus:ring-2 data-focus:ring-accent/20",
            mono && "font-mono",
            secret && "pr-10",
          )}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            title={shown ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint transition hover:text-text focus:outline-none focus-visible:text-text"
          >
            {shown ? <EyeSlashIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        )}
      </div>
      {hint && <Description className="mt-1 block text-xs text-faint">{hint}</Description>}
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
        transition
        className="z-50 mt-1 max-h-80 w-[--button-width] min-w-48 overflow-auto rounded-lg border border-line bg-panel p-1 text-[13px] shadow-panel focus:outline-none
          origin-top transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
      >
        {options.map((o) => (
          <ListboxOption
            key={o}
            value={o}
            className="flex cursor-pointer items-center justify-between gap-2 rounded px-2.5 py-1.5 text-dim data-focus:bg-raise data-focus:text-text"
          >
            <span className="truncate">{o}</span>
            {o === value && <CheckIcon className="size-4 shrink-0 text-accent" />}
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
        transition
        className="z-50 w-48 rounded-lg border border-line bg-panel p-1 text-[13px] shadow-panel focus:outline-none
          origin-top-right transition duration-100 ease-out data-closed:scale-95 data-closed:opacity-0"
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

/** Flags for the regions we run in; a globe for anything else or "automatic". */
const REGION_FLAG: Record<string, string> = { auto: "🌐", eu: "🇳🇱", tz: "🇹🇿", default: "🌐" };
export const regionFlag = (zone?: string | null) => (zone && REGION_FLAG[zone]) || "🌐";

/** A region chooser, the way every cloud has one: a globe, a flag, a name.
 *  `value` is a zone slug or "auto". */
export function RegionSelect({
  value,
  onChange,
  zones,
  includeAuto = true,
  disabled = false,
}: {
  value: string;
  onChange: (zone: string) => void;
  zones: { zone: string; label: string; boxes?: number }[];
  includeAuto?: boolean;
  disabled?: boolean;
}) {
  const opts = [...(includeAuto ? [{ zone: "auto", label: "Automatic", boxes: 0 }] : []), ...zones];
  const cur = opts.find((o) => o.zone === value) ?? opts[0];
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <ListboxButton className="flex w-full items-center gap-2.5 rounded-md border border-line bg-base px-3 py-2 text-[13px] text-text data-focus:border-edge data-focus:outline-none disabled:opacity-60">
        <span className="text-[15px] leading-none">{regionFlag(cur?.zone)}</span>
        <span className="truncate">{cur?.label ?? "Automatic"}</span>
        <ChevronDownIcon className="ml-auto size-4 text-faint" />
      </ListboxButton>
      <ListboxOptions
        anchor="bottom start"
        transition
        className="z-50 mt-1 w-[var(--button-width)] origin-top rounded-lg border border-line bg-panel p-1 text-[13px] shadow-panel transition duration-100 ease-out focus:outline-none data-closed:scale-95 data-closed:opacity-0"
      >
        {opts.map((o) => (
          <ListboxOption
            key={o.zone}
            value={o.zone}
            className="group flex cursor-pointer items-center gap-2.5 rounded px-2.5 py-1.5 text-dim data-focus:bg-raise data-focus:text-text"
          >
            <span className="text-[15px] leading-none">{regionFlag(o.zone)}</span>
            <span className="truncate">{o.label}</span>
            {o.zone === "auto" ? (
              <span className="ml-auto text-[11px] text-faint group-data-selected:hidden">closest available</span>
            ) : null}
            <CheckIcon className="ml-auto size-4 shrink-0 text-accent opacity-0 group-data-selected:opacity-100" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

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
        <TransitionChild
          as={Fragment}
          enter="duration-150 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="duration-100 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <DialogBackdrop className="fixed inset-0 bg-scrim" />
        </TransitionChild>
        <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
          <TransitionChild
            as={Fragment}
            enter="duration-150 ease-out"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="duration-100 ease-in"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-panel">
              <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
              <div className="mt-4">{children}</div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}

/** Asking before something irreversible. The browser's own confirm() does this
 *  too, but it says "console.barua.app says" and offers no way to explain what
 *  is about to happen — so we ask ourselves. The destructive button is never
 *  the one focus lands on. */
export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  verb = "Delete",
  danger = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  verb?: string;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setBusy(false); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="flex gap-4">
        {danger && <ExclamationTriangleIcon className="mt-0.5 size-10 shrink-0 text-rose/70" />}
        {children && <div className="text-[13px] leading-relaxed text-dim">{children}</div>}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={() => { setBusy(true); onConfirm(); }}
        >
          {busy ? "Working…" : verb}
        </Button>
      </div>
    </Modal>
  );
}

/** One field and two buttons, for the places that used to call prompt(). */
export function Ask({
  open,
  onClose,
  onSubmit,
  title,
  label,
  placeholder,
  verb = "Create",
  hint,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
  title: string;
  label: string;
  placeholder?: string;
  verb?: string;
  hint?: string;
}) {
  const [value, setValue] = useState("");
  useEffect(() => { if (open) setValue(""); }, [open]);

  const send = () => { const v = value.trim(); if (v) onSubmit(v); };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); send(); }}>
        <TextField label={label} value={value} onChange={setValue} placeholder={placeholder} hint={hint} autoFocus />
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="accent" disabled={!value.trim()}>{verb}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- misc

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="py-14 text-center text-[13px] text-faint">{children}</div>
);

/** The screen when there is nothing to show. A large, quiet icon carries it;
 *  the title says what is missing and the line underneath says what to do. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  tone = "quiet",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "quiet" | "warn";
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div
        className={cx(
          "mb-5 grid size-16 place-items-center rounded-2xl border",
          tone === "warn" ? "border-amber/20 bg-amber/5" : "border-line bg-panel",
        )}
      >
        <Icon className={cx("size-8", tone === "warn" ? "text-amber/70" : "text-faint")} />
      </div>
      <div className="mb-1.5 text-[15px] font-medium text-text">{title}</div>
      {children && <div className="max-w-sm text-[13px] leading-relaxed text-dim">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** A shape where content will be, rather than the word "Loading". */
export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cx("animate-pulse rounded bg-raise", className)} />
);

export function TableSkeleton({ rows = 8, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-4">
      <div className="mb-3 flex gap-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="mb-2 flex gap-3" style={{ opacity: 1 - r * 0.09 }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3.5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <div className="my-3 flex items-start gap-2 rounded-md border border-rose/30 bg-rose/5 px-3 py-2 text-[13px] text-rose/90">
    <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0" />
    <span>{children}</span>
  </div>
);

export function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-line bg-base">
      <code className="flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-xs text-dim">{value}</code>
      <button
        onClick={() => navigator.clipboard.writeText(value)}
        className="border-l border-line px-3 text-dim transition hover:bg-raise hover:text-text"
        title="Copy"
      >
        <ClipboardDocumentIcon className="size-4" />
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


// ---------------------------------------------------------------- choices

/** A checkbox. Headless UI gives it the keyboard and ARIA behaviour; we only
 *  say what it looks like in each state. */
export function CheckBox({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  title?: string;
}) {
  const box = (
    <HCheckbox
      checked={checked}
      onChange={onChange}
      title={title}
      className={cx(
        "group flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition",
        "border-edge bg-base data-checked:border-accent data-checked:bg-accent",
        "data-focus:outline-none data-focus:ring-1 data-focus:ring-accent/50",
      )}
    >
      <svg viewBox="0 0 12 12" className="size-3 stroke-base opacity-0 group-data-checked:opacity-100" fill="none">
        <path d="M2.5 6.5 5 9l4.5-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </HCheckbox>
  );
  if (!label) return box;
  return (
    <Field className="flex items-center gap-2">
      {box}
      <Label className="cursor-pointer text-[13px] text-dim">{label}</Label>
    </Field>
  );
}

/** An on/off setting, where a checkbox would read as "tick to agree". */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <Field className="mb-3 flex items-start gap-3">
      <Switch
        checked={checked}
        onChange={onChange}
        className={cx(
          "group mt-0.5 flex h-5 w-9 shrink-0 cursor-pointer rounded-full p-0.5 transition",
          "border border-line bg-raise data-checked:border-accent/50 data-checked:bg-accent/25",
          "data-focus:outline-none data-focus:ring-1 data-focus:ring-accent/50",
        )}
      >
        <span className="size-4 rounded-full bg-dim transition group-data-checked:translate-x-4 group-data-checked:bg-accent" />
      </Switch>
      <span>
        <Label className="block cursor-pointer text-[13px] text-text">{label}</Label>
        {hint && <Description className="block text-xs text-faint">{hint}</Description>}
      </span>
    </Field>
  );
}

/** A segmented control: one of n, as a real radio group rather than buttons
 *  that merely look like one. Arrow keys move between options. */
export function Choice<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string])[];
  label?: string;
  className?: string;
}) {
  return (
    <RadioGroup
      value={value}
      onChange={onChange}
      aria-label={label ?? "options"}
      className={cx("flex overflow-hidden rounded-md border border-line", className)}
    >
      {options.map(([v, text]) => (
        <Radio
          key={v}
          value={v}
          className={cx(
            "flex-1 cursor-pointer px-3 py-1.5 text-center text-[13px] transition",
            "text-dim data-hover:bg-raise/60",
            "data-checked:bg-raise data-checked:text-text",
            "data-focus:outline-none data-focus:ring-1 data-focus:ring-inset data-focus:ring-edge",
          )}
        >
          {text}
        </Radio>
      ))}
    </RadioGroup>
  );
}

/** A form section with a visible legend. */
export function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <Fieldset className="mb-4">
      <Legend className="mb-2 text-[11px] uppercase tracking-wide text-faint">{legend}</Legend>
      {children}
    </Fieldset>
  );
}

// ---------------------------------------------------------------- connect

/** The connection details, the way a managed Postgres shows them: the real
 *  string, hidden until asked for, copyable in one click. */
export function ConnectPanel({ db }: { db: { id: string; name: string; connection_uri: string; pooled_uri: string } }) {
  const [creds, setCreds] = useState<{ connection_uri: string; pooled_uri: string } | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState(false);
  const [pooled, setPooled] = useState(false);
  const [busy, setBusy] = useState(false);

  // Fetched once, only when the panel opens: the password should not travel
  // with every listing of every database.
  useEffect(() => {
    setBusy(true);
    api
      .connection(db.id)
      .then(setCreds)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [db.id]);

  const real = pooled ? creds?.pooled_uri : creds?.connection_uri;
  const masked = pooled ? db.pooled_uri : db.connection_uri;
  const value = shown && real ? real : masked.replace("@", ":••••••••••••@");

  return (
    <div>
      <Choice
        label="endpoint"
        value={pooled ? "pooled" : "direct"}
        onChange={(v) => setPooled(v === "pooled")}
        className="mb-3"
        options={[
          ["direct", "Direct"],
          ["pooled", "Pooled"],
        ] as const}
      />

      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : (
        <>
          <div className="flex items-stretch overflow-hidden rounded-md border border-line bg-base">
            <code className="flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-xs text-dim">
              {busy ? "…" : value}
            </code>
            <button
              onClick={() => setShown((v) => !v)}
              disabled={!real}
              className="border-l border-line px-3 text-dim transition hover:bg-raise hover:text-text disabled:opacity-40"
              title={shown ? "Hide password" : "Show password"}
            >
              {shown ? <EyeSlashIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
            <button
              onClick={() => real && navigator.clipboard.writeText(real)}
              disabled={!real}
              className="border-l border-line px-3 text-dim transition hover:bg-raise hover:text-text disabled:opacity-40"
              title="Copy with password"
            >
              <ClipboardDocumentIcon className="size-4" />
            </button>
          </div>
          <p className="mt-1.5 text-xs text-faint">
            {pooled
              ? "Many clients share a few backends. Transaction pooling, so session state does not cross a transaction."
              : "One backend per client, with full session support."}
          </p>

          <div className="mb-2 mt-4 text-[12px] text-dim">psql</div>
          <CopyField value={`psql "${real ?? masked}"`} />

          <div className="mb-2 mt-4 text-[12px] text-dim">Environment variable</div>
          <CopyField value={`DATABASE_URL=${real ?? masked}`} />
        </>
      )}

      <div className="mt-5 border-t border-line-soft pt-4">
        <div className="mb-2 text-[13px] font-medium">Download</div>
        <p className="mb-3 text-xs text-faint">
          A plain SQL dump of schema and data, streamed from the box as it is produced. Restore it anywhere with psql.
        </p>
        <Button onClick={() => (window.location.href = `/v1/databases/${db.id}/dump`)}>
          <ArrowDownTrayIcon className="size-4" /> Download .sql
        </Button>
      </div>
    </div>
  );
}
