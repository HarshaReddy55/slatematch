# SlateMatch web (React migration)

React + TypeScript + Tailwind + Motion frontend, built with Vite.
Stage 0 of the staged migration (see
`~/workspace/goals/slatematch-standalone-deployment/files/REACT_MIGRATION_PLAN.md`
for the full plan; in the repo, this file's history is the record).

- `npm ci` then `npm run build` outputs the bundle to `../frontend/react/`,
  which the existing FastAPI StaticFiles mount serves at `/react/`.
- In Docker, the build runs in the `web-builder` stage; no local build
  output needs to be committed.
- Tailwind is utilities-only (no preflight) while the vanilla and React
  stacks coexist. Tokens in `src/index.css` mirror `frontend/css/livecube.css`.
