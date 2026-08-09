// hub-do.mjs — global Hub Durable Object (like Tongits Lobby)
// Users, sessions, contacts, blocks, room metadata, presence, admin.
// SQLite-backed. Pattern borrowed from lobby-do.mjs.

import { generateSecret, otpauthUrl, verifyTOTP } from "./totp.mjs";

const ONLINE_MS = 2 * 60 * 1000;

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          totp_secret TEXT NOT NULL,
          is_admin INTEGER NOT NULL DEFAULT 0,
          last_seen TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rooms (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          visibility TEXT NOT NULL,
          created_by TEXT NOT NULL,
          allow_members_invite INTEGER NOT NULL DEFAULT 0,
          invite_degree TEXT NOT NULL DEFAULT 'contacts',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS room_members (
          room_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          added_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS contacts (
          owner_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (owner_id, contact_id)
        );
        CREATE TABLE IF NOT EXISTS blocks (
          blocker_id TEXT NOT NULL,
          blocked_id TEXT NOT NULL,
          PRIMARY KEY (blocker_id, blocked_id)
        );
        CREATE TABLE IF NOT EXISTS message_log (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_msg_user ON message_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_last_seen ON users(last_seen);
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY,
          reporter_id TEXT NOT NULL,
          reported_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved INTEGER NOT NULL DEFAULT 0
        );
      `);
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN last_seen TEXT"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN allow_members_invite INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN invite_degree TEXT NOT NULL DEFAULT 'contacts'"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN restriction_level INTEGER NOT NULL DEFAULT 0"); } catch {}
      this.state.storage.sql.exec("UPDATE users SET is_admin = 1 WHERE username = 'admin'");
    });
  }

  sql(q, ...binds) { return this.state.storage.sql.exec(q, ...binds); }

  toUser(r) {
    if (!r) return null;
    const online = r.last_seen ? Date.now() - new Date(r.last_seen).getTime() < ONLINE_MS : false;
    return {
      id: r.id,
      username: r.username,
      createdAt: r.created_at,
      isAdmin: !!r.is_admin,
      isPrimaryAdmin: r.username === "admin",
      online,
      restrictionLevel: r.restriction_level | 0,
    };
  }

  toRoom(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, visibility: r.visibility, createdBy: r.created_by,
      createdAt: r.created_at, allowMembersInvite: !!r.allow_members_invite,
      inviteDegree: r.invite_degree || "contacts",
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const body = method === "POST" || method === "PATCH" ? await request.json().catch(() => ({})) : {};
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || null;
    const me = await this.userByToken(token);

    try {
      // Presence
      if (path === "/presence/heartbeat" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        this.sql("UPDATE users SET last_seen = datetime('now') WHERE id = ?", me.id);
        return j({ ok: true });
      }

      // Auth
      if (path === "/auth/check-username" && method === "POST") {
        const clean = String(body.username || "").trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(clean)) return j({ available: false });
        const row = this.sql("SELECT 1 FROM users WHERE username = ?", clean).toArray()[0];
        return j({ available: !row });
      }
      if (path === "/auth/start-register" && method === "POST") {
        const clean = String(body.username || "").trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(clean)) return jerr("Username must be 3-20 chars (a-z, 0-9, _)");
        if (this.sql("SELECT 1 FROM users WHERE username = ?", clean).toArray()[0]) return jerr("Username already taken");
        const secret = generateSecret();
        return j({ secret, otpauthUrl: otpauthUrl(clean, secret) });
      }
      if (path === "/auth/complete-register" && method === "POST") {
        const clean = String(body.username || "").trim().toLowerCase();
        const secretNorm = String(body.secret || "").replace(/[\s=]+/g, "").toUpperCase();
        if (!(await verifyTOTP(secretNorm, body.code))) return jerr("Invalid verification code");
        if (this.sql("SELECT 1 FROM users WHERE username = ?", clean).toArray()[0]) return jerr("Username already taken");
        const id = crypto.randomUUID();
        const isAdmin = clean === "admin" ? 1 : 0;
        this.sql("INSERT INTO users (id, username, totp_secret, is_admin, last_seen) VALUES (?, ?, ?, ?, datetime('now'))", id, clean, secretNorm, isAdmin);
        const sess = this.createSession(id);
        return j({ user: { id, username: clean, createdAt: new Date().toISOString(), isAdmin: !!isAdmin, online: true }, token: sess });
      }
      if (path === "/auth/login" && method === "POST") {
        const clean = String(body.username || "").trim().toLowerCase();
        const row = this.sql("SELECT * FROM users WHERE username = ?", clean).toArray()[0];
        if (!row) return jerr("User not found");
        if (!(await verifyTOTP(row.totp_secret, body.code))) return jerr("Invalid code");
        if (clean === "admin" && !row.is_admin) this.sql("UPDATE users SET is_admin = 1 WHERE id = ?", row.id);
        this.sql("UPDATE users SET last_seen = datetime('now') WHERE id = ?", row.id);
        return j({ user: this.toUser({ ...row, last_seen: new Date().toISOString(), is_admin: clean === "admin" ? 1 : row.is_admin }), token: this.createSession(row.id) });
      }
      if (path === "/auth/me" && method === "GET") return j({ user: me });
      if (path === "/auth/logout" && method === "POST") {
        if (token) this.sql("DELETE FROM sessions WHERE token = ?", token);
        return j({ ok: true });
      }

      // Rooms list / create
      if (path === "/rooms" && method === "GET") {
        const pub = this.sql("SELECT * FROM rooms WHERE visibility IN ('public','registered') ORDER BY created_at DESC").toArray().map((r) => this.toRoom(r));
        let priv = [];
        if (me) {
          priv = this.sql(
            `SELECT DISTINCT r.* FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id
             WHERE r.visibility = 'private' AND (r.created_by = ? OR m.user_id = ?) ORDER BY r.created_at DESC`,
            me.id, me.id
          ).toArray().map((r) => this.toRoom(r));
        }
        return j({ public: pub, private: priv });
      }
      if (path === "/rooms" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        return j(this.createRoom(body, me));
      }

      // Delete room
      const delRoom = path.match(/^\/rooms\/([^/]+)$/);
      if (delRoom && method === "DELETE") {
        if (!me) return jerr("Login required", 401);
        return j(this.deleteRoom(delRoom[1], me));
      }

      // Room members
      const membersPath = path.match(/^\/rooms\/([^/]+)\/members$/);
      if (membersPath) {
        const roomId = membersPath[1];
        if (method === "GET") {
          if (!me) return jerr("Login required", 401);
          const room = this.getRoom(roomId);
          if (!room) return jerr("Room not found", 404);
          if (room.visibility === "private" && !this.isMember(roomId, me.id) && !me.isAdmin) return jerr("Not a member", 403);
          return j(this.listMembers(roomId));
        }
        if (method === "POST") {
          if (!me) return jerr("Login required", 401);
          return j(this.addMember(roomId, me.id, body.userId));
        }
      }
      const rmMember = path.match(/^\/rooms\/([^/]+)\/members\/([^/]+)$/);
      if (rmMember && method === "DELETE") {
        if (!me) return jerr("Login required", 401);
        return j(this.removeMember(rmMember[1], me.id, rmMember[2]));
      }

      // Room meta (for messages proxy)
      const roomMeta = path.match(/^\/rooms\/([^/]+)\/meta$/);
      if (roomMeta && method === "GET") {
        const room = this.getRoom(roomMeta[1]);
        if (!room) return jerr("Room not found", 404);
        if (room.visibility === "private") {
          if (!me) return jerr("Login required", 401);
          if (!this.isMember(room.id, me.id) && !me.isAdmin) return jerr("Private room", 403);
        }
        const members = room.visibility === "private" ? this.listMembers(room.id) : [];
        return j({ room, members, user: me });
      }

      // Log message (called by room DO / worker after post)
      if (path === "/log-message" && method === "POST") {
        this.sql(
          "INSERT OR IGNORE INTO message_log (id, room_id, user_id, username, text) VALUES (?, ?, ?, ?, ?)",
          body.id, body.roomId, body.userId, body.username, body.text
        );
        return j({ ok: true });
      }

      // DM
      if (path === "/dm" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        return j(this.getOrCreateDm(me.id, body.userId));
      }

      // Search
      if (path === "/users/search" && method === "GET") {
        const q = "%" + (url.searchParams.get("q") || "").trim().toLowerCase() + "%";
        if (q === "%%") return j([]);
        let rows;
        if (me) {
          rows = this.sql(
            `SELECT * FROM users WHERE username LIKE ? AND id != ?
             AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
             ORDER BY username LIMIT 40`, q, me.id, me.id
          ).toArray();
        } else {
          rows = this.sql("SELECT * FROM users WHERE username LIKE ? ORDER BY username LIMIT 40", q).toArray();
        }
        return j(rows.map((r) => this.toUser(r)));
      }

      // Contacts
      if (path === "/contacts" && method === "GET") {
        if (!me) return jerr("Login required", 401);
        return j(this.listContacts(me.id));
      }
      if (path === "/contacts" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        return j(this.addContact(me.id, body.userId));
      }
      const rmContact = path.match(/^\/contacts\/([^/]+)$/);
      if (rmContact && method === "DELETE") {
        if (!me) return jerr("Login required", 401);
        this.sql("DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?", me.id, rmContact[1]);
        return j({ ok: true });
      }

      // Admin
      if (path.startsWith("/admin/")) {
        if (!me?.isAdmin) return jerr("Admin only", 403);
        if (path === "/admin/online" && method === "GET") {
          const cutoff = new Date(Date.now() - ONLINE_MS).toISOString();
          return j(this.sql("SELECT * FROM users WHERE last_seen IS NOT NULL AND last_seen > ? ORDER BY username", cutoff).toArray().map((r) => this.toUser(r)));
        }
        if (path === "/admin/users" && method === "GET") {
          return j(this.sql("SELECT * FROM users ORDER BY username").toArray().map((r) => this.toUser(r)));
        }
        if (path === "/admin/admins" && method === "GET") {
          return j(this.sql("SELECT * FROM users WHERE is_admin = 1 ORDER BY username").toArray().map((r) => this.toUser(r)));
        }
        const full = path.match(/^\/admin\/user\/([^/]+)$/);
        if (full && method === "GET") {
          const user = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", full[1]).toArray()[0]);
          if (!user) return jerr("User not found", 404);
          const contacts = this.listContacts(user.id);
          const messages = this.sql(
            "SELECT id, room_id as roomId, user_id as userId, username, text, created_at as createdAt FROM message_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 300",
            user.id
          ).toArray();
          return j({ user, contacts, messages });
        }
        const setAdm = path.match(/^\/admin\/user\/([^/]+)\/set-admin$/);
        if (setAdm && method === "POST") {
          const u = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", setAdm[1]).toArray()[0]);
          if (!u) return jerr("User not found");
          if (u.username === "admin" && !body.isAdmin) return jerr("Cannot demote primary admin");
          this.sql("UPDATE users SET is_admin = ? WHERE id = ?", body.isAdmin ? 1 : 0, setAdm[1]);
          return j({ ok: true });
        }
        const recover = path.match(/^\/admin\/user\/([^/]+)\/recover$/);
        if (recover && method === "POST") {
          const u = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", recover[1]).toArray()[0]);
          if (!u) return jerr("User not found");
          const secret = generateSecret();
          this.sql("UPDATE users SET totp_secret = ? WHERE id = ?", secret, recover[1]);
          this.sql("DELETE FROM sessions WHERE user_id = ?", recover[1]);
          return j({ secret, otpauthUrl: otpauthUrl(u.username, secret), username: u.username });
        }
        // Primary admin only: restrict user (0=none, 1=no join public convo, 2=receive only, 3=deleted flag before hard delete)
        const restrict = path.match(/^\/admin\/user\/([^/]+)\/restrict$/);
        if (restrict && method === "POST") {
          if (me.username !== "admin") return jerr("Primary admin only", 403);
          const level = Math.max(0, Math.min(2, body.level | 0));
          const target = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", restrict[1]).toArray()[0]);
          if (!target) return jerr("User not found");
          if (target.username === "admin") return jerr("Cannot restrict primary admin");
          this.sql("UPDATE users SET restriction_level = ? WHERE id = ?", level, restrict[1]);
          return j({ ok: true, restrictionLevel: level });
        }
        // Primary admin only: hard delete user
        const delUser = path.match(/^\/admin\/user\/([^/]+)$/);
        if (delUser && method === "DELETE") {
          if (me.username !== "admin") return jerr("Primary admin only", 403);
          const target = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", delUser[1]).toArray()[0]);
          if (!target) return jerr("User not found");
          if (target.username === "admin") return jerr("Cannot delete primary admin");
          const uid = delUser[1];
          this.sql("DELETE FROM sessions WHERE user_id = ?", uid);
          this.sql("DELETE FROM contacts WHERE owner_id = ? OR contact_id = ?", uid, uid);
          this.sql("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?", uid, uid);
          this.sql("DELETE FROM room_members WHERE user_id = ?", uid);
          this.sql("DELETE FROM reports WHERE reporter_id = ? OR reported_id = ?", uid, uid);
          this.sql("DELETE FROM users WHERE id = ?", uid);
          return j({ ok: true });
        }
        // Reports list (admins)
        if (path === "/admin/reports" && method === "GET") {
          const rows = this.sql(`
            SELECT r.id, r.reason, r.created_at, r.resolved,
                   ru.username AS reporter_username, ru.id AS reporter_id,
                   du.username AS reported_username, du.id AS reported_id,
                   du.restriction_level
            FROM reports r
            JOIN users ru ON ru.id = r.reporter_id
            JOIN users du ON du.id = r.reported_id
            ORDER BY r.resolved ASC, r.created_at DESC
            LIMIT 200
          `).toArray();
          return j(rows.map((r) => ({
            id: r.id,
            reason: r.reason,
            createdAt: r.created_at,
            resolved: !!r.resolved,
            reporter: { id: r.reporter_id, username: r.reporter_username },
            reported: {
              id: r.reported_id,
              username: r.reported_username,
              restrictionLevel: r.restriction_level | 0,
            },
          })));
        }
        if (path.match(/^\/admin\/reports\/[^/]+\/resolve$/) && method === "POST") {
          const rid = path.split("/")[3];
          this.sql("UPDATE reports SET resolved = 1 WHERE id = ?", rid);
          return j({ ok: true });
        }
        return jerr("Not found", 404);
      }

      // Report user (any admin, not notified to target)
      if (path === "/report" && method === "POST") {
        if (!me?.isAdmin) return jerr("Admin only", 403);
        const targetId = body.userId;
        const reason = String(body.reason || "").trim().slice(0, 1000);
        if (!targetId || !reason) return jerr("User and reason required");
        if (targetId === me.id) return jerr("Cannot report yourself");
        const target = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", targetId).toArray()[0]);
        if (!target) return jerr("User not found");
        if (target.username === "admin") return jerr("Cannot report primary admin");
        this.sql(
          "INSERT INTO reports (id, reporter_id, reported_id, reason) VALUES (?, ?, ?, ?)",
          crypto.randomUUID(), me.id, targetId, reason
        );
        return j({ ok: true });
      }

      return jerr("Not found", 404);
    } catch (e) {
      return jerr(e.message || "Server error", 500);
    }
  }

  createSession(userId) {
    const token = crypto.randomUUID() + crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 864e5).toISOString();
    this.sql("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", token, userId, expires);
    return token;
  }

  async userByToken(token) {
    if (!token) return null;
    const s = this.sql("SELECT user_id, expires_at FROM sessions WHERE token = ?", token).toArray()[0];
    if (!s) return null;
    if (new Date(s.expires_at) < new Date()) {
      this.sql("DELETE FROM sessions WHERE token = ?", token);
      return null;
    }
    return this.toUser(this.sql("SELECT * FROM users WHERE id = ?", s.user_id).toArray()[0]);
  }

  getRoom(id) {
    return this.toRoom(this.sql("SELECT * FROM rooms WHERE id = ?", id).toArray()[0]);
  }

  isMember(roomId, userId) {
    return !!this.sql("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?", roomId, userId).toArray()[0];
  }

  isContact(ownerId, contactId) {
    return !!this.sql("SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?", ownerId, contactId).toArray()[0];
  }

  listMembers(roomId) {
    return this.sql(
      `SELECT u.* FROM room_members m JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY u.username`,
      roomId
    ).toArray().map((r) => this.toUser(r));
  }

  listContacts(ownerId) {
    const rows = this.sql(
      `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.owner_id = ? ORDER BY u.username`,
      ownerId
    ).toArray();
    return rows.map((r) => {
      const mutual = this.isContact(r.id, ownerId);
      return { user: this.toUser(r), isFriend: mutual };
    });
  }

  addContact(ownerId, contactId) {
    if (ownerId === contactId) return { ok: false, error: "Cannot add yourself" };
    if (this.sql("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?", contactId, ownerId).toArray()[0]) {
      return { ok: false, error: "You cannot add this user" };
    }
    this.sql("INSERT OR IGNORE INTO contacts (owner_id, contact_id) VALUES (?, ?)", ownerId, contactId);
    return { ok: true };
  }

  createRoom(body, me) {
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return { error: "Room name required" };
    const visibility = body.visibility || "public";
    if (!["public", "private", "registered"].includes(visibility)) return { error: "Invalid visibility" };
    const allow = visibility === "private" && body.allowMembersInvite ? 1 : 0;
    const degree = body.inviteDegree || "contacts";
    if (!["contacts", "contacts_of_contacts", "all"].includes(degree)) return { error: "Invalid invite degree" };
    const id = crypto.randomUUID();
    this.sql(
      "INSERT INTO rooms (id, name, visibility, created_by, allow_members_invite, invite_degree) VALUES (?, ?, ?, ?, ?, ?)",
      id, name, visibility, me.id, allow, degree
    );
    this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", id, me.id, me.id);
    if (visibility === "private" && Array.isArray(body.memberIds)) {
      for (const mid of body.memberIds) {
        if (mid === me.id) continue;
        if (!this.isContact(me.id, mid)) continue;
        this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", id, mid, me.id);
      }
    }
    return this.getRoom(id);
  }

  deleteRoom(roomId, me) {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    if (room.createdBy !== me.id && !me.isAdmin) return { ok: false, error: "Only creator or admin can delete" };
    this.sql("DELETE FROM rooms WHERE id = ?", roomId);
    this.sql("DELETE FROM room_members WHERE room_id = ?", roomId);
    this.sql("DELETE FROM message_log WHERE room_id = ?", roomId);
    return { ok: true };
  }

  addMember(roomId, adderId, targetId) {
    const room = this.getRoom(roomId);
    if (!room || room.visibility !== "private") return { ok: false, error: "Invalid room" };
    const isCreator = room.createdBy === adderId;
    if (!this.isMember(roomId, adderId) && !isCreator) return { ok: false, error: "Not a member" };
    if (!isCreator && !room.allowMembersInvite) return { ok: false, error: "Only creator can add members" };
    if (this.isMember(roomId, targetId)) return { ok: false, error: "Already a member" };
    const degree = room.inviteDegree || "contacts";
    if (degree === "contacts") {
      if (!this.isContact(adderId, targetId)) return { ok: false, error: "Must be in your contacts" };
    } else if (degree === "contacts_of_contacts") {
      if (!this.isContact(adderId, targetId)) {
        const mine = this.sql("SELECT contact_id FROM contacts WHERE owner_id = ?", adderId).toArray();
        let ok = false;
        for (const c of mine) if (this.isContact(c.contact_id, targetId)) { ok = true; break; }
        if (!ok) return { ok: false, error: "Must be contacts or contacts-of-contacts" };
      }
    }
    this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", roomId, targetId, adderId);
    return { ok: true };
  }

  removeMember(roomId, actorId, targetId) {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    if (actorId !== room.createdBy && actorId !== targetId) return { ok: false, error: "Only creator can remove" };
    if (targetId === room.createdBy) return { ok: false, error: "Cannot remove creator" };
    this.sql("DELETE FROM room_members WHERE room_id = ? AND user_id = ?", roomId, targetId);
    return { ok: true };
  }

  getOrCreateDm(userA, userB) {
    const [a, b] = [userA, userB].sort();
    const id = "dm:" + a + ":" + b;
    const existing = this.getRoom(id);
    if (existing) return existing;
    this.sql(
      "INSERT INTO rooms (id, name, visibility, created_by, allow_members_invite, invite_degree) VALUES (?, ?, 'private', ?, 0, 'contacts')",
      id, "Direct message", userA
    );
    this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", id, userA, userA);
    this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", id, userB, userA);
    return this.getRoom(id);
  }
}

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function jerr(msg, status = 400) { return j({ error: msg }, status); }
