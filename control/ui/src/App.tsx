import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Database, type Me } from "./api";
import { Admin } from "./Admin";
import { Button, Card, CopyField, ErrorNote, Modal, TextField } from "./components";
import { DatabaseSidebar, DatabaseView, type Section } from "./Database";
import { Databases } from "./Databases";
import { Mark, NavGroup, NavLink, Shell } from "./Shell";
import { Palette, usePaletteShortcut } from "./Palette";

/** Routing: the path is the state. /databases/<id>/<section> or /admin. */
function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    history.pushState(null, "", to);
    setPath(to);
  }, []);
  return [path, go];
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [path, go] = usePath();
  const [db, setDb] = useState<Database | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [all, setAll] = useState<Database[]>([]);

  usePaletteShortcut(useCallback(() => setPaletteOpen(true), []));

  useEffect(() => {
    api.me().then((r) => setMe(r.user)).catch(() => setMe(null));
  }, []);

  // The palette searches whatever you own, wherever you are.
  useEffect(() => {
    if (!me) return;
    api.databases().then(setAll).catch(() => setAll([]));
  }, [me, path]);

  const match = path.match(/^\/databases\/([\w-]+)(?:\/(\w+))?/);
  const dbId = match?.[1];
  const section = (match?.[2] as Section) ?? "overview";

  const signedIn = me?.id;
  const loadDb = useCallback(() => {
    if (!dbId || !signedIn) return setDb(null);
    api.database(dbId).then(setDb).catch(() => setDb(null));
  }, [dbId, signedIn]);

  useEffect(() => {
    // Depends on the session too: landing on /databases/<id> while signed out
    // 401s, and without this the page would sit on "Loading" after signing in.
    loadDb();
    if (!dbId || !signedIn) return;
    // A database wakes and sleeps underneath us; keep the header truthful.
    const t = setInterval(loadDb, 10_000);
    return () => clearInterval(t);
  }, [dbId, signedIn, loadDb]);

  if (me === undefined) {
    return <div className="grid h-full place-items-center text-[13px] text-faint">Loading…</div>;
  }
  if (me === null) return <SignIn onSignedIn={setMe} />;

  const signOut = async () => {
    await api.signOut();
    setMe(null);
    go("/");
  };

  // ---- inside a database
  if (dbId && db) {
    return (
      <>
        <Shell
          me={me}
          onSignOut={signOut}
          onSearch={() => setPaletteOpen(true)}
          sidebar={
            <DatabaseSidebar
              db={db}
              section={section}
              onSection={(s) => go(`/databases/${db.id}/${s}`)}
              onBack={() => go("/")}
              onConnect={() => setConnectOpen(true)}
            />
          }
        >
          <DatabaseView db={db} section={section} reload={loadDb} onBack={() => go("/")} />
        </Shell>
        <Modal open={connectOpen} onClose={() => setConnectOpen(false)} title={`Connect to ${db.name}`}>
          <div className="mb-2 text-[12px] text-dim">Direct connection</div>
          <CopyField value={db.connection_uri} />
          <p className="mt-1.5 text-xs text-faint">One Postgres backend per client. Full session support.</p>

          <div className="mb-2 mt-4 flex items-center gap-2 text-[12px] text-dim">
            Pooled connection
            <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-px text-[10px] text-accent">
              recommended for serverless
            </span>
          </div>
          <CopyField value={db.pooled_uri} />
          <p className="mt-1.5 text-xs text-faint">
            Many clients share a few backends, so hundreds of connections cost little. Transaction pooling, so session
            state — <code className="font-mono">SET</code>, <code className="font-mono">LISTEN</code>, named prepared
            statements — does not survive a transaction.
          </p>

          <div className="mb-2 mt-4 text-[12px] text-dim">psql</div>
          <CopyField value={`psql "${db.connection_uri}"`} />
          <p className="mt-4 text-xs text-faint">
            Substitute the password you were shown at creation. Lost it? Reset the password from the databases list.
          </p>
        </Modal>
        <Palette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          databases={all}
          current={db}
          go={go}
        />
      </>
    );
  }

  // ---- the list, or admin
  const onAdmin = path.startsWith("/admin");
  return (
    <Shell
      me={me}
      onSignOut={signOut}
      onSearch={() => setPaletteOpen(true)}
      sidebar={
        <NavGroup title="Organization">
          <NavLink label="Databases" active={!onAdmin} onClick={() => go("/")} />
          {me.is_admin && <NavLink label="Admin" active={onAdmin} onClick={() => go("/admin")} />}
        </NavGroup>
      }
      footer={<div className="truncate text-[11px] text-faint">Serverless Postgres</div>}
    >
      {dbId && !db ? (
        <div className="p-8 text-[13px] text-faint">Loading database…</div>
      ) : onAdmin ? (
        <Admin />
      ) : (
        <Databases me={me} onOpen={(id) => go(`/databases/${id}/overview`)} />
      )}
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} databases={all} current={null} go={go} />
    </Shell>
  );
}

// ---------------------------------------------------------------- sign in

function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = mode === "in" ? await api.signIn(email, password) : await api.signUp(email, password, name);
      onSignedIn(r.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <Mark className="size-5 text-accent" />
          BARUA
        </div>
        <Card className="p-6">
          <h1 className="text-[17px] font-semibold">{mode === "in" ? "Sign in" : "Create an account"}</h1>
          <p className="mb-5 mt-1 text-[13px] text-dim">
            {mode === "in" ? "Postgres that scales to zero." : "Three databases to start, free while they sleep."}
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {mode === "up" && <TextField label="Name" value={name} onChange={setName} placeholder="optional" />}
            <TextField label="Email" value={email} onChange={setEmail} type="email" autoFocus />
            <TextField
              label="Password"
              value={password}
              onChange={setPassword}
              type="password"
              placeholder={mode === "up" ? "at least 10 characters" : ""}
            />
            <Button type="submit" variant="accent" disabled={busy} className="mt-1 w-full justify-center">
              {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <button
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setError("");
            }}
            className="mt-4 text-[13px] text-dim hover:text-text"
          >
            {mode === "in" ? "No account? Create one" : "Already have an account? Sign in"}
          </button>
        </Card>
      </div>
    </div>
  );
}
