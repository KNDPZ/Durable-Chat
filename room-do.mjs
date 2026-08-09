// room-do.mjs — per-room Chat Durable Object (pattern from Tongits room-do)
// Messages + WebSocket hibernation. Auth/membership checked by Hub before post.

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean).pop();

    // WebSocket upgrade (hibernation)
    if (request.headers.get("Upgrade") === "websocket" || action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (action === "messages" && request.method === "GET") {
      const limit = Math.min(200, Number(url.searchParams.get("limit")) || 100);
      const rows = this.state.storage.sql
        .exec("SELECT id, user_id, username, text, created_at FROM messages ORDER BY created_at DESC LIMIT ?", limit)
        .toArray()
        .reverse();
      return json(rows.map((r) => ({
        id: r.id, userId: r.user_id, username: r.username, text: r.text, createdAt: r.created_at,
      })));
    }

    if (action === "messages" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return json({ error: "Empty message" }, 400);
      if (!body.userId || !body.username) return json({ error: "Missing user" }, 400);
      const id = crypto.randomUUID();
      this.state.storage.sql.exec(
        "INSERT INTO messages (id, user_id, username, text) VALUES (?, ?, ?, ?)",
        id, body.userId, body.username, text
      );
      const msg = { id, userId: body.userId, username: body.username, text, createdAt: new Date().toISOString() };
      // Broadcast to connected sockets
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(JSON.stringify({ t: "message", message: msg })); } catch {}
      }
      return json(msg);
    }

    return json({ error: "unknown" }, 404);
  }

  async webSocketMessage(ws, message) {
    // Client pings / future features
  }

  async webSocketClose() {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
