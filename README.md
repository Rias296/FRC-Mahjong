# Taiwan Mahjong FRC

A Taiwanese (16-tile) mahjong web app with an FRC-robotics-themed skin. Realtime multiplayer, 4 players per match.

- **Engine** (`src/engine/`) — pure TypeScript rule implementation. Rule spec lives in `docs/RULES.md` (not committed — ask the project owner for a copy if you don't have one), rule toggles in `src/engine/rules-config.ts`.
- **Server** (`src/server/`, `src/app/api/`) — event-sourced persistence on Turso (libSQL): every game is an append-only action log; `GameState` is never stored, only replayed. SSE realtime.
- **UI** (`src/app/`, `src/components/`) — Next.js App Router, shadcn/ui, Tailwind v4.

## ⚠ Tile art licensing — unconfirmed

The pixel-art tile sprites in `public/tiles/` were sourced manually and their license/attribution is **unconfirmed**. They render in every game view. **Do not deploy publicly until this is resolved** — confirm the source/license, or swap in a verified-license alternative. Details and a fallback shortlist are in `docs/ASSETS.md` (ask the project owner for a copy if you don't have the docs vault).

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env.local` and set your database:
   ```
   TURSO_DATABASE_URL=
   TURSO_AUTH_TOKEN=
   ```
   For local development, a file-based libSQL database works without any Turso account — no auth token needed:
   ```
   TURSO_DATABASE_URL=file:./dev-local.db
   ```
   For a real Turso database, get these values from the [Turso dashboard](https://turso.tech) (`turso db show <db-name> --url` and `turso db tokens create <db-name>`).
3. Apply database migrations — **required before first run**, migrations are never applied automatically on server start:
   ```
   npm run db:migrate
   ```
4. Start the dev server:
   ```
   npm run dev
   ```

## Commands

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run test` — run the test suite (vitest)
- `npm run lint` — eslint
- `npx tsc --noEmit` — typecheck
- `npm run db:migrate` — apply any unapplied migrations in `migrations/` (additive-only; safe to re-run)

## Deploying

See the project owner's deployment notes for Vercel + Turso setup. In short: provision a Turso database, set `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` as environment variables on the host, and run `npm run db:migrate` against that database once before the first request (migrations do not run automatically).
