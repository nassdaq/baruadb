import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Button, Card, cx, ErrorNote, TextField } from "./components";
import { Databases } from "./Databases";
import { DatabaseDetail } from "./Database";
import { Admin } from "./Admin";

/** Routing, the whole of it: the path is the state. */
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
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still asking
  const [path, go] = usePath();

  useEffect(() => {
    api.me().then((r) => setMe(r.user)).catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return <div className="grid h-full place-items-center text-[13px] text-mute-500">loading…</div>;
  }
  if (me === null) return <SignIn onSignedIn={setMe} />;

  const dbMatch = path.match(/^\/databases\/([\w-]+)/);
  const tab = path.startsWith("/admin") ? "admin" : "databases";

  return (
    <div className="min-h-full">
      <nav className="flex h-[52px] items-center gap-7 border-b border-ink-700 bg-ink-900 px-5">
        <button onClick={() => go("/")} className="font-semibold tracking-tight">
          Barua<span className="font-normal text-mute-400">DB</span>
        </button>
        <button
          onClick={() => go("/")}
          className={cx(
            "border-b-2 py-1 text-[13px]",
            tab === "databases" ? "border-paper text-paper" : "border-transparent text-mute-400",
          )}
        >
          Databases
        </button>
        {me.is_admin && (
          <button
            onClick={() => go("/admin")}
            className={cx(
              "border-b-2 py-1 text-[13px]",
              tab === "admin" ? "border-paper text-paper" : "border-transparent text-mute-400",
            )}
          >
            Admin
          </button>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-mute-500">
          <span>{me.email}</span>
          <Button
            onClick={async () => {
              await api.signOut();
              setMe(null);
            }}
          >
            Sign out
          </Button>
        </div>
      </nav>

      <main className="mx-auto max-w-[1000px] px-5 pb-20 pt-7">
        {dbMatch ? (
          <DatabaseDetail id={dbMatch[1]} onBack={() => go("/")} />
        ) : tab === "admin" ? (
          <Admin />
        ) : (
          <Databases me={me} onOpen={(id) => go(`/databases/${id}`)} />
        )}
      </main>
    </div>
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
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-[19px] font-semibold">
          Barua<span className="font-normal text-mute-400">DB</span>
        </h1>
        <p className="mb-5 mt-1 text-[13px] text-mute-400">
          {mode === "in" ? "Sign in to your databases." : "Create an account. You get three databases to start."}
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
          <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full justify-center">
            {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <button
          onClick={() => {
            setMode(mode === "in" ? "up" : "in");
            setError("");
          }}
          className="mt-4 text-[13px] text-mute-400 hover:text-paper"
        >
          {mode === "in" ? "No account? Create one" : "Already have an account? Sign in"}
        </button>
      </Card>
    </div>
  );
}
