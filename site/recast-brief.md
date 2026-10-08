# Recast brief — Headless UI homepage → barua.app

Mode: **Recast** (new topic, borrow the craft). The reference sells a component
library; we sell a database. Section rhythm, technique inventory and caliber are
preserved; the catalog-of-components anatomy is retargeted to a catalog of
capabilities, which is the same job: "here is the surface area, each tile shows
you the thing itself."

## 1 · Technique Inventory (ranked by how much it defines the site)

| # | Technique | Where | Params from the markup | Load-bearing? |
|---|---|---|---|---|
| 1 | **Preview tile grid** — `h-64` cells, `bg-white/4` → hover `bg-white/6`, each containing a miniature of the real UI at `text-[0.6875rem]/6`, label below in `text-sm font-semibold` | both grids | `gap-x-8 gap-y-14`, 1/2/3 cols | **Signature.** The whole page is this move |
| 2 | **Radial-glow behind tile content** — `absolute inset-[35%] rounded-full bg-white/15 blur-2xl` | every tile | inset 35%, blur-2xl | Load-bearing (gives the dark tiles depth) |
| 3 | **Grid rule system** — vertical: 3 × `flex-1 border-x border-white/7.5` with `gap-[14px]`, `z-10`, pointer-events-none, full page height; horizontal: an absolutely-positioned mirror grid of `h-64` cells with `border-y` + `-inset-y-[calc(0.5rem+1px)]` | whole page | white/7.5, responsive hiding at sm/lg | Load-bearing (the architectural signature) |
| 4 | **Layered ambient background** — bg-top image, bg-bottom image with `mix-blend-screen`, noise at `opacity-10`, all `-z-10`, responsive `bg-position` 35%→44% | page | three stacked layers | Load-bearing (the atmosphere) |
| 5 | **Inset rounded main panel** — `rounded-[2.5rem] bg-black/80` over the background | main | 2.5rem | Load-bearing |
| 6 | **Accessible dropdown menu** (Headless UI Menu) — version selector, `aria-haspopup=menu`, `aria-expanded`, `data-headlessui-state` | header | rounded-2xl, bg-white/10, backdrop-blur | Real interaction |
| 7 | **Segmented pill switch** — React (active, `bg-white/10`) / Vue (inactive, hover lightens) | above grid 1 | rounded-full pills | Real interaction |
| 8 | **Hover + focus choreography** — `transition-colors` on tile bg; `group-focus-visible:ring-1 ring-white` | every tile | — | Required (absence = slop) |
| 9 | **Mono uppercase section heading** — `font-mono text-xs font-semibold tracking-widest uppercase text-white/50` | between grids | — | Rhythm marker |
| 10 | **Centred minimal footer** | end | `py-12 text-sm/6` | Rhythm marker |

The reference's motion is deliberately restrained (hover transitions only). Per
`motion.md` the recast installs the full duration/easing scale, load
choreography and scroll reveals — elevating without betraying the register.

## 2 · Structure Blueprint (reproduced 1:1 in order)

1. **Header** — logo left, control (menu) beside it, repo link right. `max-w-7xl`, `py-6`.
2. **Ambient layers + grid rules** — behind everything, full height.
3. **Hero band** — `border-t border-white/7.5`, `py-16 lg:py-24`, one balanced `h1` at `clamp(2rem,3.75vw,3rem)/tight`, nothing else. No subhead, no buttons in the reference → ours adds only the one CTA pair the topic requires.
4. **main** `rounded-[2.5rem] bg-black/80`
   - 4a. **Pill switch row** (`py-8`)
   - 4b. **Grid 1** — 6 preview tiles
   - 4c. **Mono section heading**
   - 4d. **Grid 2** — reference has 10; ours has 6 + a 3-tile limits band to hold density
5. **Footer** — centred, one line.

## 3 · Motion Spec

- Reference: `transition-colors` on tiles (~150ms default), `transition` on menu button, nothing on scroll, no load choreography.
- Recast installs (from `motion.md`): `--dur-1..7` / `--ease-quad|cubic|quart|out`; load stagger `--d0..d4` on header → h1 → CTA → first grid; `[data-reveal]` IntersectionObserver at `threshold .15, rootMargin 0 0 -10% 0`; hover on `--dur-2`/`--ease-quad`.
- Reduced motion: duration scale zeroes, load animation off, state-cycling mocks freeze on their first frame, sparkline renders drawn, count-ups render final value.

## 4 · Content Map

- **h1**: one sentence, 14–20 words, balanced, product-defining, no subhead. Reference: "Completely unstyled, fully accessible UI components, designed to integrate beautifully with Tailwind CSS."
- **Tile label**: 1–3 words, the thing's name. **Tile caption** (ours, reference has none): one sentence of concrete mechanism.
- **Voice**: flat, technical, zero hype. Claims are mechanical facts, not benefits. Numbers where we have measured them.
- **CTA verbs**: "Open console", "Create a database", "Read the source".

## 5 · Palette / Type

| Role | Reference | Recast |
|---|---|---|
| Page | `#000` | `#000` |
| Panel | `bg-black/80` | same |
| Surface | `white/4` → `white/6` | same |
| Rules | `white/7.5` | same |
| Accent | sky-300 `#7dd3fc` (logo) | brand `#186F70`, lifted accent `#26B2B3` |
| Glow | `white/15` | `accent/18` (same register, our hue) |
| Text | white, white/50 | white, white/55, white/35 |
| Type | Inter (rsms.me), semibold headings, mono eyebrow | Outfit 400/500/600, same roles, ui-monospace for data |
