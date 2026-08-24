# BACKROOMS: MEMORY BLEED — autonomous agent contract

This file is the execution authority for agents working in this repository.
`README.md` and `docs/` carry the project truth; this file defines how
autonomous work is selected, executed, and verified here.

## What this is

A browser-native, PC-quality first-person horror game: TypeScript, Vite,
Babylon.js (WebGPU-first, WebGL fallback). All assets are procedural at boot —
there are no binary asset pipelines. The Backrooms does not store human
memories; it replays them with errors, and the errors are load-bearing now.

This tree is a RECONSTRUCTED repo (see `RECOVERY-NOTES.md`: source harvested
from session transcripts). Treat oddities as archaeology, not architecture:
prefer reading `docs/integration-status.md` before trusting that a module is
wired into the main loop.

## Commands (pnpm)

```bash
pnpm install
pnpm run dev         # http://127.0.0.1:5178 (--strictPort)
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsc --noEmit && vite build -> dist/
pnpm run preview     # serve dist/ at http://127.0.0.1:4178
```

There is NO test script. The verification ladder is:
`typecheck green` → `build green` → dev-server boots without console errors →
in-browser playtest evidence (screenshots) for anything visual.

Note: the tree carries an npm `package-lock.json`; pnpm is still the intended
manager per README. Do not delete or "fix" lockfiles as drive-by work.

## Truth surface

- `README.md` — pitch, controls, run instructions.
- `docs/DESIGN.md` — design canon.
- `docs/integration-plan.md` / `docs/integration-status.md` — what is wired
  into `src/core/game.ts` vs merely exported. Status doc beats optimism.
- `RECOVERY-NOTES.md` — provenance of every reconstructed file.

## Working rules

1. Recover state first: read this file, `docs/integration-status.md`, then
   `git log --oneline -10` and `git status`. Dirty trees are normal here —
   identify what the dirt IS before building on it.
2. Small verified increments only. Never claim success without exact evidence
   (command output, file path, screenshot path).
3. New gameplay code belongs under `src/{audio,entities,gfx,ui,world,story}`
   and only counts as integrated when `src/core/game.ts` actually reaches it.
4. Persist durable facts (decisions, SHAs, blockers, evidence paths) to the
   rig's MCP memory (`rig/*`) and to `docs/integration-status.md`.
5. If blocked, record the exact blocker and move to the next useful outcome.
   Never fabricate external evidence; never idle.
