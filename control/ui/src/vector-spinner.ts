/**
 * <vector-spinner> — the brand loader, built from the mark.
 *
 * Written as a custom element so it owns its own animations rather than
 * re-rendering through React sixty times a second. Registered once, used
 * through the Spinner wrapper.
 *
 * States: loading (spins) · success (settles, pops, draws a check) ·
 *         error (settles, turns red, becomes an angry face and keeps fuming) ·
 *         idle (rests, with an occasional light sweep)
 * Attributes: size, color, speed, variant (spin|pulse|swing), state, intro,
 *             no-sheen, error-icon (angry|x), paused, label
 * Methods: reveal() success() error() loading() idle() pause() play()
 * Events:  vs-revealed, vs-success, vs-error — fired when each animation ends
 * CSS:     --vs-size, --vs-color, --vs-success, --vs-error, --vs-speed
 */
import { MARK_PATH as PATH } from "./Logo";

const C = 126.04; // centre of the ring in viewBox units

const tpl = document.createElement("template");
tpl.innerHTML = `
  <style>
    :host {
      display: inline-block;
      width: var(--vs-size, 48px);
      height: var(--vs-size, 48px);
      color: var(--vs-color, #186F70);
      line-height: 0;
      vertical-align: middle;
    }
    :host([hidden]) { display: none; }
    svg { width: 100%; height: 100%; overflow: visible; }
    .mark, .spin { transform-origin: ${C}px ${C}px; }
    .ring { fill: currentColor; transition: fill .35s ease; }
    :host([state="error"]) .ring { fill: var(--vs-error, #C2453D); }
    .outline {
      fill: none; stroke: currentColor; stroke-width: 4; stroke-linejoin: round;
      stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0;
    }
    .glyph {
      fill: none; stroke-width: 20; stroke-linecap: round; stroke-linejoin: round;
      stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0;
    }
    .check { stroke: var(--vs-success, currentColor); }
    .cross { stroke: var(--vs-error, #C2453D); }
    .angry * { transform-box: fill-box; transform-origin: center; opacity: 0; }
    .angry .brow, .angry .mouth {
      fill: none; stroke: var(--vs-error, #C2453D); stroke-width: 17; stroke-linecap: round;
    }
    .angry .mouth { stroke-dasharray: 1; stroke-dashoffset: 1; }
    .angry .eye, .angry .puff { fill: var(--vs-error, #C2453D); }
    .sheen { fill: url(#vs-sheen); transform: translateX(-160px); }
    :host([no-sheen]) .sheen-layer { display: none; }
  </style>
  <svg viewBox="0 0 253 253" part="svg" aria-hidden="true">
    <defs>
      <linearGradient id="vs-sheen" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0"   stop-color="#fff" stop-opacity="0"/>
        <stop offset=".5"  stop-color="#fff" stop-opacity=".6"/>
        <stop offset="1"   stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="vs-clip"><path d="${PATH}"/></clipPath>
    </defs>
    <g class="mark">
      <g class="spin">
        <path class="ring" part="ring" d="${PATH}"/>
        <path class="outline" d="${PATH}" pathLength="1"/>
        <g class="sheen-layer" clip-path="url(#vs-clip)">
          <g transform="rotate(20 ${C} ${C})">
            <rect class="sheen" x="0" y="-100" width="70" height="453"/>
          </g>
        </g>
      </g>
      <path class="glyph check" pathLength="1" d="M80 130 L111 161 L172 100"/>
      <path class="glyph cross" pathLength="1" d="M94 94 L158 158 M158 94 L94 158"/>
      <g class="angry">
        <path class="brow" d="M80 94 L114 112"/>
        <path class="brow" d="M172 94 L138 112"/>
        <circle class="eye" cx="100" cy="130" r="10"/>
        <circle class="eye" cx="152" cy="130" r="10"/>
        <path class="mouth" pathLength="1" d="M94 178 Q126 152 158 178"/>
        <circle class="puff" cx="88" cy="-6" r="11"/>
        <circle class="puff" cx="164" cy="-6" r="9"/>
      </g>
    </g>
  </svg>`;

