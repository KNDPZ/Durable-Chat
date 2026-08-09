// room-do.mjs — per-room messages: reply, reactions, edit, delete, forward metadata
const REACTIONS = ["👍", "👎", "❤️", "😂", "😢", "😠", "🖕"];

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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          reply_to_id TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          edited_at TEXT,
          forwarded_from_room_id TEXT,
          forwarded_from_message_id TEXT,
          forwarded_from_room_name TEXT,
          forwarded_from_username TEXT
        );
        CREATE TABLE IF NOT EXISTS reactions (
          message_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          emoji TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (message_id, user_id, emoji)
        );
        CREATE TABLE IF NOT EXISTS edit_history (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          previous_text TEXT NOT NULL,
          edited_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (const col of [
        "ALTER TABLE messages ADD COLUMN reply_to_id TEXT",
        "ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN edited_at TEXT",
        "ALTER TABLE messages ADD COLUMN forwarded_from_room_id TEXT",
        "ALTER TABLE messages ADD COLUMN forwarded_from_message_id TEXT",
        "ALTER TABLE messages ADD COLUMN forwarded_from_room_name TEXT",
        "ALTER TABLE messages ADD COLUMN forwarded_from_username TEXT",
      ]) {
        try { this.state.storage.sql.exec(col); } catch {}
      }
    });
  }

  sql(q, ...binds) { return this.state.storage.sql.exec(q, ...binds); }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }

  getReactions(messageId) {
    const rows = this.sql(
      "SELECT user_id, username, emoji FROM reactions WHERE message_id = ? ORDER BY created_at",
      messageId
    ).toArray();
    const byEmoji = {};
    for (const r of rows) {
      if (!byEmoji[r.emoji]) byEmoji[r.emoji] = [];
      byEmoji[r.emoji].push({ userId: r.user_id, username: r.username });
    }
    return byEmoji;
  }

  shapeMessage(r) {
    if (!r) return null;
    const isDeleted = !!r.is_deleted;
    const msg = {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      text: isDeleted ? "" : r.text,
      createdAt: r.created_at,
      isDeleted,
      editedAt: r.edited_at || null,
      replyToId: r.reply_to_id || null,
      reactions: this.getReactions(r.id),
      forward: r.forwarded_from_room_id
        ? {
            roomId: r.forwarded_from_room_id,
            messageId: r.forwarded_from_message_id,
            roomName: r.forwarded_from_room_name,
            username: r.forwarded_from_username,
          }
        : null,
    };
    if (r.reply_to_id && !isDeleted) {
      const parent = this.sql(
        "SELECT id, user_id, username, text, is_deleted FROM messages WHERE id = ?",
        r.reply_to_id
      ).toArray()[0];
      if (parent) {
        msg.replyTo = {
          id: parent.id,
          userId: parent.user_id,
          username: parent.username,
          text: parent.is_deleted ? "[deleted]" : String(parent.text || "").slice(0, 120),
        };
      }
    }
    return msg;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[parts.length - 1];
    const method = request.method;
    const body =
      method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE"
        ? await request.json().catch(() => ({}))
        : {};

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (action === "messages" && method === "GET" && parts.length === 1) {
      const limit = Math.min(300, Number(url.searchParams.get("limit")) || 150);
      const rows = this.sql("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?", limit).toArray().reverse();
      const pinned = (await this.state.storage.get("pinned")) || null;
      return json({ messages: rows.map((r) => this.shapeMessage(r)), pinned });
    }

    if (action === "messages" && method === "POST" && parts.length === 1) {
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!body.userId || !body.username) return json({ error: "Missing user" }, 400);
      if (!text && !body.forward) return json({ error: "Empty message" }, 400);
      const id = crypto.randomUUID();
      this.sql(
        `INSERT INTO messages (id, user_id, username, text, reply_to_id,
          forwarded_from_room_id, forwarded_from_message_id, forwarded_from_room_name, forwarded_from_username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, body.userId, body.username,
        text || (body.forward ? (body.forward.text || "") : ""),
        body.replyToId || null,
        body.forward?.roomId || null,
        body.forward?.messageId || null,
        body.forward?.roomName || null,
        body.forward?.username || null
      );
      if (body.forward?.reactions && typeof body.forward.reactions === "object") {
        for (const [emoji, users] of Object.entries(body.forward.reactions)) {
          if (!REACTIONS.includes(emoji)) continue;
          for (const u of users || []) {
            try {
              this.sql(
                "INSERT OR IGNORE INTO reactions (message_id, user_id, username, emoji) VALUES (?, ?, ?, ?)",
                id, u.userId || "fwd", u.username || "?", emoji
              );
            } catch {}
          }
        }
      }
      const msg = this.shapeMessage(this.sql("SELECT * FROM messages WHERE id = ?", id).toArray()[0]);
      this.broadcast({ t: "message", message: msg });
      return json(msg);
    }

    // /messages/:id
    if (parts[0] === "messages" && parts.length >= 2) {
      const msgId = parts[1];
      const sub = parts[2];

      if (method === "GET" && !sub) {
        const row = this.sql("SELECT * FROM messages WHERE id = ?", msgId).toArray()[0];
        if (!row) return json({ error: "Not found" }, 404);
        return json(this.shapeMessage(row));
      }

      if (method === "PATCH" && !sub) {
        const row = this.sql("SELECT * FROM messages WHERE id = ?", msgId).toArray()[0];
        if (!row) return json({ error: "Not found" }, 404);
        if (row.is_deleted) return json({ error: "Message deleted" }, 400);
        if (row.user_id !== body.userId) return json({ error: "Not your message" }, 403);
        const newText = String(body.text || "").trim().slice(0, 2000);
        if (!newText) return json({ error: "Empty message" }, 400);
        this.sql(
          "INSERT INTO edit_history (id, message_id, previous_text) VALUES (?, ?, ?)",
          crypto.randomUUID(), msgId, row.text
        );
        this.sql("UPDATE messages SET text = ?, edited_at = datetime('now') WHERE id = ?", newText, msgId);
        const msg = this.shapeMessage(this.sql("SELECT * FROM messages WHERE id = ?", msgId).toArray()[0]);
        this.broadcast({ t: "message_update", message: msg });
        return json(msg);
      }

      if (method === "DELETE" && !sub) {
        const row = this.sql("SELECT * FROM messages WHERE id = ?", msgId).toArray()[0];
        if (!row) return json({ error: "Not found" }, 404);
        if (row.user_id !== body.userId && !body.isAdmin) return json({ error: "Not your message" }, 403);
        this.sql("UPDATE messages SET is_deleted = 1, text = '' WHERE id = ?", msgId);
        // Auto-remove pin if this message was pinned
        const pinned = (await this.state.storage.get("pinned")) || null;
        if (pinned && String(pinned.id) === String(msgId)) {
          await this.state.storage.delete("pinned");
          this.broadcast({ t: "pin", pinned: null });
        }
        const msg = this.shapeMessage(this.sql("SELECT * FROM messages WHERE id = ?", msgId).toArray()[0]);
        this.broadcast({ t: "message_update", message: msg });
        return json(msg);
      }

      if (sub === "react" && method === "POST") {
        const emoji = body.emoji;
        if (!REACTIONS.includes(emoji)) return json({ error: "Invalid reaction" }, 400);
        if (!body.userId) return json({ error: "Missing user" }, 400);
        const existing = this.sql(
          "SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
          msgId, body.userId, emoji
        ).toArray()[0];
        if (existing) {
          this.sql("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", msgId, body.userId, emoji);
        } else {
          this.sql(
            "INSERT OR IGNORE INTO reactions (message_id, user_id, username, emoji) VALUES (?, ?, ?, ?)",
            msgId, body.userId, body.username || "?", emoji
          );
        }
        const msg = this.shapeMessage(this.sql("SELECT * FROM messages WHERE id = ?", msgId).toArray()[0]);
        this.broadcast({ t: "message_update", message: msg });
        return json(msg);
      }

      if (sub === "history" && method === "GET") {
        const rows = this.sql(
          "SELECT previous_text, edited_at FROM edit_history WHERE message_id = ? ORDER BY edited_at ASC",
          msgId
        ).toArray();
        return json(rows.map((r) => ({ text: r.previous_text, editedAt: r.edited_at })));
      }
    }

    // Purge all messages when room is deleted / empty
    if (action === "purge" && method === "POST") {
      try { this.sql("DELETE FROM reactions"); } catch {}
      try { this.sql("DELETE FROM edit_history"); } catch {}
      try { this.sql("DELETE FROM messages"); } catch {}
      try { await this.state.storage.delete("pinned"); } catch {}
      // Clear any other storage keys
      const keys = await this.state.storage.list();
      for (const k of keys.keys()) {
        try { await this.state.storage.delete(k); } catch {}
      }
      return json({ ok: true, purged: true });
    }

    // Pin / unpin (creator or admin via body)
    if (action === "pin" && method === "POST") {
      const msgId = body.messageId || null;
      if (msgId) {
        const row = this.sql("SELECT id, text, is_deleted, username FROM messages WHERE id = ?", msgId).toArray()[0];
        if (!row || row.is_deleted) return json({ error: "Message not found" }, 404);
        await this.state.storage.put("pinned", {
          id: row.id,
          text: String(row.text || "").slice(0, 200),
          username: row.username,
        });
      } else {
        await this.state.storage.delete("pinned");
      }
      const pinned = (await this.state.storage.get("pinned")) || null;
      this.broadcast({ t: "pin", pinned });
      return json({ pinned });
    }
    if (action === "pin" && method === "GET") {
      return json({ pinned: (await this.state.storage.get("pinned")) || null });
    }

    return json({ error: "unknown" }, 404);
  }

  async webSocketMessage() {}
  async webSocketClose() {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
