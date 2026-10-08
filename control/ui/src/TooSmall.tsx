import { useState } from "react";
import { Spinner } from "./Spinner";

/** What a phone gets instead of the console: tables, queries and graphs
 *  need a laptop, and squeezing them in would show something, but not the
 *  truth. So the mark gets cross about it instead. Tap it to set it off
 *  again; the key remount replays the reveal. */
export function TooSmall() {
  const [take, setTake] = useState(0);
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="flex max-w-[22rem] flex-col items-center">
        <button
          type="button"
          onClick={() => setTake((n) => n + 1)}
          aria-label="Make it angry again"
          className="mb-7 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Spinner key={take} size={132} state="error" intro label="Too small a screen" />
        </button>
        <h1 className="text-[24px] font-semibold tracking-tight">Not on a phone.</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-dim">
          The console shows tables, queries and graphs, and they need a laptop or a tablet. Your databases are fine
          and still running.
        </p>
        <a href="https://barua.app" className="mt-6 text-[14px] text-accent hover:underline">
          Back to barua.app
        </a>
      </div>
    </div>
  );
}