const EASE = "cubic-bezier(.55,.15,.45,.85)";
const SWING = "cubic-bezier(.7,0,.3,1)";
const VARIANTS: Record<string, () => Keyframe[]> = {
  spin: () => [{ transform: "rotate(0deg)", easing: EASE }, { transform: "rotate(360deg)" }],
  pulse: () => [
    { transform: "rotate(0deg) scale(1)", opacity: 1, easing: "ease-in-out" },
    { transform: "rotate(180deg) scale(.86)", opacity: 0.7, easing: "ease-in-out" },
    { transform: "rotate(360deg) scale(1)", opacity: 1 },
  ],
  swing: () => [
    { transform: "rotate(0deg)", offset: 0 },
    { transform: "rotate(0deg)", offset: 0.15, easing: SWING },
    { transform: "rotate(180deg)", offset: 0.5 },
    { transform: "rotate(180deg)", offset: 0.65, easing: SWING },
    { transform: "rotate(360deg)", offset: 1 },
  ],
};
const done = (a: Animation) => a.finished.catch(() => {});

type Parts = {
  mark: SVGGElement;
  spin: SVGGElement;
  ring: SVGPathElement;
  outline: SVGPathElement;
  sheen: SVGRectElement;
  check: SVGPathElement;
  cross: SVGPathElement;
  angry: SVGGElement;
};

export class VectorSpinner extends HTMLElement {
  static get observedAttributes() {
    return ["size", "color", "speed", "label", "variant", "state", "paused", "no-sheen", "error-icon"];
  }

