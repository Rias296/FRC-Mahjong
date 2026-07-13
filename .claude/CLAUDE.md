# CLAUDE.md — Taiwan Mahjong FRC

## What this is
Taiwanese (16-tile) mahjong web app, FRC-robotics themed skin. Next.js 16 + TypeScript strict + Tailwind v4 + shadcn/ui. Turso (libSQL) for persistence, additive-only migrations. Realtime multiplayer.

## Agent loop
planner (fable) → builder (sonnet) → tester (sonnet) → reviewer (sonnet). No commit until reviewer verdict is SHIP. When delegating, pass `model` explicitly on the Agent call — do not rely on frontmatter alone (known Claude Code bug: frontmatter model can be ignored and the subagent inherits the parent model).

## Architecture invariants
- `src/engine/` — pure TS game engine. No React, no fetch, no env access. State in → state out. Fully unit-testable.
- `src/server/` — API routes, Turso access, realtime sync. Engine is the only source of rule truth; server validates every client action through it.
- `src/app/` + `src/components/` — UI only. shadcn/ui first; never hand-roll what shadcn provides.
- `src/lib/theme/frc.ts` — FRC terminology skin (display-name map). Engine/DB/wire protocol use canonical terms only: tile, pung, kong, chow, hu, tai, flower.
- Rule truth lives in `docs/RULES.md`; rule toggles in `src/engine/rules-config.ts`.

## Conventions (reviewer enforces these)
- TypeScript strict, no `any`, no unexplained `@ts-ignore`.
- Tailwind v4 CSS-first config (`@theme`); no v3 `tailwind.config.js` patterns.
- Additive-only DB migrations; never edit an applied migration.
- Server is authoritative — clients send intents, never state.
- Every engine change ships with pure unit tests in the same PR.
- i18n-ready strings (en + zh-Hant planned); no hardcoded user-facing strings in components.
- Use graphify skill for token-efficient codebase context; ui-ux-pro-max skill for any visual/UX work; shadcn skill for component work.

## Commands
- `npm run dev` / `npm run build` / `npm run test` / `npm run lint`
- `npx tsc --noEmit` after every change chunk