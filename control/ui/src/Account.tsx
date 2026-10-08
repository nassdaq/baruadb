import { useEffect, useState } from "react";
import { api, ApiError, type Account as AccountData, type Me } from "./api";
import { ago, Button, Card, ErrorNote, Stat, TextField } from "./components";
import { CircleStackIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { PageHead } from "./Shell";

/** A person's own page: what we know about them, and how much of their
 *  allowance they are using. The email is the one thing here they cannot
 *  change, because it is how they sign in. */
export function Account({
  me,
  onChanged,
  onDatabases,
}: {
  me: Me;
  onChanged: (me: Me) => void;
  onDatabases: () => void;
}) {
  const [data, setData] = useState<AccountData | null>(null);
  const [name, setName] = useState(me.name ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.account().then(setData).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const r = await api.updateAccount(name);
      onChanged({ ...me, name: r.user.name });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const u = data?.usage;
  const joined = new Date(me.created_at);

  return (
    <div className="mx-auto max-w-[860px] px-8 py-7">
      <PageHead title="Account" subtitle={me.email} />
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card className="mb-3.5 p-5">
        <div className="flex gap-5">
          <UserCircleIcon className="size-14 shrink-0 text-faint" strokeWidth={1} />
          <div className="min-w-0 flex-1">
            <div className="mb-4 grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2">
              <Field label="Email" value={me.email} mono />
              <Field label="Member since" value={joined.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} />
              <Field label="Last signed in" value={me.last_seen_at ? ago(me.last_seen_at) : "now"} />
              <Field label="Signed-in devices" value={data ? String(data.sessions) : "…"} />
            </div>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <div className="flex-1">
                <TextField label="Name" value={name} onChange={setName} placeholder="How we should address you" />
              </div>
              <Button type="submit" variant="accent" disabled={saving || name === (me.name ?? "")} className="mb-3">
                {saving ? "Saving…" : saved ? "Saved" : "Save"}
              </Button>
            </form>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex gap-5">
          <CircleStackIcon className="size-14 shrink-0 text-faint" strokeWidth={1} />
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[15px] font-medium">Your databases</div>
            <p className="mb-4 text-[13px] text-dim">
              You can hold {me.db_quota} at a time, branches included. Each sleeps after five idle minutes and wakes on
              the next connection.
            </p>
            <div className="grid grid-cols-2 gap-x-10 gap-y-6 sm:grid-cols-4">
              <Stat label="In use" value={u ? `${u.databases} / ${u.quota}` : "…"} />
              <Stat label="Branches" value={u ? u.branches : "…"} />
              <Stat label="Awake now" value={u ? u.awake : "…"} />
              <Stat label="Archived" value={u ? u.archived : "…"} hint="Asleep long enough to be put away; restored on the next connection" />
            </div>
            <Button onClick={onDatabases} className="mt-5">
              Go to databases
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-dim">{label}</div>
      <div className={mono ? "truncate font-mono text-[13px] text-text" : "truncate text-[13px] text-text"}>{value}</div>
    </div>
  );
}
