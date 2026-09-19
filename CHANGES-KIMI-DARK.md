# Kimi Dark theme — applied to Agent Miki frontend

Applied the "Kimi Dark" theme spec to `packages/ui/frontend` and
`packages/ui/appearance.css`. Verified with a real `pnpm install` +
`vite build` + `tsc -b` inside `packages/ui/frontend` — all three passed
clean (build output not included in this zip; run `pnpm install` yourself
before `pnpm dev` / `pnpm build`).

## Files changed

- `packages/ui/frontend/src/theme/material-theme.css` — full palette swap
- `packages/ui/frontend/src/index.css` — status colors, card radius, global shadow tokens
- `packages/ui/frontend/src/shared/ui/button.tsx` — pill shape + glow
- `packages/ui/frontend/src/shared/ui/input.tsx` — pill shape + glow focus ring
- `packages/ui/appearance.css` — dark-mode chat bubble/alert colors re-tinted to blue

## 1. `theme/material-theme.css`

Old theme was "Premium Monochrome Dark Aesthetic": near-black
(`#111111`/`#181818`/`#202020`), orange accent (`#FF9500`), sharp
8px-max radii. Replaced with the Kimi Dark spec:

| token | old | new |
|---|---|---|
| `--md-sys-color-background` | `#111111` | `#121212` |
| `--md-sys-color-surface` | `#181818` | `#1A1A1A` |
| `--md-sys-color-surface-variant` | `#202020` | `#2C2C2C` |
| `--md-sys-color-primary` (accent) | `#FF9500` | `#4A9EFF` |
| `--md-sys-color-error` | `#F87171` | `#FF5252` |

New tokens added (not in base Material Design 3, used by the utilities
below): `--md-sys-color-surface-elevated` (`#333333`, spec's
`--bg-elevated`), `--md-sys-color-border-strong`,
`--md-sys-color-primary-hover` / `-pressed` / `-glow`,
`--md-sys-color-success` (`#4CAF50`), `--md-sys-color-warning`
(`#FFC107`), `--md-sys-glass-bg` / `-border` / `-blur`,
`--md-sys-radius-pill`, `--md-sys-elevation-glow`.

Typography scale rewritten to the spec's sizes (Display 32/40 700 → H1
28/36 600 → H2 24/32 600 → H3 20/28 500 → Body 16/24 400 → Body Small
14/20 400 → Caption 12/16 500 → Button 14/20 500 + 0.5px tracking via
new `.type-button` utility). Radius scale rebuilt for the pill look
(`sm:8 md:12 lg:16 xl:20 2xl:24 full:9999`). Motion unified onto the
spec's single easing curve `cubic-bezier(0.4,0,0.2,1)` (durations were
already 150/250/350ms — untouched).

New utility classes: `.glass` / `.glass-card` (backdrop-filter blur(20px)
saturate(180%)), `.glow-accent`, `.gradient-fade-bottom`,
`.gradient-radial-glow`, `.touch-target-min` (44×44px), `.radius-pill`.

**Not changed:** the spacing scale (4px base) — it's already a superset
of the spec's 8px grid (8/16/24/32/48/64 all present), so no edit was
needed there.

## 2. `index.css`

- `--success` / `--warning` (both `:root` and `.dark`): `#FFB45C` /
  `#b8b8b8` → `#4CAF50` / `#FFC107` (spec's exact status colors)
- `--radius`: `0.375rem` (6px) → `1rem` (16px) — this is the base every
  `rounded-md/lg/xl/2xl` Tailwind class derives from, so cards, dialogs,
  and popovers across the app now use the spec's 16px card radius
  without touching each component
- Added `--shadow-2xs` through `--shadow-2xl` to the `@theme inline`
  block, using the spec's exact sm/md/lg values (`0 2px 8px`, `0 4px
  16px`, `0 8px 32px` at rising opacity). **~47 files already use
  Tailwind's `shadow-*` utilities** — none needed editing; they all
  pick up the new depth automatically.

## 3. `shared/ui/button.tsx`

- Base shape: `rounded-md` → `rounded-full` (pill, spec 3.1). Removed
  the per-size radius overrides on `xs`/`sm`/`icon-xs`/`icon-sm` that
  would otherwise have won over the new pill shape and kept those
  sizes square-ish.
- Default (primary) variant: added a blue glow on hover
  (`hover:shadow-[...var(--md-sys-color-primary-glow)]`) plus explicit
  hover/pressed background swaps to `--md-sys-color-primary-hover` /
  `-pressed`, matching the spec's `#6BB3FF` / `#3D8BEF` states.
  `active:scale-[0.98]` added (spec's pressed state).
  Transition timing moved to the spec's 150ms micro-interaction speed
  and easing curve.
- Left the `in-data-[slot=button-group]:rounded-md` override alone —
  buttons inside a segmented button-group intentionally stay
  square-ish there, that's a different UI pattern than a standalone
  pill button.

## 4. `shared/ui/input.tsx`

- Radius: `var(--md-sys-radius-sm)` → `var(--md-sys-radius-pill)`
  (spec 3.3, pill input).
- Focus state: swapped the hard 2px outline for a soft glow ring
  (`box-shadow: 0 0 0 4px var(--md-sys-color-primary-glow)`), matching
  every other focus/hover glow in this theme.
- Padding bumped `px-3` → `px-4` to suit the pill shape better; height
  (`h-10`) left as-is since changing it risks breaking layouts I can't
  see rendered (no browser in this sandbox — see note below).

## 5. `packages/ui/appearance.css` (the manual theme switchboard)

Only the `html.dark` block was touched — the file's own header says
this is "the single manual switchboard for the whole web UI's theme,"
and most of its Bar/Button/Text sections already reference the core
tokens above, so they re-themed automatically. The one part that
didn't was the chat bubbles, which were hardcoded to an unrelated
lime-green accent (`#bef264`) left over from an earlier theme:

- User bubble: now a translucent blue tint derived from the new accent
  (`color-mix(in srgb, var(--primary) 20%, var(--card))`) instead of
  solid lime — it'll always match whatever `--primary` is, rather than
  needing to be hand-updated again next time the accent changes.
- Assistant bubble: plain `var(--card)` (`#1A1A1A`).
- Error/alert colors: now reference the error-container tokens from
  `material-theme.css` instead of their own separate hardcoded hex.

**Left untouched:** the light-mode (`:root`) block. "Kimi Dark" is a
dark theme by name and by spec; your existing light theme has its own
established "warm workspace" identity that this spec doesn't speak to,
so I didn't overwrite it. Say the word if you want a light companion
theme derived from the spec's light-mode override table (spec section
1) instead.

## What I couldn't verify

No browser in this sandbox, so I validated with `vite build` (clean)
and `tsc -b` (clean) rather than eyes-on-screen — the same limitation
you flagged in your notes. If a specific screen looks off once you run
it, tell me which one and I'll fix it directly rather than guessing at
more screens blind.

## Still pending from your notes (not touched this pass)

- `assistant-message.tsx` bubble error-styling markup — you said to
  hold this one; ping me when you want it done.
- Rebuild + runtime test on your machine (I ran the frontend build/
  typecheck here, but not the full monorepo backend or a real runtime
  smoke test).
