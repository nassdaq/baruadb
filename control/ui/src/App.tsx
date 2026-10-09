import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Database, type Me } from "./api";
import { Account } from "./Account";
import { Admin } from "./Admin";
import { Button, Card, ConnectPanel, ErrorNote, Modal, TextField } from "./components";
import { DatabaseSidebar, DatabaseView, type Section } from "./Database";
import { Databases } from "./Databases";
import { CircleStackIcon, ShieldCheckIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { NavGroup, NavLink, Shell } from "./Shell";
import { BootScreen, Spinner } from "./Spinner";
import { Palette, usePaletteShortcut } from "./Palette";
import { PHONE, useMediaQuery } from "./media";
import { TooSmall } from "./TooSmall";
import { deviceSignature } from "./device";

/** Routing: the path is the state. /databases/<id>/<section>, /account or /admin. */
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
  const phone = useMediaQuery(PHONE);

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

  // A phone gets the mark's opinion of phones, signed in or not: the console
  // has nothing honest to show at that width.
  if (phone) return <TooSmall />;
  // The first paint of the session: the mark draws itself in while we find out
  // who is signed in.
  if (me === undefined) return <BootScreen />;
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
          onAccount={() => go("/account")}
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
          <ConnectPanel db={db} />
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

  // ---- the list, the account page, or admin
  const onAdmin = path.startsWith("/admin");
  const onAccount = path.startsWith("/account");
  return (
    <Shell
      me={me}
      onSignOut={signOut}
      onAccount={() => go("/account")}
      onSearch={() => setPaletteOpen(true)}
      sidebar={
        <NavGroup title="Organization">
          <NavLink
            label="Databases"
            icon={<CircleStackIcon className="size-4" />}
            active={!onAdmin && !onAccount}
            onClick={() => go("/")}
          />
          <NavLink
            label="Account"
            icon={<UserCircleIcon className="size-4" />}
            active={onAccount}
            onClick={() => go("/account")}
          />
          {me.is_admin && (
            <NavLink
              label="Admin"
              icon={<ShieldCheckIcon className="size-4" />}
              active={onAdmin}
              onClick={() => go("/admin")}
            />
          )}
        </NavGroup>
      }
      footer={<div className="truncate text-[11px] text-faint">Serverless Postgres</div>}
    >
      {dbId && !db ? (
        <div className="p-8 text-[13px] text-faint">Loading database…</div>
      ) : onAdmin ? (
        <Admin />
      ) : onAccount ? (
        <Account me={me} onChanged={setMe} onDatabases={() => go("/")} />
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
  // The signed-in person, held back until the mark has finished drawing its
  // check: the moment is short, and skipping it made the logo feel broken.
  const [done, setDone] = useState<Me | null>(null);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r =
        mode === "in"
          ? await api.signIn(email, password)
          : await api.signUp(email, password, name, await deviceSignature());
      setDone(r.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The element says when it is finished; if it never does (reduced motion,
  // an old browser), go anyway after the animation's worst-case length.
  const enter = useCallback(() => {
    if (done) onSignedIn(done);
  }, [done, onSignedIn]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(enter, 2500);
    return () => clearTimeout(t);
  }, [done, enter]);

  return (
    <div className="grid h-full place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <Spinner
            size={56}
            state={done ? "success" : busy ? "loading" : error ? "error" : "idle"}
            intro
            className="mb-4"
            onSuccess={enter}
          />
          <div className="text-[20px] tracking-tight">
            <span className="font-semibold">Barua</span> <span className="text-dim">Database</span>
          </div>
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
            <Button type="submit" variant="accent" disabled={busy || done !== null} className="mt-1 w-full justify-center">
              {busy && <Spinner size={16} noSheen />}
              {done ? "Welcome" : busy ? "Working" : mode === "in" ? "Sign in" : "Create account"}
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
