import type React from "react";
import { useEffect, useRef } from "react";
import "./vector-spinner";

type State = "loading" | "success" | "error" | "idle";

/** The brand loader. Attributes are set imperatively so the element keeps its
 *  own animation timeline across React renders. */
export function Spinner({
  state = "loading",
  size = 20,
  variant,
  intro,
  noSheen,
  label,
  className,
}: {
  state?: State;
  size?: number;
  variant?: "spin" | "pulse" | "swing";
  intro?: boolean;
  noSheen?: boolean;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.getAttribute("state") !== state) el.setAttribute("state", state);
  }, [state]);

  const props: Record<string, unknown> = {
    ref,
    class: className,
    size: `${size}px`,
    state,
    ...(variant ? { variant } : {}),
    ...(intro ? { intro: "" } : {}),
    ...(noSheen ? { "no-sheen": "" } : {}),
    ...(label ? { label } : {}),
  };
  const Tag = "vector-spinner" as unknown as React.ElementType;
  return <Tag {...props} />;
}

/** The whole-screen moment while the session is being resolved. */
export function BootScreen() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-5">
        <Spinner size={72} intro label="Starting Barua Database" />
        <div className="text-[13px] text-faint">
          <span className="font-medium text-dim">Barua</span> Database
        </div>
      </div>
    </div>
  );
}
