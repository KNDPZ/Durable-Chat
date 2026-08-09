// worker.mjs — front door
export { Hub } from "./hub-do.mjs";
export { ChatRoom } from "./room-do.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (path.startsWith("/ws/room/")) {
      const roomId = path.split("/").pop();
      if (!roomId) return new Response("missing room", { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
    }

    // Serve avatar from R2 (user or room)
    if (path.startsWith("/avatar/")) {
      if (!env.AVATARS) return new Response("Not found", { status: 404 });
      let key;
      if (path.startsWith("/avatar/room/")) {
        const roomId = path.slice("/avatar/room/".length).split("/")[0];
        if (!roomId) return new Response("Not found", { status: 404 });
        key = "avatars/room/" + roomId;
      } else {
        const userId = path.slice("/avatar/".length).split("/")[0];
        if (!userId) return new Response("Not found", { status: 404 });
        key = "avatars/" + userId;
      }
      const obj = await env.AVATARS.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=3600");
      return new Response(obj.body, { headers });
    }

    // Upload avatar (multipart or raw body)
    if (path === "/api/profile/avatar-upload" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const hub = env.HUB.get(env.HUB.idFromName("global"));
      const meRes = await hub.fetch(new Request(new URL("/auth/me", request.url).toString(), {
        headers: { Authorization: auth },
      }));
      const meData = await meRes.json();
      if (!meData.user) return cors(json({ error: "Login required" }, 401));
      if (!env.AVATARS) return cors(json({ error: "R2 not configured" }, 503));
      const ct = request.headers.get("content-type") || "image/jpeg";
      if (!ct.startsWith("image/")) return cors(json({ error: "Image required" }, 400));
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 2 * 1024 * 1024) return cors(json({ error: "Max 2MB" }, 400));
      const key = "avatars/" + meData.user.id;
      await env.AVATARS.put(key, buf, { httpMetadata: { contentType: ct } });
      await hub.fetch(new Request(new URL("/profile/avatar", request.url).toString(), {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }));
      return cors(json({ ok: true, avatarUrl: "/avatar/" + meData.user.id + "?t=" + Date.now() }));
    }

    
    if (path === "/api/rooms/avatar-upload" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const hub = env.HUB.get(env.HUB.idFromName("global"));
      const roomId = new URL(request.url).searchParams.get("roomId");
      if (!roomId) return cors(json({ error: "roomId required" }, 400));
      const meRes = await hub.fetch(new Request(new URL("/auth/me", request.url).toString(), {
        headers: { Authorization: auth },
      }));
      const meData = await meRes.json();
      if (!meData.user) return cors(json({ error: "Login required" }, 401));
      if (!env.AVATARS) return cors(json({ error: "R2 not configured" }, 503));
      const ct = request.headers.get("content-type") || "image/jpeg";
      if (!ct.startsWith("image/")) return cors(json({ error: "Image required" }, 400));
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 2 * 1024 * 1024) return cors(json({ error: "Max 2MB" }, 400));
      const key = "avatars/room/" + roomId;
      await env.AVATARS.put(key, buf, { httpMetadata: { contentType: ct } });
      const setRes = await hub.fetch(new Request(new URL("/rooms/avatar", request.url).toString(), {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ roomId, key }),
      }));
      const setData = await setRes.json();
      if (!setRes.ok) return cors(json(setData, setRes.status));
      return cors(json({ ok: true, avatarUrl: "/avatar/room/" + roomId + "?t=" + Date.now() }));
    }

    if (path.startsWith("/api/")) {
      const hub = env.HUB.get(env.HUB.idFromName("global"));
      const u = new URL(request.url);
      u.pathname = path.slice("/api".length) || "/";
      const hubReq = new Request(u.toString(), request);


      const pinMatch = path.match(/^\/api\/rooms\/([^/]+)\/pin$/);
      if (pinMatch) {
        const roomId = pinMatch[1];
        const metaUrl = new URL(request.url);
        metaUrl.pathname = "/rooms/" + roomId + "/meta";
        const metaRes = await hub.fetch(new Request(metaUrl.toString(), {
          headers: { Authorization: request.headers.get("Authorization") || "" },
        }));
        const meta = await metaRes.json();
        if (!metaRes.ok) return cors(json(meta, metaRes.status));
        if (!meta.user) return cors(json({ error: "Login required" }, 401));
        const isCreator = meta.room.createdBy === meta.user.id;
        if (!isCreator && !meta.user.isAdmin) return cors(json({ error: "Only creator can pin" }, 403));
        const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const r = await roomStub.fetch(new Request(new URL("/pin", request.url).toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId: body.messageId || null }),
          }));
          return cors(await r.json().then((d) => json(d, r.status)));
        }
      }

      // Message routes: /api/rooms/:id/messages[/:msgId[/(react|history)]]
      const msgMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages(?:\/([^/]+))?(?:\/(react|history))?$/);
      if (msgMatch) {
        const roomId = msgMatch[1];
        const msgId = msgMatch[2];
        const sub = msgMatch[3];
        const method = request.method;

        // Auth + room meta
        const metaUrl = new URL(request.url);
        metaUrl.pathname = "/rooms/" + roomId + "/meta";
        const metaRes = await hub.fetch(new Request(metaUrl.toString(), {
          headers: { Authorization: request.headers.get("Authorization") || "" },
        }));
        const meta = await metaRes.json();
        if (!metaRes.ok) return cors(json(meta, metaRes.status));

        const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        const auth = request.headers.get("Authorization") || "";

        // GET list or single
        if (method === "GET" && !sub) {
          if (msgId) {
            const r = await roomStub.fetch(new Request(new URL("/messages/" + msgId, request.url).toString()));
            return cors(await r.json().then((d) => json(d, r.status)));
          }
          const listUrl = new URL(request.url);
          listUrl.pathname = "/messages";
          const listRes = await roomStub.fetch(new Request(listUrl.toString()));
          let payload = await listRes.json();
          let messages = Array.isArray(payload) ? payload : (payload.messages || []);
          const pinned = Array.isArray(payload) ? null : (payload.pinned || null);
          if (meta.room.visibility === "registered" && !meta.user) {
            messages = messages.map((m) => ({
              ...m,
              text: m.isDeleted ? "" : "•••••••• (login to read)",
              username: m.isDeleted ? m.username : "•••",
              reactions: {},
              replyTo: null,
            }));
          }
          // Activity ranking: top posters among recent messages
          const counts = {};
          for (const m of messages) {
            if (m.isDeleted) continue;
            counts[m.username] = (counts[m.username] || 0) + 1;
          }
          const activeUsers = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([u])=>u);
          return cors(json({ room: meta.room, messages, members: meta.members || [], pinned, activeUsers }));
        }

        // GET history
        if (method === "GET" && sub === "history" && msgId) {
          const r = await roomStub.fetch(new Request(new URL("/messages/" + msgId + "/history", request.url).toString()));
          return cors(await r.json().then((d) => json(d, r.status)));
        }

        // Need login for write ops
        if (!meta.user) return cors(json({ error: "Login required" }, 401));
        const level = meta.user.restrictionLevel | 0;

        // Restriction level 2: cannot send/reply/react/edit
        if (level >= 2 && method !== "GET") {
          return cors(json({ error: "Your account is restricted from sending messages" }, 403));
        }
        // Level 1: can DM and read, but not post in non-private group rooms?
        // Spec: "can still read users only rooms but cannot join the convo. BUT can still message other people."
        // So level 1: block posting in public/registered rooms, allow private/DM
        if (level === 1 && method === "POST" && !msgId && meta.room.visibility !== "private") {
          return cors(json({ error: "You are restricted from posting in this room" }, 403));
        }

        // POST new message
        if (method === "POST" && !msgId) {
          if (meta.room.visibility === "private") {
            const isMember = (meta.members || []).some((m) => m.id === meta.user.id);
            const isPrimary = meta.user.username === "admin";
            if (!isMember && !isPrimary) return cors(json({ error: "Private room" }, 403));
          }
          const body = await request.json().catch(() => ({}));
          const postUrl = new URL(request.url);
          postUrl.pathname = "/messages";
          const postRes = await roomStub.fetch(new Request(postUrl.toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: body.text,
              userId: meta.user.id,
              username: meta.user.username,
              replyToId: body.replyToId || null,
              forward: body.forward || null,
            }),
          }));
          const msg = await postRes.json();
          if (postRes.ok && msg.id) {
            const logUrl = new URL(request.url);
            logUrl.pathname = "/log-message";
            await hub.fetch(new Request(logUrl.toString(), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: msg.id, roomId, userId: meta.user.id,
                username: meta.user.username, text: msg.text || "",
              }),
            }));
          }
          return cors(json(msg, postRes.status));
        }

        // POST react
        if (method === "POST" && sub === "react" && msgId) {
          const body = await request.json().catch(() => ({}));
          const r = await roomStub.fetch(new Request(new URL("/messages/" + msgId + "/react", request.url).toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ emoji: body.emoji, userId: meta.user.id, username: meta.user.username }),
          }));
          return cors(await r.json().then((d) => json(d, r.status)));
        }

        // PATCH edit
        if (method === "PATCH" && msgId && !sub) {
          const body = await request.json().catch(() => ({}));
          const r = await roomStub.fetch(new Request(new URL("/messages/" + msgId, request.url).toString(), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: body.text, userId: meta.user.id }),
          }));
          return cors(await r.json().then((d) => json(d, r.status)));
        }

        // DELETE soft
        if (method === "DELETE" && msgId && !sub) {
          const r = await roomStub.fetch(new Request(new URL("/messages/" + msgId, request.url).toString(), {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: meta.user.id, isAdmin: !!meta.user.isAdmin }),
          }));
          return cors(await r.json().then((d) => json(d, r.status)));
        }

        
        // Pin
        if (method === "POST" && path.endsWith("/pin")) {
          const isCreator = meta.room.createdBy === meta.user.id;
          if (!isCreator && !meta.user.isAdmin) return cors(json({ error: "Only creator can pin" }, 403));
          const body = await request.json().catch(() => ({}));
          const r = await roomStub.fetch(new Request(new URL("/pin", request.url).toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId: body.messageId || null }),
          }));
          return cors(await r.json().then((d) => json(d, r.status)));
        }

        return cors(json({ error: "Unknown message action" }, 404));
      }

      const res = await hub.fetch(hubReq);
      return cors(res);
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const headers = new Headers(res.headers);
        headers.set("cache-control", "no-cache, must-revalidate");
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    return new Response("Durable Chat API", { status: 200 });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("access-control-allow-headers", "content-type,authorization");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h, webSocket: res.webSocket });
}
