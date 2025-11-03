# Repository Guidelines

## Project Structure & Module Organization
- `frontend/` — Next.js (TypeScript) app. Key paths: `app/`, `components/`, `lib/`, `styles/`.
- `supabase/` — backend assets. `functions/` (Edge Functions), `sql/000_init_oekaki_battle.sql` (DB schema/RLS/RPC/seed).
- `docs/` — requirements, API, DB, and architecture specs kept in sync with code.
- Root configs: `README.md`, netlify and TS configs under `frontend/`.

## Build, Test, and Development Commands
- Frontend
  - `cd frontend && npm i` — install deps.
  - `npm run dev` — start Next.js dev server.
  - `npm run build && npm run start` — production build and serve.
- Supabase
  - Apply DB: run `supabase/sql/000_init_oekaki_battle.sql` on your project.
  - Deploy functions: `supabase functions deploy <name>` (e.g., `create-room`, `start-game`, `advance-round`, `end-game`).

## Coding Style & Naming Conventions
- TypeScript/React with functional components and hooks.
- 2-space indentation, concise props/state names, avoid one-letter vars.
- Keep modules small; colocate helpers in `frontend/lib/`.
- Environment access only via `frontend/lib/env.ts`.
- CSS in `frontend/styles/globals.css`; prefer utility-like small classes.

## Testing Guidelines
- No formal test suite yet. Validate locally:
  - Anonymous auth flows, room create/join, realtime drawing, guesses and scoring.
  - Edge Functions via `supabase.functions.invoke` from the app.
- If adding tests, place unit tests next to modules and keep names `*.test.ts(x)`.

## Commit & Pull Request Guidelines
- Commit messages: short imperative subject, optional scope, e.g. `feat(frontend): lobby join errors in JP`.
- PRs should include:
  - What/why summary, linked issues, and screenshots/GIFs for UI changes.
  - Notes on DB/RPC changes (reference lines in `supabase/sql/000_init_oekaki_battle.sql`).
  - Update `docs/` when behavior/API changes.

## Security & Configuration Tips
- Never commit secrets. Required env vars:
  - Frontend: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
  - Edge Functions: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- All DB access is RLS-scoped; use provided RPCs. Functions require `Authorization: Bearer <JWT>`.

## Agent-Specific Instructions
- Before edits, scan `docs/` to keep documentation aligned.
- Prefer minimal, targeted changes; avoid unrelated refactors.
- For DB changes, modify the single init file and reflect updates in `docs/db/` and `docs/api/`.
