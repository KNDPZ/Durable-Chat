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
        CREATE TABLE IF NOT EXISTS room_admins (
          room_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS join_requests (
          room_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          data TEXT,
          read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS last_read (
          user_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          last_read_at TEXT NOT NULL,
          PRIMARY KEY (user_id, room_id)
        );
        CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
      `);
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN last_seen TEXT"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN allow_members_invite INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN invite_degree TEXT NOT NULL DEFAULT 'contacts'"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN restriction_level INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN searchable INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE users ADD COLUMN avatar_key TEXT"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN avatar_key TEXT"); } catch {}
      try { this.state.storage.sql.exec("ALTER TABLE rooms ADD COLUMN allow_admin_avatar INTEGER NOT NULL DEFAULT 0"); } catch {}
      this.state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS device_codes (
          code TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);
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
      email: r.email || null,
      avatarUrl: r.avatar_key ? "/avatar/" + r.id : null,
    };
  }

  toRoom(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, visibility: r.visibility, createdBy: r.created_by,
      createdAt: r.created_at, allowMembersInvite: !!r.allow_members_invite,
      inviteDegree: r.invite_degree || "contacts",
      searchable: !!r.searchable,
      avatarUrl: r.avatar_key ? "/avatar/room/" + r.id : null,
      allowAdminAvatar: !!r.allow_admin_avatar,
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
          const isPrimary = me.username === "admin";
          let rows;
          if (isPrimary) {
            // primary admin surveillance: all private rooms + DMs
            rows = this.sql(`SELECT * FROM rooms WHERE visibility = 'private' ORDER BY created_at DESC`).toArray();
          } else {
            rows = this.sql(
              `SELECT DISTINCT r.* FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id
               WHERE r.visibility = 'private' AND (r.created_by = ? OR m.user_id = ?) ORDER BY r.created_at DESC`,
              me.id, me.id
            ).toArray();
          }
          priv = rows.map((r) => {
            const room = this.toRoom(r);
            const members = this.listMembers(r.id);
            room.memberPreviews = members.slice(0, 4).map((m) => ({
              id: m.id, username: m.username, avatarUrl: m.avatarUrl,
            }));
            room.memberCount = members.length;
            if (r.id.startsWith("dm:") && members.length <= 2) {
              const other = members.find((m) => m.id !== me.id);
              room.displayName = other ? other.username : "Direct message";
              room.peerId = other ? other.id : null;
              room.peerAvatarUrl = other ? other.avatarUrl : null;
              room.isDm = true;
              room.isGroup = false;
            } else {
              room.displayName = room.name;
              room.isDm = false;
              room.isGroup = members.length > 2 || !r.id.startsWith("dm:");
              // former DM converted to group still has dm: id but isGroup true
              if (r.id.startsWith("dm:") && members.length > 2) {
                room.isGroup = true;
                room.convertedFromDm = true;
              }
            }
            return room;
          });
        }
        // annotate public with displayName
        const pubOut = pub.map((r) => ({ ...r, displayName: r.name, isDm: false }));
        return j({ public: pubOut, private: priv });
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
          if (!this.isMember(room.id, me.id) && me.username !== "admin") return jerr("Private room", 403);
        }
        let members = room.visibility === "private" ? this.listMembers(room.id) : [];
        if (me && members.length) {
          members = members.map((m) => {
            if (m.id !== me.id && this.isBlocked(me.id, m.id)) {
              return { ...m, username: "Anonymous", anonymous: true };
            }
            return m;
          });
        }
        // Primary admin can view private room meta for surveillance
        if (room.visibility === "private" && me && me.username === "admin" && !members.find((m) => m.id === me.id)) {
          // allow without membership
        }
        const isCreator = me ? String(room.createdBy) === String(me.id) : false;
        const isRoomAdmin = me ? this.isRoomAdmin(room.id, me.id) : false;
        return j({ room, members, user: me, isCreator, isRoomAdmin });
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
        let raw = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (raw.startsWith("@")) raw = raw.slice(1);
        if (!raw) return j([]);
        const q = "%" + raw + "%";
        let rows;
        if (me) {
          rows = this.sql(
            `SELECT * FROM users WHERE username LIKE ? AND id != ?
             AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
             AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
             ORDER BY username LIMIT 40`, q, me.id, me.id, me.id
          ).toArray();
        } else {
          rows = this.sql("SELECT * FROM users WHERE username LIKE ? ORDER BY username LIMIT 40", q).toArray();
        }
        return j(rows.map((r) => {
          const u = this.toUser(r);
          if (me) u.isContact = this.isContact(me.id, r.id);
          return u;
        }));
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




      // Profile: email (for future recovery — no recovery flow yet)
      if (path === "/profile/email" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const email = String(body.email || "").trim().toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jerr("Invalid email");
        this.sql("UPDATE users SET email = ? WHERE id = ?", email || null, me.id);
        return j({ ok: true, email: email || null });
      }
      // Profile: set avatar key after R2 upload (worker sets this)
      if (path === "/profile/avatar" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const key = body.key ? String(body.key).slice(0, 200) : null;
        this.sql("UPDATE users SET avatar_key = ? WHERE id = ?", key, me.id);
        return j({ ok: true, avatarUrl: key ? "/avatar/" + me.id : null });
      }
      // Multi-device: create pairing code (valid 10 min)
      if (path === "/auth/device-code" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const code = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2,"0")).join("");
        const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        this.sql("DELETE FROM device_codes WHERE user_id = ?", me.id);
        this.sql("INSERT INTO device_codes (code, user_id, expires_at) VALUES (?, ?, ?)", code, me.id, expires);
        return j({
          code,
          expiresAt: expires,
          // URL for QR — open on other device
          pairUrl: "/app.html?pair=" + code,
        });
      }
      // Complete device pairing with TOTP
      if (path === "/auth/device-pair" && method === "POST") {
        const code = String(body.code || "").trim().toLowerCase();
        const row = this.sql("SELECT * FROM device_codes WHERE code = ?", code).toArray()[0];
        if (!row) return jerr("Invalid or expired code");
        if (new Date(row.expires_at) < new Date()) {
          this.sql("DELETE FROM device_codes WHERE code = ?", code);
          return jerr("Code expired");
        }
        const user = this.sql("SELECT * FROM users WHERE id = ?", row.user_id).toArray()[0];
        if (!user) return jerr("User not found");
        if (!(await verifyTOTP(user.totp_secret, body.totpCode))) return jerr("Invalid authenticator code");
        this.sql("DELETE FROM device_codes WHERE code = ?", code);
        this.sql("UPDATE users SET last_seen = datetime('now') WHERE id = ?", user.id);
        return j({ user: this.toUser(user), token: this.createSession(user.id) });
      }
      // Public rooms list (no auth) for landing page
      if (path === "/public-rooms" && method === "GET") {
        const pub = this.sql(
          "SELECT id, name, visibility, created_at FROM rooms WHERE visibility = 'public' ORDER BY created_at DESC LIMIT 50"
        ).toArray();
        return j(pub.map((r) => ({ id: r.id, name: r.name, visibility: r.visibility, createdAt: r.created_at })));
      }

      // Notifications
      if (path === "/notifications" && method === "GET") {
        if (!me) return jerr("Login required", 401);
        const all = url.searchParams.get("all") === "1";
        const limit = all ? 200 : 10;
        const rows = this.sql(
          "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", me.id, limit
        ).toArray();
        return j(rows.map((r) => ({
          id: r.id, type: r.type, title: r.title, body: r.body,
          data: r.data ? JSON.parse(r.data) : null,
          read: !!r.read, createdAt: r.created_at,
        })));
      }
      if (path === "/notifications/read" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        if (body.id) this.sql("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?", body.id, me.id);
        else this.sql("UPDATE notifications SET read = 1 WHERE user_id = ?", me.id);
        return j({ ok: true });
      }
      if (path === "/notifications/unread-count" && method === "GET") {
        if (!me) return j({ count: 0 });
        const row = this.sql("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0", me.id).toArray()[0];
        return j({ count: row?.c || 0 });
      }

      // Mark room as read + get unread counts
      if (path === "/rooms/mark-read" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const roomId = body.roomId;
        if (!roomId) return jerr("roomId required");
        this.sql(
          "INSERT OR REPLACE INTO last_read (user_id, room_id, last_read_at) VALUES (?, ?, datetime('now'))",
          me.id, roomId
        );
        // For DMs: store seen marker for peer
        if (roomId.startsWith("dm:")) {
          // peer will see seen via last_read of this user
        }
        return j({ ok: true });
      }
      if (path === "/rooms/unread" && method === "GET") {
        if (!me) return j({});
        // Return map roomId -> unread count from message_log after last_read
        const rooms = this.sql(
          `SELECT DISTINCT r.id FROM rooms r
           LEFT JOIN room_members m ON m.room_id = r.id
           WHERE r.created_by = ? OR m.user_id = ? OR ? = 'admin'`,
          me.id, me.id, me.username
        ).toArray();
        const out = {};
        for (const r of rooms) {
          const lr = this.sql("SELECT last_read_at FROM last_read WHERE user_id = ? AND room_id = ?", me.id, r.id).toArray()[0];
          let cnt;
          if (lr) {
            cnt = this.sql(
              "SELECT COUNT(*) AS c FROM message_log WHERE room_id = ? AND created_at > ? AND user_id != ?",
              r.id, lr.last_read_at, me.id
            ).toArray()[0];
          } else {
            cnt = this.sql(
              "SELECT COUNT(*) AS c FROM message_log WHERE room_id = ? AND user_id != ?",
              r.id, me.id
            ).toArray()[0];
          }
          if (cnt && cnt.c > 0) out[r.id] = cnt.c;
        }
        return j(out);
      }

      // DM seen: last message read by peer?
      if (path === "/dm/seen" && method === "GET") {
        if (!me) return jerr("Login required", 401);
        const roomId = url.searchParams.get("roomId");
        if (!roomId || !roomId.startsWith("dm:")) return j({ seen: false });
        const members = this.listMembers(roomId);
        const peer = members.find((m) => m.id !== me.id);
        if (!peer) return j({ seen: false });
        // last message by me
        const lastMine = this.sql(
          "SELECT created_at FROM message_log WHERE room_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1",
          roomId, me.id
        ).toArray()[0];
        if (!lastMine) return j({ seen: false });
        const peerRead = this.sql(
          "SELECT last_read_at FROM last_read WHERE user_id = ? AND room_id = ?",
          peer.id, roomId
        ).toArray()[0];
        const seen = peerRead && peerRead.last_read_at >= lastMine.created_at;
        return j({ seen: !!seen, seenAt: peerRead?.last_read_at || null });
      }

      // Leave room
      if (path === "/rooms/leave" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const roomId = body.roomId;
        const room = this.getRoom(roomId);
        if (!room) return jerr("Room not found");
        const isDm = String(roomId).startsWith("dm:");
        // Non-DM: creator must delete the room instead of leave
        if (!isDm && room.createdBy === me.id) {
          return jerr("Creator cannot leave; delete the room instead");
        }
        this.sql("DELETE FROM room_members WHERE room_id = ? AND user_id = ?", roomId, me.id);
        this.sql("DELETE FROM room_admins WHERE room_id = ? AND user_id = ?", roomId, me.id);
        this.sql("DELETE FROM last_read WHERE room_id = ? AND user_id = ?", roomId, me.id);
        const remaining = this.sql("SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?", roomId).toArray()[0]?.c || 0;
        if (remaining === 0) {
          this.purgeRoomData(roomId);
          return j({ ok: true, purged: true, roomId });
        }
        // Left but room still exists for others — they keep their history
        return j({ ok: true, purged: false, remaining, roomId });
      }

      // Block / unblock / list
      if (path === "/blocks" && method === "GET") {
        if (!me) return jerr("Login required", 401);
        const rows = this.sql(
          `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY u.username`,
          me.id
        ).toArray();
        return j(rows.map((r) => this.toUser(r)));
      }
      if (path === "/blocks" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const targetId = body.userId;
        if (!targetId || targetId === me.id) return jerr("Invalid user");
        this.sql("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)", me.id, targetId);
        // remove contacts both ways
        this.sql("DELETE FROM contacts WHERE (owner_id = ? AND contact_id = ?) OR (owner_id = ? AND contact_id = ?)",
          me.id, targetId, targetId, me.id);
        // Detach blocker from all DM rooms shared with blocked user (blocker leaves those DMs)
        const dms = this.sql(
          `SELECT r.id FROM rooms r
           JOIN room_members m1 ON m1.room_id = r.id AND m1.user_id = ?
           JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = ?
           WHERE r.id LIKE 'dm:%'`,
          me.id, targetId
        ).toArray();
        const purged = [];
        for (const d of dms) {
          this.sql("DELETE FROM room_members WHERE room_id = ? AND user_id = ?", d.id, me.id);
          this.sql("DELETE FROM last_read WHERE room_id = ? AND user_id = ?", d.id, me.id);
          const remaining = this.sql("SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?", d.id).toArray()[0]?.c || 0;
          if (remaining === 0) {
            this.purgeRoomData(d.id);
            purged.push(d.id);
          }
        }
        return j({ ok: true, purgedDms: purged });
      }
      if (path === "/blocks/remove" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        this.sql("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", me.id, body.userId);
        return j({ ok: true });
      }

      // Search rooms + contacts (partial match)
      if (path === "/search" && method === "GET") {
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (!q || q.length < 1) return j({ rooms: [], contacts: [] });
        const like = "%" + q + "%";
        // Searchable rooms (any visibility) matching name
        const rooms = this.sql(
          `SELECT * FROM rooms WHERE searchable = 1 AND lower(name) LIKE ? ORDER BY name LIMIT 30`,
          like
        ).toArray().map((r) => {
          const room = this.toRoom(r);
          room.isMember = me ? this.isMember(r.id, me.id) : false;
          room.pendingJoin = me ? !!this.sql(
            "SELECT 1 FROM join_requests WHERE room_id = ? AND user_id = ? AND status = 'pending'",
            r.id, me.id
          ).toArray()[0] : false;
          return room;
        });
        let contacts = [];
        if (me) {
          contacts = this.sql(
            `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
             WHERE c.owner_id = ? AND lower(u.username) LIKE ? ORDER BY u.username LIMIT 30`,
            me.id, like
          ).toArray().map((r) => this.toUser(r));
        }
        return j({ rooms, contacts });
      }

      // Join request for searchable room
      if (path === "/rooms/join-request" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const roomId = body.roomId;
        const room = this.getRoom(roomId);
        if (!room) return jerr("Room not found", 404);
        if (!room.searchable) return jerr("Room is not searchable");
        if (this.isMember(roomId, me.id)) return jerr("Already a member");
        this.sql(
          "INSERT OR REPLACE INTO join_requests (room_id, user_id, status) VALUES (?, ?, 'pending')",
          roomId, me.id
        );
        return j({ ok: true });
      }

      // List join requests (room creator or room admin)
      const joinList = path.match(/^\/rooms\/([^/]+)\/join-requests$/);
      if (joinList && method === "GET") {
        if (!me) return jerr("Login required", 401);
        const roomId = joinList[1];
        if (!this.isRoomAdmin(roomId, me.id) && me.username !== "admin") return jerr("Room admin only", 403);
        const rows = this.sql(
          `SELECT jr.user_id, jr.status, jr.created_at, u.username FROM join_requests jr
           JOIN users u ON u.id = jr.user_id WHERE jr.room_id = ? AND jr.status = 'pending' ORDER BY jr.created_at`,
          roomId
        ).toArray();
        return j(rows.map((r) => ({ userId: r.user_id, username: r.username, status: r.status, createdAt: r.created_at })));
      }

      // Approve/deny join
      const joinAct = path.match(/^\/rooms\/([^/]+)\/join-requests\/([^/]+)$/);
      if (joinAct && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const roomId = joinAct[1];
        const userId = joinAct[2];
        if (!this.isRoomAdmin(roomId, me.id) && me.username !== "admin") return jerr("Room admin only", 403);
        const action = body.action; // approve | deny
        if (action === "approve") {
          this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", roomId, userId, me.id);
          this.sql("UPDATE join_requests SET status = 'approved' WHERE room_id = ? AND user_id = ?", roomId, userId);
          const roomJ = this.getRoom(roomId);
          this.notify(userId, "join_approved", "Join approved: " + (roomJ?.name || "room"),
            "You can now chat in this room", { roomId, roomName: roomJ?.name });
        } else {
          this.sql("UPDATE join_requests SET status = 'denied' WHERE room_id = ? AND user_id = ?", roomId, userId);
        }
        return j({ ok: true });
      }

      // Update room settings (name, visibility, searchable, invite options)
      const roomSettings = path.match(/^\/rooms\/([^/]+)\/settings$/);
      if (roomSettings && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const roomId = roomSettings[1];
        const room = this.getRoom(roomId);
        if (!room) return jerr("Room not found", 404);
        const isCreator = room.createdBy === me.id;
        const isRA = this.isRoomAdmin(roomId, me.id);
        if (!isCreator && !isRA && me.username !== "admin") return jerr("Not allowed", 403);
        // Name change: creator only
        if (body.name != null) {
          if (!isCreator && me.username !== "admin") return jerr("Only creator can rename room", 403);
          const name = String(body.name).trim().slice(0, 60);
          if (!name) return jerr("Name required");
          this.sql("UPDATE rooms SET name = ? WHERE id = ?", name, roomId);
        }
        // Privacy / searchable / invite: creator or room admin
        if (body.visibility != null) {
          if (!["public", "private", "registered"].includes(body.visibility)) return jerr("Invalid visibility");
          this.sql("UPDATE rooms SET visibility = ? WHERE id = ?", body.visibility, roomId);
        }
        if (body.searchable != null) {
          this.sql("UPDATE rooms SET searchable = ? WHERE id = ?", body.searchable ? 1 : 0, roomId);
        }
        if (body.allowMembersInvite != null) {
          this.sql("UPDATE rooms SET allow_members_invite = ? WHERE id = ?", body.allowMembersInvite ? 1 : 0, roomId);
        }
        if (body.inviteDegree != null) {
          if (!["contacts", "contacts_of_contacts", "all"].includes(body.inviteDegree)) return jerr("Invalid degree");
          this.sql("UPDATE rooms SET invite_degree = ? WHERE id = ?", body.inviteDegree, roomId);
        }
        if (body.allowAdminAvatar != null) {
          if (!isCreator && me.username !== "admin") return jerr("Only creator can change this", 403);
          this.sql("UPDATE rooms SET allow_admin_avatar = ? WHERE id = ?", body.allowAdminAvatar ? 1 : 0, roomId);
        }
        return j(this.getRoom(roomId));
      }

      // Set room avatar key (after R2 upload)
      if (path === "/rooms/avatar" && method === "POST") {
        if (!me) return jerr("Login required", 401);
        const roomId = body.roomId;
        const room = this.getRoom(roomId);
        if (!room) return jerr("Room not found");
        const isCreator = room.createdBy === me.id;
        const isRA = this.isRoomAdmin(roomId, me.id);
        if (!isCreator && !(isRA && room.allowAdminAvatar) && me.username !== "admin") {
          return jerr("Not allowed to change room photo", 403);
        }
        const key = body.key ? String(body.key).slice(0, 200) : null;
        this.sql("UPDATE rooms SET avatar_key = ? WHERE id = ?", key, roomId);
        return j({ ok: true, avatarUrl: key ? "/avatar/room/" + roomId : null });
      }

      // Room admins list / set
      const roomAdmins = path.match(/^\/rooms\/([^/]+)\/admins$/);
      if (roomAdmins) {
        const roomId = roomAdmins[1];
        if (method === "GET") {
          if (!me) return jerr("Login required", 401);
          const room = this.getRoom(roomId);
          if (!room) return jerr("Room not found", 404);
          const rows = this.sql(
            `SELECT u.* FROM room_admins ra JOIN users u ON u.id = ra.user_id WHERE ra.room_id = ? ORDER BY u.username`,
            roomId
          ).toArray();
          return j({ creatorId: room.createdBy, admins: rows.map((r) => this.toUser(r)) });
        }
        if (method === "POST") {
          if (!me) return jerr("Login required", 401);
          const room = this.getRoom(roomId);
          if (!room) return jerr("Room not found", 404);
          // Only creator can assign/remove room admins
          if (room.createdBy !== me.id && me.username !== "admin") return jerr("Only creator can manage room admins", 403);
          const targetId = body.userId;
          if (!targetId) return jerr("userId required");
          if (targetId === room.createdBy) return jerr("Creator is always admin");
          if (!this.isMember(roomId, targetId)) return jerr("User must be a member first");
          if (body.remove) {
            this.sql("DELETE FROM room_admins WHERE room_id = ? AND user_id = ?", roomId, targetId);
          } else {
            this.sql("INSERT OR IGNORE INTO room_admins (room_id, user_id) VALUES (?, ?)", roomId, targetId);
          }
          return j({ ok: true });
        }
      }

      // Enrich meta with isRoomAdmin, isCreator
      // (handled by patching getRoom meta path below if needed)

      return jerr("Not found", 404);
    } catch (e) {
      return jerr(e.message || "Server error", 500);
    }
  }

  notify(userId, type, title, body, data) {
    this.sql(
      "INSERT INTO notifications (id, user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), userId, type, title, body || "", data ? JSON.stringify(data) : null
    );
  }

  isBlocked(a, b) {
    // does a block b or b block a?
    return !!this.sql(
      "SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)",
      a, b, b, a
    ).toArray()[0];
  }

  isRoomAdmin(roomId, userId) {
    const room = this.getRoom(roomId);
    if (!room) return false;
    if (String(room.createdBy) === String(userId)) return true;
    return !!this.sql("SELECT 1 FROM room_admins WHERE room_id = ? AND user_id = ?", roomId, userId).toArray()[0];
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
    if (this.sql("SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?", ownerId, contactId).toArray()[0]) {
      return { ok: false, error: "You blocked this user" };
    }
    this.sql("INSERT OR IGNORE INTO contacts (owner_id, contact_id) VALUES (?, ?)", ownerId, contactId);
    const owner = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", ownerId).toArray()[0]);
    const alreadyMutual = this.isContact(contactId, ownerId);
    if (alreadyMutual) {
      // Target already had owner as contact — this is "add back"
      this.notify(contactId, "contact_added_back", "@" + (owner?.username || "someone") + " added you back", "", {
        userId: ownerId, username: owner?.username,
      });
    } else {
      this.notify(contactId, "contact_added", "@" + (owner?.username || "someone") + " added you as a contact", "", {
        userId: ownerId, username: owner?.username,
      });
    }
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
    const searchable = body.searchable ? 1 : 0;
    const id = crypto.randomUUID();
    this.sql(
      "INSERT INTO rooms (id, name, visibility, created_by, allow_members_invite, invite_degree, searchable) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, name, visibility, me.id, allow, degree, searchable
    );
    this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", id, me.id, me.id);
    this.sql("INSERT OR IGNORE INTO room_admins (room_id, user_id) VALUES (?, ?)", id, me.id);
    if (visibility === "private" && Array.isArray(body.memberIds)) {
      for (const mid of body.memberIds) {
        if (mid === me.id) continue;
        if (!this.isContact(me.id, mid)) continue;
        this.sql("INSERT OR IGNORE INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)", id, mid, me.id);
      }
    }
    return this.getRoom(id);
  }

  purgeRoomData(roomId) {
    this.sql("DELETE FROM room_members WHERE room_id = ?", roomId);
    this.sql("DELETE FROM room_admins WHERE room_id = ?", roomId);
    this.sql("DELETE FROM join_requests WHERE room_id = ?", roomId);
    this.sql("DELETE FROM message_log WHERE room_id = ?", roomId);
    this.sql("DELETE FROM last_read WHERE room_id = ?", roomId);
    this.sql("DELETE FROM rooms WHERE id = ?", roomId);
  }

  deleteRoom(roomId, me) {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    const isDm = roomId.startsWith("dm:");
    // Creator, primary admin, or any DM participant can delete
    const isMember = this.isMember(roomId, me.id);
    if (room.createdBy !== me.id && !me.isAdmin && me.username !== "admin" && !(isDm && isMember)) {
      return { ok: false, error: "Only creator or admin can delete" };
    }
    this.purgeRoomData(roomId);
    return { ok: true, purged: true, roomId };
  }

  addMember(roomId, adderId, targetId) {
    const room = this.getRoom(roomId);
    if (!room || room.visibility !== "private") return { ok: false, error: "Invalid room" };
    const isCreator = String(room.createdBy) === String(adderId);
    const isDm = String(roomId).startsWith("dm:");
    if (!this.isMember(roomId, adderId) && !isCreator) return { ok: false, error: "Not a member" };
    // DMs: any member can add a contact (becomes group at 3+). Groups: creator or allowMembersInvite
    if (!isDm && !isCreator && !room.allowMembersInvite) return { ok: false, error: "Only creator can add members" };
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
    let roomN = this.getRoom(roomId);
    // DM with 3+ members becomes a group chat (stays private, shown under Joined)
    if (String(roomId).startsWith("dm:")) {
      const cnt = this.sql("SELECT COUNT(*) AS c FROM room_members WHERE room_id = ?", roomId).toArray()[0]?.c || 0;
      if (cnt > 2) {
        const names = this.listMembers(roomId).map((m) => m.username).slice(0, 3).join(", ");
        const newName = (roomN?.name && roomN.name !== "Direct message") ? roomN.name : ("Group: " + names);
        this.sql("UPDATE rooms SET name = ? WHERE id = ?", newName, roomId);
        roomN = this.getRoom(roomId);
      }
    }
    const adder = this.toUser(this.sql("SELECT * FROM users WHERE id = ?", adderId).toArray()[0]);
    this.notify(targetId, "added_to_room", "Added to " + (roomN?.name || "a room"),
      "@" + (adder?.username || "someone") + " added you",
      { roomId, roomName: roomN?.name });
    return { ok: true };
  }

  removeMember(roomId, actorId, targetId) {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    // Only creator (or self-leave) can remove members — not secondary room admins
    if (actorId !== room.createdBy && actorId !== targetId) return { ok: false, error: "Only creator can remove members" };
    if (targetId === room.createdBy) return { ok: false, error: "Cannot remove creator" };
    this.sql("DELETE FROM room_members WHERE room_id = ? AND user_id = ?", roomId, targetId);
    this.sql("DELETE FROM room_admins WHERE room_id = ? AND user_id = ?", roomId, targetId);
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
