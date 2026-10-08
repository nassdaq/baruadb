import { useEffect, useState } from "react";

/** True while the media query matches; follows rotations and resizes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Below this the console cannot show a table, a query or a graph honestly. */
export const PHONE = "(max-width: 767px)";