  #loop: Animation | null = null;
  #sheenAnim: Animation | null = null;
  #fume: Animation[] = [];
  #busy = false;
  #token = 0;
  readonly $: Parts;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(tpl.content.cloneNode(true));
    const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
    this.$ = {
      mark: $(".mark"),
      spin: $(".spin"),
      ring: $(".ring"),
      outline: $(".outline"),
      sheen: $(".sheen"),
      check: $(".check"),
      cross: $(".cross"),
      angry: $(".angry"),
    };
  }

  get #reduced(): boolean {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  get #speed(): number {
    return (parseFloat(this.getAttribute("speed") ?? "") || 1.1) * 1000;
  }
  get state(): string {
    return this.getAttribute("state") || "loading";
  }
  set state(v: string) {
    this.setAttribute("state", v);
  }

  connectedCallback() {
    if (!this.hasAttribute("role")) this.setAttribute("role", "status");
    this.#sync();
    if (this.hasAttribute("intro")) this.reveal();
    else this.#apply();
  }
  disconnectedCallback() {
    this.#token++;
    this.shadowRoot!.getAnimations().forEach((a) => a.cancel());
    this.#loop = this.#sheenAnim = null;
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null) {
    this.#sync();
    if (!this.isConnected || oldV === newV) return;
    if (name === "paused") return newV === null ? this.play() : this.pause();
    if (this.#busy) return; // reveal applies the final state when it ends
    if (name === "state") this.#apply();
    if ((name === "variant" || name === "speed") && this.state === "loading") this.#startLoop();
    if (name === "no-sheen") this.#startSheen();
    if (name === "error-icon" && this.state === "error") this.#apply();
  }

  // ---------- public API ----------
  loading() { this.state = "loading"; }
  success() { this.state = "success"; }
  error() { this.state = "error"; }
  idle() { this.state = "idle"; }
  pause() {
    this.setAttribute("paused", "");
    this.shadowRoot!.getAnimations().forEach((a) => a.pause());
  }
  play() {
    this.removeAttribute("paused");
    this.shadowRoot!.getAnimations().forEach((a) => a.play());
  }

  /** The logo reveal: outline draws, fills, turns into place. */
  async reveal() {
    const t = ++this.#token;
    this.#busy = true;
    this.#stopLoop();
    this.#hideGlyphs();
    this.shadowRoot!.getAnimations().forEach((a) => a.cancel());
    const { ring, outline, spin, mark } = this.$;

    if (!this.#reduced) {
      ring.style.opacity = "0";
      outline.style.opacity = "1";
      const draw = outline.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
        duration: 1000,
        easing: "cubic-bezier(.65,0,.35,1)",
        fill: "forwards",
      });
      spin.animate([{ transform: "rotate(-140deg) scale(.88)" }, { transform: "rotate(0deg) scale(1)" }], {
        duration: 1100,
        easing: "cubic-bezier(.2,.7,.3,1)",
      });
      await done(draw);
      if (t !== this.#token) return;

      ring.style.opacity = "";
      ring.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: "ease-out" });
      outline.style.opacity = "";
      outline.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: "ease-out" });
      draw.cancel();
      await done(
        mark.animate([{ transform: "scale(1)" }, { transform: "scale(1.07)", offset: 0.4 }, { transform: "scale(1)" }], {
          duration: 520,
          easing: "ease-out",
        }),
      );
      if (t !== this.#token) return;
    }
    this.#busy = false;
    this.#emit("vs-revealed");
    this.#apply();
  }

  // ---------- internals ----------
  #sync() {
    const s = this.style;
    const set = (prop: string, v: string | null) => (v ? s.setProperty(prop, v) : s.removeProperty(prop));
    set("--vs-size", this.getAttribute("size"));
    set("--vs-color", this.getAttribute("color"));
    const sp = this.getAttribute("speed");
    set("--vs-speed", sp && sp + "s");
    const label =
      this.getAttribute("label") ||
      ({ loading: "Loading", success: "Done", error: "Something went wrong", idle: "Ready" } as Record<string, string>)[this.state] ||
      "Loading";
    this.setAttribute("aria-label", label);
  }

  async #apply() {
    const t = ++this.#token;
    const s = this.state;
    if (s === "loading") {
      this.#hideGlyphs();
      this.#startLoop();
      this.#startSheen();
      return;
    }
    await this.#settle();
    if (t !== this.#token) return;
    this.#hideGlyphs();
    const { mark, check, cross } = this.$;

    if (s === "success") {
      mark.animate([{ transform: "scale(1)" }, { transform: "scale(1.1)", offset: 0.35 }, { transform: "scale(1)" }], {
        duration: 480,
        easing: "cubic-bezier(.3,1.4,.5,1)",
      });
      await this.#draw(check);
      if (t === this.#token) {
        this.#startSheen();
        this.#emit("vs-success");
      }
    } else if (s === "error") {
      this.#sheenAnim?.cancel();
      mark.animate(
        ["0", "-12", "11", "-8", "6", "-3", "0"].map((x) => ({ transform: `translateX(${x}px)` })),
        { duration: 480, easing: "ease-out" },
      );
      if (this.getAttribute("error-icon") === "x") await this.#draw(cross);
      else await this.#angry(t);
      if (t === this.#token) this.#emit("vs-error");
    } else {
      this.#startSheen();
    }
  }

  #startLoop() {
    this.#stopLoop();
    const reduced = this.#reduced;
    const v = VARIANTS[this.getAttribute("variant") ?? ""] || VARIANTS.spin!;
    const frames = reduced ? [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }] : v();
    this.#loop = this.$.spin.animate(frames, { duration: reduced ? 3000 : this.#speed, iterations: Infinity });
    if (this.hasAttribute("paused")) this.#loop.pause();
  }
  #stopLoop() {
    this.#loop?.cancel();
    this.#loop = null;
  }

  /** Bring a running spin to rest upright, with a small overshoot. */
  async #settle() {
    const spin = this.$.spin;
    if (!this.#loop) return;
    const cs = getComputedStyle(spin);
    const m = new DOMMatrix(cs.transform === "none" ? undefined : cs.transform);
    const angle = ((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360;
    const scale = Math.hypot(m.a, m.b) || 1;
    const opacity = cs.opacity;
    this.#stopLoop();
    if (this.#reduced) return;
    await done(
      spin.animate(
        [
          { transform: `rotate(${angle}deg) scale(${scale})`, opacity },
          { transform: "rotate(372deg) scale(1)", opacity: 1, offset: 0.7 },
          { transform: "rotate(360deg) scale(1)", opacity: 1 },
        ],
        { duration: 520 + (360 - angle) * 0.6, easing: "cubic-bezier(.25,.8,.35,1)" },
      ),
    );
  }

  #draw(el: SVGPathElement) {
    return done(
      el.animate([{ strokeDashoffset: 1, opacity: 1 }, { strokeDashoffset: 0, opacity: 1 }], {
        duration: this.#reduced ? 1 : 420,
        easing: "cubic-bezier(.65,0,.35,1)",
        fill: "forwards",
        delay: this.#reduced ? 0 : 80,
      }),
    );
  }
  #hideGlyphs() {
    this.#fume.forEach((a) => a.cancel());
    this.#fume = [];
    [this.$.check, this.$.cross, ...this.$.angry.querySelectorAll("*")].forEach((g) =>
      g.getAnimations().forEach((a) => a.cancel()),
    );
  }

  /** The ring becomes a face: eyes pop, brows slam down, frown draws, then it keeps fuming. */
  async #angry(t: number) {
    const a = this.$.angry;
    const [bl, br] = [...a.querySelectorAll<SVGPathElement>(".brow")] as [SVGPathElement, SVGPathElement];
    const eyes = [...a.querySelectorAll<SVGCircleElement>(".eye")];
    const mouth = a.querySelector<SVGPathElement>(".mouth")!;
    const puffs = [...a.querySelectorAll<SVGCircleElement>(".puff")];
    const show = (el: Element, extra: Record<string, string | number> = {}) =>
      el.animate([{ opacity: 1, ...extra }, { opacity: 1, ...extra }], { duration: 1, fill: "forwards" });

    if (this.#reduced) {
      [bl, br, ...eyes].forEach((el) => show(el));
      show(mouth, { strokeDashoffset: 0 });
      return;
    }

    eyes.forEach((e, i) =>
      e.animate(
        [
          { opacity: 1, transform: "scale(0)" },
          { opacity: 1, transform: "scale(1.3)", offset: 0.6 },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 280, delay: 60 + i * 50, easing: "ease-out", fill: "forwards" },
      ),
    );

    const slam = (el: Element, dir: number) =>
      el.animate(
        [
          { opacity: 0, transform: `translateY(-28px) rotate(${dir * 16}deg)` },
          { opacity: 1, transform: `translateY(5px) rotate(${-dir * 5}deg)`, offset: 0.7 },
          { opacity: 1, transform: "none" },
        ],
        { duration: 340, delay: 200, easing: "cubic-bezier(.3,1.3,.5,1)", fill: "forwards" },
      );
    slam(bl, 1);
    const last = slam(br, -1);

    mouth.animate([{ opacity: 1, strokeDashoffset: 1 }, { opacity: 1, strokeDashoffset: 0 }], {
      duration: 320,
      delay: 300,
      easing: "cubic-bezier(.65,0,.35,1)",
      fill: "forwards",
    });

    await done(last);
    if (t !== this.#token) return;

    // Fuming loop: brows twitch, the mark trembles, steam puffs rise.
    const twitch = (dir: number): Keyframe[] => [
      { transform: "none", offset: 0 },
      { transform: `translateY(4px) rotate(${-dir * 7}deg)`, offset: 0.05 },
      { transform: "translateY(-1px)", offset: 0.1 },
      { transform: `translateY(4px) rotate(${-dir * 7}deg)`, offset: 0.15 },
      { transform: "none", offset: 0.24 },
      { transform: "none", offset: 1 },
    ];
    const loop: KeyframeAnimationOptions = { duration: 2600, iterations: Infinity, easing: "ease-in-out" };
    this.#fume.push(bl.animate(twitch(1), loop), br.animate(twitch(-1), loop));
    this.#fume.push(
      this.$.mark.animate(
        ["0", "-3", "3", "-3", "2", "0", "0"].map((x, i, arr) => ({
          transform: `translateX(${x}px)`,
          offset: i === arr.length - 1 ? 1 : i * 0.04,
        })),
        loop,
      ),
    );
    puffs.forEach((p, i) =>
      this.#fume.push(
        p.animate(
          [
            { opacity: 0, transform: "translateY(6px) scale(.3)", offset: 0 },
            { opacity: 0.85, transform: "translateY(-10px) scale(1)", offset: 0.18 },
            { opacity: 0, transform: "translateY(-38px) scale(1.5)", offset: 0.45 },
            { opacity: 0, transform: "translateY(-38px) scale(1.5)", offset: 1 },
          ],
          { duration: 2600, iterations: Infinity, delay: 120 + i * 260, easing: "ease-out" },
        ),
      ),
    );
    if (this.hasAttribute("paused")) this.#fume.forEach((x) => x.pause());
  }

  #startSheen() {
    this.#sheenAnim?.cancel();
    this.#sheenAnim = null;
    if (this.#reduced || this.hasAttribute("no-sheen") || this.state === "error") return;
    this.#sheenAnim = this.$.sheen.animate(
      [
        { transform: "translateX(-160px)", offset: 0, easing: "cubic-bezier(.4,0,.2,1)" },
        { transform: "translateX(340px)", offset: 0.38 },
        { transform: "translateX(340px)", offset: 1 },
      ],
      { duration: 3400, iterations: Infinity },
    );
    if (this.hasAttribute("paused")) this.#sheenAnim.pause();
  }

  #emit(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }
}

if (!customElements.get("vector-spinner")) customElements.define("vector-spinner", VectorSpinner);
