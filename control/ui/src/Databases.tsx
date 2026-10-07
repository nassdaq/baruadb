import { useEffect, useState } from "react";
import { api, ApiError, type Database, type Me } from "./api";
import { ago, Button, Card, Dot, Empty, ErrorNote, Metric, Modal, RowMenu, TextField } from "./components";

export function Databases({ me, onOpen }: { me: Me; onOpen: (id: string) => void }) {
  const [list, setList] = useState<Database[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; uri: string } | null>(null);

  const load = () => api.databases().then(setList).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    load();
    // Databases fall asleep and wake on their own, so keep the list honest.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="mb-6 flex items-center">
        <div>
          <h2 className="text-[15px] font-medium">Databases</h2>
          <p className="text-[13px] text-mute-400">
            {list ? `${list.length} of ${me.db_quota} used` : "…"}
          </p>
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          New database
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {!list ? (
        <Empty>loading…</Empty>
      ) : list.length === 0 ? (
        <Empty>No databases yet. Create one to get a connection string.</Empty>
      ) : (
        list.map((d) => (
          <Card key={d.id} className="mb-3.5">
            <div className="flex items-center gap-2.5 p-4">
              <Dot state={d.status === "failed" ? "failed" : d.status === "creating" ? "creating" : d.state} />
              <button onClick={() => onOpen(d.id)} className="font-medium hover:underline">
                {d.name}
              </button>
              <span className="text-xs text-mute-400">{d.status === "ready" ? d.state : d.status}</span>
              <span className="font-mono text-xs text-mute-500">{d.id}</span>
              {d.parent_id && <span className="text-xs text-mute-500">branch of {d.parent_id}</span>}
              <div className="ml-auto flex items-center gap-2">
                <Button onClick={() => navigator.clipboard.writeText(d.connection_uri)}>Copy URL</Button>
                <Button onClick={() => onOpen(d.id)}>Open</Button>
                <RowMenu
                  items={[
                    {
                      label: "Branch",
                      onClick: () => {
                        const name = prompt("Branch name");
                        if (name) act(() => api.branch(d.id, name));
                      },
                    },
                    {
                      label: "Reset password",
                      onClick: () =>
                        act(async () => {
                          const r = await api.resetPassword(d.id);
                          setSecret({ title: `New password for ${d.name}`, uri: r.connection_uri });
                        }),
                    },
                    {
                      label: "Delete",
                      danger: true,
                      onClick: () => {
                        if (confirm(`Delete ${d.name} and its history in R2?`)) act(() => api.deleteDatabase(d.id));
                      },
                    },
                  ]}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-10 px-4 pb-4">
              <Metric label="State" value={d.status === "ready" ? d.state : d.status} />
              <Metric label="Connections" value={d.connections} />
              <Metric label="Where" value={d.state === "cold" ? "R2 only" : "box disk"} />
              <Metric label="Created" value={ago(d.created_at)} tone="plain" />
            </div>
          </Card>
        ))
      )}

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(uri, name) => {
          setCreating(false);
          setSecret({ title: `${name} is ready`, uri });
          load();
        }}
      />

      <Modal open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ""}>
        <p className="mb-3 text-[13px] text-mute-400">
          Copy this now. The password is not shown again, though you can always reset it.
        </p>
        <div className="overflow-auto whitespace-nowrap rounded-md border border-ink-700 bg-ink-950 px-3 py-2.5 font-mono text-xs text-mute-400">
          {secret?.uri}
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              navigator.clipboard.writeText(secret?.uri ?? "");
              setSecret(null);
            }}
          >
            Copy and close
          </Button>
          <Button onClick={() => setSecret(null)}>Close</Button>
        </div>
      </Modal>
    </>
  );
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (uri: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.createDatabase(name || "main");
      onCreated(r.connection_uri, r.database.name);
      setName("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New database">
      {error && <ErrorNote>{error}</ErrorNote>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} placeholder="shop" autoFocus />
        <p className="mb-4 text-[13px] text-mute-500">
          Postgres 16, asleep after five idle minutes, awake again on the next connection.
        </p>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}
