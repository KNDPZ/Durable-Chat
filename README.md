# Durable Chat

Chat webapp on Cloudflare Workers + Durable Objects, structured like [Tongits Online](https://github.com/): modular Worker, Hub DO, Room DO, static `public/` client.

## Architecture (same pattern as Tongits)

```
browser ─ HTTP /api/*  ──────────┐
        ─ WS  /ws/room/:id ──────┼─▶ Worker ─▶ ChatRoom DO (messages + WS)
        ─ static assets ─────────┘            │
                                   Hub DO ◀── users, rooms meta, contacts, presence
```

| File | Role |
|------|------|
| `worker.mjs` | Routes API → Hub, WS → Room, serves static assets |
| `hub-do.mjs` | Global Hub: auth (TOTP), users, rooms metadata, contacts, admin, presence |
| `room-do.mjs` | Per-room messages + WebSocket hibernation |
| `totp.mjs` | RFC 6238 TOTP helpers |
| `public/` | Client (index.html + app.js) |
| `wrangler.toml` | DO bindings + static assets + migrations |

## Features

- Username + TOTP registration (QR for Authenticator apps)
- Public / registered-only / private rooms
- Private room members, invite degree (contacts / contacts-of-contacts / all)
- Contacts + friends, Message / Remove
- Online green dots, admin Online / All users / Admins panels
- Account recovery & promote/demote (admin)
- Creator can delete their rooms

## Deploy

```bash
npm install
npx wrangler login
npm run deploy
```

Username `admin` is always admin after first registration/login.
