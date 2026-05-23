# checkers

A multiplayer game on ProGameStore.

- Subdomain: `checkers.progamestore.online`
- Dev: `pnpm install && pnpm dev`
- Build: `pnpm build`
- Deploy: `wrangler deploy` (Workers, not Pages -- needed for Durable Objects)

For platform conventions, read
https://progamestore.online/skills.md
before writing or changing anything.

## Architecture

This is a **turn-based multiplayer** game with server-authoritative state:

- `src/worker.ts` -- Cloudflare Worker + Durable Object (`GameDO`)
- `web/` -- React SPA using `@progamestore/games` SDK
- `wrangler.jsonc` -- Worker config with DO bindings

The Worker validates every move server-side. Clients connect via WebSocket
through the `useRooms()` hook. The DO class manages game state and broadcasts
updates to all connected players.

## Key files

- `src/worker.ts` -- Worker routes + GameDO class. Add your game logic here.
- `web/src/App.tsx` -- React entry point with GameShell + useRooms.
- `wrangler.jsonc` -- Worker + DO config.
