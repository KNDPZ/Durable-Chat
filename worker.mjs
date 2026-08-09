// worker.mjs — front door (pattern from Tongits worker.mjs)
//   /api/*  -> Hub DO
//   /ws/room/:id -> ChatRoom DO
//   static -> ASSETS

export { Hub } from "./hub-do.mjs";
export { ChatRoom } from "./room-do.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // Room WebSocket
    if (path.startsWith("/ws/room/")) {
      const roomId = path.split("/").pop();
      if (!roomId) return new Response("missing room", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    // API -> Hub DO (rewrite path without /api prefix)
    if (path.startsWith("/api/")) {
      const hub = env.HUB.get(env.HUB.idFromName("global"));
      const u = new URL(request.url);
      u.pathname = path.slice("/api".length) || "/";
      const hubReq = new Request(u.toString(), request);

      // Special: post message goes to room DO then logs to hub
      const msgMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      if (msgMatch && request.method === "POST") {
        const roomId = msgMatch[1];
        // Auth + membership via hub meta
        const metaUrl = new URL(request.url);
        metaUrl.pathname = "/rooms/" + roomId + "/meta";
        const metaRes = await hub.fetch(new Request(metaUrl.toString(), {
          headers: { Authorization: request.headers.get("Authorization") || "" },
        }));
        const meta = await metaRes.json();
        if (!metaRes.ok) return cors(json(meta, metaRes.status));
        if (!meta.user) return cors(json({ error: "Login required to post" }, 401));
        if (meta.room.visibility === "private") {
          const isMember = (meta.members || []).some((m) => m.id === meta.user.id);
          if (!isMember && !meta.user.isAdmin) return cors(json({ error: "Private room" }, 403));
        }
        const body = await request.json().catch(() => ({}));
        const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        const postUrl = new URL(request.url);
        postUrl.pathname = "/messages";
        const postRes = await roomStub.fetch(new Request(postUrl.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body.text, userId: meta.user.id, username: meta.user.username }),
        }));
        const msg = await postRes.json();
        if (postRes.ok && msg.id) {
          const logUrl = new URL(request.url);
          logUrl.pathname = "/log-message";
          await hub.fetch(new Request(logUrl.toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: msg.id, roomId, userId: meta.user.id, username: meta.user.username, text: msg.text }),
          }));
        }
        return cors(json(msg, postRes.status));
      }

      // GET messages: meta from hub + messages from room
      if (msgMatch && request.method === "GET") {
        const roomId = msgMatch[1];
        const metaUrl = new URL(request.url);
        metaUrl.pathname = "/rooms/" + roomId + "/meta";
        const metaRes = await hub.fetch(new Request(metaUrl.toString(), {
          headers: { Authorization: request.headers.get("Authorization") || "" },
        }));
        const meta = await metaRes.json();
        if (!metaRes.ok) return cors(json(meta, metaRes.status));
        const roomStub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        const listUrl = new URL(request.url);
        listUrl.pathname = "/messages";
        const listRes = await roomStub.fetch(new Request(listUrl.toString()));
        let messages = await listRes.json();
        if (meta.room.visibility === "registered" && !meta.user) {
          messages = messages.map((m) => ({ ...m, text: "•••••••• (login to read)", username: "•••" }));
        }
        return cors(json({ room: meta.room, messages, members: meta.members || [] }));
      }

      const res = await hub.fetch(hubReq);
      return cors(res);
    }

    // Static assets
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const h = new Headers(res.headers);
        h.set("cache-control", "no-cache, must-revalidate");
        return new Response(res.body, { status: res.status, headers: h });
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
  h.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  h.set("access-control-allow-headers", "content-type,authorization");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h, webSocket: res.webSocket });
}
