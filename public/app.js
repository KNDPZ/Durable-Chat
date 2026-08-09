// Telegram-style Durable Chat client
let token = localStorage.getItem("dc_token") || null;
let me = null, currentRoom = null, currentMembers = [], activeUsers = [], ws = null;
let pendingSecret = null, pendingUsername = null, myContacts = [];
let selectedCreateMembers = new Set();
let replyToMsg = null, forwardMsg = null, reportTargetId = null;
let allRooms = { public: [], private: [] };
const REACTIONS = ["👍","👎","❤️","😂","😢","😠","🖕"];

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 4500);
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch("/api" + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("dc_theme", t);
  $("#themeLabel").textContent = t === "dark" ? "Light mode" : "Dark mode";
}
applyTheme(localStorage.getItem("dc_theme") || "dark");

// Drawer
function openDrawer() { $("#drawer").classList.add("open"); $("#drawerBackdrop").classList.add("open"); }
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawerBackdrop").classList.remove("open"); }
$("#menuBtn").onclick = openDrawer;
$("#drawerBackdrop").onclick = closeDrawer;
$("#drawerTheme").onclick = () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
};

function updateAuthUI() {
  if (me) {
    $("#drawerName").textContent = "@" + me.username;
    $("#drawerSub").textContent = me.isAdmin ? (me.isPrimaryAdmin || me.username === "admin" ? "Primary admin" : "Admin") : "Logged in";
    $("#drawerAuth").style.display = "none";
    $("#drawerLogout").style.display = "flex";
    $("#drawerContacts").style.display = "flex";
    $("#drawerSearch").style.display = "flex";
    $("#drawerCreate").style.display = "flex";
    $("#drawerAdmin").style.display = me.isAdmin ? "flex" : "none";
  } else {
    $("#drawerName").textContent = "Guest";
    $("#drawerSub").textContent = "Not logged in";
    $("#drawerAuth").style.display = "flex";
    $("#drawerLogout").style.display = "none";
    $("#drawerContacts").style.display = "none";
    $("#drawerSearch").style.display = "none";
    $("#drawerCreate").style.display = "none";
    $("#drawerAdmin").style.display = "none";
  }
}

$("#drawerAuth").onclick = () => { closeDrawer(); showAuthStep("choice"); openModal("authModal"); };
$("#drawerLogout").onclick = async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  token = null; me = null; localStorage.removeItem("dc_token");
  updateAuthUI(); closeDrawer(); loadRooms(); showEmpty();
};
$("#drawerContacts").onclick = () => { closeDrawer(); openModal("contactsModal"); loadContacts(); };
$("#drawerSearch").onclick = () => { closeDrawer(); openModal("searchModal"); };
$("#drawerCreate").onclick = () => { closeDrawer(); openCreateRoom(); };
$("#drawerAdmin").onclick = () => { closeDrawer(); openModal("adminModal"); loadAdminPanel("online"); };

function openModal(id) { $("#" + id).classList.add("open"); }
function closeModal(id) { $("#" + id).classList.remove("open"); }
["authModal","createRoomModal","contactsModal","searchModal","adminModal","membersModal","adminUserModal","reportModal","forwardModal","editHistoryModal","recoverModal"].forEach((id) => {
  const el = $("#" + id);
  if (el) el.onclick = (e) => { if (e.target === el) closeModal(id); };
});
$("#closeContacts").onclick = () => closeModal("contactsModal");
$("#closeSearch").onclick = () => closeModal("searchModal");
$("#closeAdmin").onclick = () => closeModal("adminModal");
$("#closeMembers").onclick = () => closeModal("membersModal");
$("#closeAdminUser").onclick = () => closeModal("adminUserModal");
$("#cancelReport").onclick = () => closeModal("reportModal");
$("#cancelForward").onclick = () => closeModal("forwardModal");
$("#closeEditHistory").onclick = () => closeModal("editHistoryModal");
$("#closeRecover").onclick = () => closeModal("recoverModal");
$("#cancelCreateRoom").onclick = () => closeModal("createRoomModal");

// Auth
function showAuthStep(step) {
  ["choice","login","register-user","register-totp"].forEach((s) => {
    const el = $("#authStep-" + s);
    if (el) el.style.display = s === step ? "block" : "none";
  });
  const t = { choice:["Welcome","Choose an option"], login:["Log in","Username + authenticator code"],
    "register-user":["Create account","Pick a username"], "register-totp":["Authenticator","Scan QR then enter code"] };
  $("#authTitle").textContent = t[step][0];
  $("#authDesc").textContent = t[step][1];
}
$("#showLogin").onclick = () => showAuthStep("login");
$("#showRegister").onclick = () => showAuthStep("register-user");
$("#backToChoice1").onclick = () => showAuthStep("choice");
$("#backToChoice2").onclick = () => showAuthStep("choice");
$("#backToUser").onclick = () => showAuthStep("register-user");

$("#doLogin").onclick = async () => {
  try {
    const d = await api("/auth/login", { method:"POST", body: JSON.stringify({ username: $("#loginUsername").value.trim(), code: $("#loginCode").value.trim() }) });
    token = d.token; me = d.user; localStorage.setItem("dc_token", token);
    closeModal("authModal"); updateAuthUI(); loadRooms(); startHeartbeat();
  } catch (e) { showError(e.message); }
};
$("#checkUsername").onclick = async () => {
  const username = $("#regUsername").value.trim();
  try {
    const d = await api("/auth/start-register", { method:"POST", body: JSON.stringify({ username }) });
    pendingUsername = username; pendingSecret = d.secret;
    $("#secretText").textContent = String(d.secret).replace(/=+$/g,"");
    $("#qrcode").innerHTML = "";
    new QRCode($("#qrcode"), { text: d.otpauthUrl, width:220, height:220, colorDark:"#000000", colorLight:"#ffffff", correctLevel: QRCode.CorrectLevel.H });
    showAuthStep("register-totp");
  } catch (e) { showError(e.message); }
};
$("#completeReg").onclick = async () => {
  const btn = $("#completeReg");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const d = await api("/auth/complete-register", { method:"POST", body: JSON.stringify({ username: pendingUsername, secret: pendingSecret, code: $("#regCode").value.trim() }) });
    token = d.token; me = d.user; localStorage.setItem("dc_token", token);
    closeModal("authModal"); updateAuthUI(); loadRooms(); startHeartbeat();
  } catch (e) { showError(e.message); btn.disabled = false; }
};

// Rooms list (sidebar)
async function loadRooms() {
  try {
    const data = await api("/rooms");
    allRooms = data;
    renderChatList();
  } catch {
    $("#chatList").innerHTML = '<div class="empty">Failed to load</div>';
  }
}

function renderChatList(filter = "") {
  const q = filter.trim().toLowerCase();
  const items = [];
  for (const r of allRooms.public || []) {
    if (q && !r.name.toLowerCase().includes(q)) continue;
    items.push({ ...r, kind: "room" });
  }
  for (const r of allRooms.private || []) {
    if (q && !r.name.toLowerCase().includes(q)) continue;
    items.push({ ...r, kind: r.id.startsWith("dm:") ? "dm" : "private" });
  }
  // sort: DMs and private first-ish by name for now
  items.sort((a, b) => {
    const order = { dm: 0, private: 1, room: 2 };
    const ka = a.kind === "dm" ? 0 : a.visibility === "private" ? 1 : 2;
    const kb = b.kind === "dm" ? 0 : b.visibility === "private" ? 1 : 2;
    if (ka !== kb) return ka - kb;
    return (a.name || "").localeCompare(b.name || "");
  });
  const box = $("#chatList");
  if (!items.length) { box.innerHTML = '<div class="empty">No chats yet</div>'; return; }
  box.innerHTML = items.map((r) => {
    const isDm = r.id.startsWith("dm:");
    const vis = isDm ? "dm" : r.visibility;
    const letter = (r.name || "?").replace(/^Direct message$/i, "DM").charAt(0).toUpperCase();
    const titleClass = isDm ? "chat-title dm" : "chat-title";
    const title = isDm ? r.name : r.name;
    return `<div class="chat-item ${currentRoom && currentRoom.id === r.id ? "active" : ""}" data-id="${r.id}">
      <div class="chat-avatar ${vis}">${esc(letter)}</div>
      <div class="chat-meta">
        <div class="${titleClass}">${esc(title)}</div>
        <div class="chat-sub">${isDm ? "Direct message" : r.visibility}</div>
      </div>
      <div class="chat-right"><span class="badge-vis badge-${isDm ? "private" : r.visibility}">${isDm ? "dm" : r.visibility}</span></div>
    </div>`;
  }).join("");
  box.querySelectorAll(".chat-item").forEach((el) => {
    el.onclick = () => openRoom(el.dataset.id);
  });
}
$("#sidebarSearch").oninput = () => renderChatList($("#sidebarSearch").value);

function showEmpty() {
  currentRoom = null;
  $("#emptyState").style.display = "flex";
  $("#chatView").style.display = "none";
  if (ws) try { ws.close(); } catch {}
}

async function openRoom(roomId) {
  try {
    const data = await api("/rooms/" + roomId + "/messages");
    currentRoom = data.room;
    currentMembers = data.members || [];
    activeUsers = data.activeUsers || [];
    $("#emptyState").style.display = "none";
    $("#chatView").style.display = "flex";
    renderChatList($("#sidebarSearch").value);
    renderHeader();
    renderPin(data.pinned);
    renderMessages(data.messages, data.room.visibility === "registered" && !me);
    const canPost = !!me && (data.room.visibility !== "private" || currentMembers.some((m) => m.id === me.id) || me.isAdmin);
    const restricted = me && (me.restrictionLevel | 0) >= 2;
    const restrictedPublic = me && (me.restrictionLevel | 0) === 1 && data.room.visibility !== "private";
    $("#chatInputRow").style.display = canPost && !restricted && !restrictedPublic ? "flex" : "none";
    $("#loginToChat").style.display = canPost && !restricted && !restrictedPublic ? "none" : "block";
    if (restricted) $("#loginToChat").textContent = "Your account is restricted from sending messages";
    else if (restrictedPublic) $("#loginToChat").textContent = "You are restricted from posting in this room";
    else if (!canPost) $("#loginToChat").textContent = me ? "You are not a member of this room" : "Log in to chat";
    const isCreator = me && data.room.createdBy === me.id;
    $("#headerDeleteBtn").style.display = isCreator || (me && me.isAdmin) ? "inline-block" : "none";
    // Members button: only private (not public rooms)
    const isPrivate = data.room.visibility === "private";
    $("#headerMembersBtn").style.display = isPrivate && me ? "inline-block" : "none";
    $("#headerManageBtn").style.display = isPrivate && me && (isCreator || data.room.allowMembersInvite) ? "inline-block" : "none";
    connectWS(roomId);
    // mobile
    if (window.innerWidth <= 720) {
      $("#sidebar").classList.add("hidden-mobile");
      $("#mainPane").classList.add("open-mobile");
      $("#backMobile").style.display = "inline-block";
    }
  } catch (e) { showError(e.message); }
}

function renderHeader() {
  if (!currentRoom) return;
  const isDm = currentRoom.id.startsWith("dm:");
  const titleEl = $("#headerTitle");
  const subEl = $("#headerSub");
  titleEl.className = "chat-header-title" + (isDm ? " dm" : "");
  if (isDm) {
    // DM title: other participant
    const other = currentMembers.filter((m) => !me || m.id !== me.id);
    titleEl.textContent = other.length ? other.map((m) => m.username).join(", ") : currentRoom.name;
    subEl.textContent = "Direct message";
  } else if (currentRoom.visibility === "private") {
    titleEl.textContent = currentRoom.name;
    // creator + up to 4 others
    const creatorId = currentRoom.createdBy;
    const sorted = [...currentMembers].sort((a, b) => {
      if (a.id === creatorId) return -1;
      if (b.id === creatorId) return 1;
      return a.username.localeCompare(b.username);
    });
    const shown = sorted.slice(0, 5);
    const extra = sorted.length - shown.length;
    let line = shown.map((m) => (m.id === creatorId ? m.username + " (creator)" : m.username)).join(", ");
    if (extra > 0) line += ` (and ${extra} other member${extra > 1 ? "s" : ""})`;
    subEl.textContent = line || "No members";
  } else {
    // public / registered — top active users
    titleEl.textContent = currentRoom.name;
    const top = (activeUsers || []).slice(0, 5);
    if (top.length) {
      let line = top.join(", ");
      if (activeUsers.length > 5) line += " (and others)";
      subEl.textContent = line;
    } else {
      subEl.textContent = currentRoom.visibility + " room";
    }
  }
}

function renderPin(pinned) {
  const bar = $("#pinBar");
  if (pinned && pinned.id) {
    bar.classList.add("open");
    $("#pinText").textContent = (pinned.username ? pinned.username + ": " : "") + (pinned.text || "");
    bar.onclick = () => scrollToMessage(pinned.id);
  } else {
    bar.classList.remove("open");
    bar.onclick = null;
  }
}

$("#headerDeleteBtn").onclick = async () => {
  if (!currentRoom || !confirm("Delete this room?")) return;
  try {
    await api("/rooms/" + currentRoom.id, { method: "DELETE" });
    showEmpty(); loadRooms();
  } catch (e) { showError(e.message); }
};
$("#headerMembersBtn").onclick = () => openMembersModal(false);
$("#headerManageBtn").onclick = () => openMembersModal(true);
$("#backMobile").onclick = () => {
  $("#sidebar").classList.remove("hidden-mobile");
  $("#mainPane").classList.remove("open-mobile");
  showEmpty();
};

async function openMembersModal(manage) {
  if (!currentRoom) return;
  try {
    currentMembers = await api("/rooms/" + currentRoom.id + "/members");
    renderHeader();
    $("#membersList").innerHTML = currentMembers.map((m) =>
      `<div class="item" style="cursor:default"><div>${m.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(m.username)}</strong>${m.id === currentRoom.createdBy ? ' <span class="badge-admin">creator</span>' : ""}</div>
       ${manage && me && me.id === currentRoom.createdBy && m.id !== currentRoom.createdBy ? `<button class="btn-ghost btn-sm remove-member" data-id="${m.id}">Remove</button>` : ""}</div>`
    ).join("") || '<div class="empty">No members</div>';
    $("#membersList").querySelectorAll(".remove-member").forEach((btn) => {
      btn.onclick = async () => {
        try { await api("/rooms/" + currentRoom.id + "/members/" + btn.dataset.id, { method: "DELETE" }); openMembersModal(true); }
        catch (e) { showError(e.message); }
      };
    });
    $("#addMemberSection").style.display = manage ? "block" : "none";
    if (manage) {
      if (!myContacts.length) myContacts = await api("/contacts").catch(() => []);
      const memberIds = new Set(currentMembers.map((m) => m.id));
      const available = myContacts.filter((c) => !memberIds.has(c.user.id));
      const picker = $("#addMemberPicker");
      if (!available.length) picker.innerHTML = '<div class="empty" style="padding:8px">No contacts to add</div>';
      else {
        picker.innerHTML = available.map((c) =>
          `<div class="item"><div>${c.user.online ? '<span class="online-dot"></span>' : ""}@${esc(c.user.username)}</div>
           <button class="btn btn-sm add-to-room" data-id="${c.user.id}">Add</button></div>`
        ).join("");
        picker.querySelectorAll(".add-to-room").forEach((btn) => {
          btn.onclick = async () => {
            try {
              const res = await api("/rooms/" + currentRoom.id + "/members", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
              if (res.error) throw new Error(res.error);
              openMembersModal(true);
            } catch (e) { showError(e.message); }
          };
        });
      }
    }
    openModal("membersModal");
  } catch (e) { showError(e.message); }
}

// Messages
function renderMessages(messages, blur) {
  const box = $("#messages");
  box.innerHTML = (messages || []).map((m) => messageHtml(m, blur)).join("");
  box.scrollTop = box.scrollHeight;
  bindMessageActions(box);
}

function messageHtml(m, blur) {
  if (m.isDeleted) {
    return `<div class="msg deleted" id="msg-${m.id}" data-id="${m.id}">
      <div class="meta">@${esc(m.username)}</div>
      <div>This message has been deleted</div>
      <div class="msg-time">${new Date(m.createdAt).toLocaleString()}</div></div>`;
  }
  const mine = me && m.userId === me.id;
  const isCreator = me && currentRoom && currentRoom.createdBy === me.id;
  let html = `<div class="msg ${mine ? "mine" : ""} ${blur ? "blurred" : ""}" id="msg-${m.id}" data-id="${m.id}">`;
  if (m.forward) {
    html += `<div class="forward-badge">Forwarded from ${esc(m.forward.roomName || "a room")} · @${esc(m.forward.username || "?")}
      <a href="#" class="goto-source" data-room="${m.forward.roomId || ""}" data-msg="${m.forward.messageId || ""}" style="color:var(--accent-hi)">View source</a></div>`;
  }
  if (m.replyTo) {
    html += `<div class="reply-preview" data-goto="${m.replyTo.id}"><strong>@${esc(m.replyTo.username)}</strong> ${esc(m.replyTo.text)}</div>`;
  }
  html += `<div class="meta">@${esc(m.username)}</div>`;
  html += `<div class="msg-body">${esc(m.text)}</div>`;
  if (m.editedAt) html += `<div class="edited-label" data-history="${m.id}">edited</div>`;
  const rx = m.reactions || {};
  const chips = Object.keys(rx).map((emoji) => {
    const users = rx[emoji] || [];
    const isMine = me && users.some((u) => u.userId === me.id);
    const names = users.map((u) => "@" + u.username).join(", ");
    return `<span class="reaction-chip ${isMine ? "mine" : ""}" data-react="${emoji}" data-id="${m.id}">${emoji} ${users.length}<span class="tip">${esc(names) || "No one"}</span></span>`;
  }).join("");
  if (chips) html += `<div class="reactions">${chips}</div>`;
  html += `<div class="msg-time">${new Date(m.createdAt).toLocaleString()}</div>`;
  if (!blur && me) {
    html += `<div class="msg-actions">
      <button data-act="reply" data-id="${m.id}">Reply</button>
      <button data-act="react" data-id="${m.id}">React</button>
      ${currentRoom && currentRoom.visibility === "public" ? `<button data-act="forward" data-id="${m.id}">Forward</button>` : ""}
      ${isCreator || (me && me.isAdmin) ? `<button data-act="pin" data-id="${m.id}">Pin</button>` : ""}
      ${mine ? `<button data-act="edit" data-id="${m.id}">Edit</button><button data-act="delete" data-id="${m.id}">Delete</button>` : ""}
    </div>
    <div class="emoji-picker" id="picker-${m.id}" style="display:none">${REACTIONS.map((e) => `<button data-emoji="${e}" data-id="${m.id}">${e}</button>`).join("")}</div>`;
  }
  html += `</div>`;
  return html;
}

function bindMessageActions(box) {
  box.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const el = document.getElementById("msg-" + id);
      if (act === "reply") {
        const body = el?.querySelector(".msg-body")?.textContent || "";
        const user = el?.querySelector(".meta")?.textContent?.replace("@","").trim() || "";
        replyToMsg = { id, username: user, text: body };
        $("#replyToName").textContent = "@" + user;
        $("#replyToText").textContent = body.slice(0, 100);
        $("#replyBar").classList.add("open");
        $("#msgInput").focus();
      } else if (act === "react") {
        const p = document.getElementById("picker-" + id);
        if (p) p.style.display = p.style.display === "none" ? "flex" : "none";
      } else if (act === "forward") {
        openForward(id);
      } else if (act === "pin") {
        api("/rooms/" + currentRoom.id + "/pin", { method: "POST", body: JSON.stringify({ messageId: id }) })
          .then((d) => renderPin(d.pinned)).catch((err) => showError(err.message));
      } else if (act === "edit") {
        const body = el?.querySelector(".msg-body")?.textContent || "";
        const next = prompt("Edit message:", body);
        if (next == null || next.trim() === body) return;
        api("/rooms/" + currentRoom.id + "/messages/" + id, { method: "PATCH", body: JSON.stringify({ text: next.trim() }) })
          .then((msg) => upsertMessage(msg)).catch((err) => showError(err.message));
      } else if (act === "delete") {
        if (!confirm("Delete this message?")) return;
        api("/rooms/" + currentRoom.id + "/messages/" + id, { method: "DELETE", body: JSON.stringify({}) })
          .then((msg) => upsertMessage(msg)).catch((err) => showError(err.message));
      }
    };
  });
  box.querySelectorAll(".emoji-picker button").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      api("/rooms/" + currentRoom.id + "/messages/" + btn.dataset.id + "/react", {
        method: "POST", body: JSON.stringify({ emoji: btn.dataset.emoji }),
      }).then((msg) => { upsertMessage(msg); const p = document.getElementById("picker-" + btn.dataset.id); if (p) p.style.display = "none"; })
        .catch((err) => showError(err.message));
    };
  });
  box.querySelectorAll(".reaction-chip").forEach((chip) => {
    chip.onclick = (e) => {
      e.stopPropagation();
      api("/rooms/" + currentRoom.id + "/messages/" + chip.dataset.id + "/react", {
        method: "POST", body: JSON.stringify({ emoji: chip.dataset.react }),
      }).then((msg) => upsertMessage(msg)).catch((err) => showError(err.message));
    };
  });
  box.querySelectorAll(".reply-preview").forEach((el) => {
    el.onclick = () => scrollToMessage(el.dataset.goto);
  });
  box.querySelectorAll(".edited-label").forEach((el) => {
    el.onclick = async () => {
      try {
        const hist = await api("/rooms/" + currentRoom.id + "/messages/" + el.dataset.history + "/history");
        $("#editHistoryList").innerHTML = hist.length
          ? hist.map((h) => `<div class="history-msg"><div class="history-meta">${new Date(h.editedAt).toLocaleString()}</div><div>${esc(h.text)}</div></div>`).join("")
          : '<div class="empty">No history</div>';
        openModal("editHistoryModal");
      } catch (err) { showError(err.message); }
    };
  });
  box.querySelectorAll(".goto-source").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      if (a.dataset.room) openRoom(a.dataset.room).then(() => {
        if (a.dataset.msg) setTimeout(() => scrollToMessage(a.dataset.msg), 300);
      });
    };
  });
}

function upsertMessage(msg) {
  const existing = document.getElementById("msg-" + msg.id);
  const box = $("#messages");
  const html = messageHtml(msg, false);
  if (existing) existing.outerHTML = html;
  else { box.insertAdjacentHTML("beforeend", html); box.scrollTop = box.scrollHeight; }
  bindMessageActions(box);
}

function scrollToMessage(id) {
  const el = document.getElementById("msg-" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("highlight");
  void el.offsetWidth;
  el.classList.add("highlight");
  setTimeout(() => el.classList.remove("highlight"), 1600);
}

function connectWS(roomId) {
  if (ws) try { ws.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/room/${roomId}`);
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.t === "message" || data.t === "message_update") upsertMessage(data.message);
      if (data.t === "pin") renderPin(data.pinned);
    } catch {}
  };
}

async function sendMsg() {
  const text = $("#msgInput").value.trim();
  if (!text || !currentRoom) return;
  try {
    const body = { text };
    if (replyToMsg) body.replyToId = replyToMsg.id;
    await api("/rooms/" + currentRoom.id + "/messages", { method: "POST", body: JSON.stringify(body) });
    $("#msgInput").value = "";
    replyToMsg = null;
    $("#replyBar").classList.remove("open");
  } catch (e) { showError(e.message); }
}
$("#sendBtn").onclick = sendMsg;
$("#msgInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } };
$("#cancelReply").onclick = () => { replyToMsg = null; $("#replyBar").classList.remove("open"); };

async function openForward(msgId) {
  if (!currentRoom || currentRoom.visibility !== "public") { showError("Can only forward from public rooms"); return; }
  const el = document.getElementById("msg-" + msgId);
  forwardMsg = {
    id: msgId,
    text: el?.querySelector(".msg-body")?.textContent || "",
    username: el?.querySelector(".meta")?.textContent?.replace("@","").trim() || "",
    roomId: currentRoom.id,
    roomName: currentRoom.name,
  };
  try {
    const full = await api("/rooms/" + currentRoom.id + "/messages/" + msgId);
    forwardMsg.reactions = full.reactions || {};
  } catch {}
  if (!myContacts.length) myContacts = await api("/contacts").catch(() => []);
  const list = $("#forwardContactList");
  if (!myContacts.length) list.innerHTML = '<div class="empty">No contacts</div>';
  else {
    list.innerHTML = myContacts.map((c) =>
      `<div class="item"><div>@${esc(c.user.username)}</div><button class="btn btn-sm fwd-to" data-id="${c.user.id}">Send</button></div>`
    ).join("");
    list.querySelectorAll(".fwd-to").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const room = await api("/dm", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
          await api("/rooms/" + room.id + "/messages", {
            method: "POST",
            body: JSON.stringify({
              text: forwardMsg.text,
              forward: { roomId: forwardMsg.roomId, messageId: forwardMsg.id, roomName: forwardMsg.roomName, username: forwardMsg.username, text: forwardMsg.text, reactions: forwardMsg.reactions },
            }),
          });
          closeModal("forwardModal");
          openRoom(room.id);
        } catch (err) { showError(err.message); }
      };
    });
  }
  openModal("forwardModal");
}

// Create room
async function openCreateRoom() {
  openModal("createRoomModal");
  $("#newRoomName").value = "";
  selectedCreateMembers = new Set();
  $("#newRoomVis").value = "public";
  $("#privateOpts").style.display = "none";
  await refreshCreateMemberPicker();
}
$("#newRoomVis").onchange = () => { $("#privateOpts").style.display = $("#newRoomVis").value === "private" ? "block" : "none"; };
$$(".degree-option").forEach((opt) => {
  opt.onclick = () => {
    $$(".degree-option").forEach((o) => o.classList.remove("selected"));
    opt.classList.add("selected");
    opt.querySelector("input").checked = true;
  };
});
async function refreshCreateMemberPicker() {
  const box = $("#createMemberPicker");
  if (!me) { box.innerHTML = '<div class="empty" style="padding:8px">Login first</div>'; return; }
  try {
    myContacts = await api("/contacts");
    if (!myContacts.length) { box.innerHTML = '<div class="empty" style="padding:8px">No contacts</div>'; return; }
    box.innerHTML = myContacts.map((c) =>
      `<label style="display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer">
        <input type="checkbox" value="${c.user.id}" class="create-member-cb" style="width:auto"/>
        ${c.user.online ? '<span class="online-dot"></span>' : ""}@${esc(c.user.username)}</label>`
    ).join("");
    box.querySelectorAll(".create-member-cb").forEach((cb) => {
      cb.onchange = () => { if (cb.checked) selectedCreateMembers.add(cb.value); else selectedCreateMembers.delete(cb.value); };
    });
  } catch { box.innerHTML = '<div class="empty" style="padding:8px">Failed</div>'; }
}
$("#doCreateRoom").onclick = async () => {
  try {
    const visibility = $("#newRoomVis").value;
    const body = { name: $("#newRoomName").value.trim(), visibility };
    if (visibility === "private") {
      body.allowMembersInvite = $("#allowMembersInvite").checked;
      body.inviteDegree = document.querySelector('input[name="inviteDegree"]:checked')?.value || "contacts";
      body.memberIds = [...selectedCreateMembers];
    }
    const room = await api("/rooms", { method: "POST", body: JSON.stringify(body) });
    if (room.error) throw new Error(room.error);
    closeModal("createRoomModal");
    await loadRooms();
    openRoom(room.id);
  } catch (e) { showError(e.message); }
};

// Contacts
async function loadContacts() {
  if (!me) { $("#contactsList").innerHTML = '<div class="empty">Login required</div>'; return; }
  try {
    myContacts = await api("/contacts");
    if (!myContacts.length) { $("#contactsList").innerHTML = '<div class="empty">No contacts yet</div>'; return; }
    $("#contactsList").innerHTML = myContacts.map((c) =>
      `<div class="item" style="cursor:default">
        <div>${c.user.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(c.user.username)}</strong>
          ${c.isFriend ? ' <span class="badge-friend">Friends</span>' : ""}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm msg-contact" data-id="${c.user.id}">Message</button>
          <button class="btn-ghost btn-sm remove-contact" data-id="${c.user.id}">Remove</button>
        </div></div>`
    ).join("");
    $("#contactsList").querySelectorAll(".msg-contact").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const room = await api("/dm", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
          closeModal("contactsModal");
          await loadRooms();
          openRoom(room.id);
        } catch (e) { showError(e.message); }
      };
    });
    $("#contactsList").querySelectorAll(".remove-contact").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Remove contact?")) return;
        try { await api("/contacts/" + btn.dataset.id, { method: "DELETE" }); loadContacts(); }
        catch (e) { showError(e.message); }
      };
    });
  } catch { $("#contactsList").innerHTML = '<div class="empty">Failed</div>'; }
}

// Search
let searchTimer;
$("#searchInput").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 300); };
async function doSearch() {
  const q = $("#searchInput").value.trim();
  if (!q) { $("#searchResults").innerHTML = '<div class="empty">Type to search</div>'; return; }
  try {
    const users = await api("/users/search?q=" + encodeURIComponent(q));
    if (!users.length) { $("#searchResults").innerHTML = '<div class="empty">No users</div>'; return; }
    $("#searchResults").innerHTML = users.map((u) =>
      `<div class="item"><div>${u.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(u.username)}</strong>${u.isAdmin ? ' <span class="badge-admin">admin</span>' : ""}</div>
       <button class="btn-ghost btn-sm add-contact-btn" data-id="${u.id}">Add contact</button></div>`
    ).join("");
    $("#searchResults").querySelectorAll(".add-contact-btn").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (!me) { showError("Login required"); return; }
        try {
          const res = await api("/contacts", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
          if (res.error) throw new Error(res.error);
          btn.textContent = "Added"; btn.disabled = true;
        } catch (err) { showError(err.message); }
      };
    });
  } catch (e) { showError(e.message); }
}

// Admin
$$(".sub-tab").forEach((st) => {
  st.onclick = () => {
    $$(".sub-tab").forEach((t) => t.classList.remove("active"));
    st.classList.add("active");
    ["online","users","admins","lookup","reports"].forEach((p) => {
      const el = $("#admin-" + p);
      if (el) el.style.display = st.dataset.admin === p ? "block" : "none";
    });
    if (st.dataset.admin !== "lookup") loadAdminPanel(st.dataset.admin);
  };
});

async function loadAdminPanel(which) {
  const el = $("#admin-" + which);
  if (!el || which === "lookup") return;
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (which === "reports") {
      const reports = await api("/admin/reports");
      if (!reports.length) { el.innerHTML = '<div class="empty">No reports</div>'; return; }
      el.innerHTML = reports.map((r) =>
        `<div class="item report-row" style="flex-direction:column;align-items:stretch;gap:6px">
          <div style="display:flex;justify-content:space-between;width:100%">
            <div><strong>@${esc(r.reported.username)}</strong> by @${esc(r.reporter.username)}
              ${r.resolved ? ' <span class="badge-admin">resolved</span>' : ' <span class="badge-private">open</span>'}
              ${r.reported.restrictionLevel ? ' <span class="badge-private">R'+r.reported.restrictionLevel+'</span>' : ""}
            </div>
            <button class="btn btn-sm" data-id="${r.reported.id}">View</button>
          </div>
          <div style="font-size:.85rem;color:var(--muted)">${esc(r.reason)}</div>
        </div>`
      ).join("");
      el.querySelectorAll("button[data-id]").forEach((btn) => {
        btn.onclick = (e) => { e.stopPropagation(); openAdminUser(btn.dataset.id); };
      });
      return;
    }
    const path = which === "online" ? "/admin/online" : which === "admins" ? "/admin/admins" : "/admin/users";
    const users = await api(path);
    if (!users.length) { el.innerHTML = '<div class="empty">None</div>'; return; }
    el.innerHTML = users.map((u) =>
      `<div class="item"><div>${u.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(u.username)}</strong>${u.isAdmin ? ' <span class="badge-admin">admin</span>' : ""}${u.restrictionLevel ? ' <span class="badge-private">R'+u.restrictionLevel+'</span>' : ""}</div>
       <button class="btn btn-sm" data-id="${u.id}">View</button></div>`
    ).join("");
    el.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); openAdminUser(btn.dataset.id); };
    });
  } catch { el.innerHTML = '<div class="empty">Failed</div>'; }
}

let adminSearchTimer;
$("#adminSearchInput").oninput = () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(doAdminSearch, 300); };
async function doAdminSearch() {
  const q = $("#adminSearchInput").value.trim();
  if (!q) { $("#adminSearchResults").innerHTML = '<div class="empty">Type to search</div>'; return; }
  try {
    const users = await api("/users/search?q=" + encodeURIComponent(q));
    if (!users.length) { $("#adminSearchResults").innerHTML = '<div class="empty">None</div>'; return; }
    $("#adminSearchResults").innerHTML = users.map((u) =>
      `<div class="item"><div>${u.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(u.username)}</strong></div>
       <button class="btn btn-sm" data-id="${u.id}">View</button></div>`
    ).join("");
    $("#adminSearchResults").querySelectorAll("button[data-id]").forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); openAdminUser(btn.dataset.id); };
    });
  } catch (e) { showError(e.message); }
}

async function openAdminUser(userId) {
  try {
    const data = await api("/admin/user/" + userId);
    $("#adminUserTitle").textContent = "@" + data.user.username;
    $("#adminUserMeta").textContent =
      (data.user.isAdmin ? "Admin · " : "") +
      (data.user.online ? "Online · " : "Offline · ") +
      (data.user.restrictionLevel ? "Restricted L" + data.user.restrictionLevel + " · " : "") +
      "Joined " + new Date(data.user.createdAt).toLocaleDateString();
    const actions = $("#adminUserActions");
    actions.innerHTML = "";
    const adminBtn = document.createElement("button");
    adminBtn.className = "btn btn-sm";
    if (data.user.username === "admin") { adminBtn.textContent = "Primary admin"; adminBtn.disabled = true; }
    else if (data.user.isAdmin) {
      adminBtn.textContent = "Remove admin"; adminBtn.classList.add("btn-danger");
      adminBtn.onclick = async () => {
        if (!confirm("Remove admin?")) return;
        try { await api("/admin/user/" + userId + "/set-admin", { method: "POST", body: JSON.stringify({ isAdmin: false }) }); openAdminUser(userId); }
        catch (e) { showError(e.message); }
      };
    } else {
      adminBtn.textContent = "Make admin";
      adminBtn.onclick = async () => {
        try { await api("/admin/user/" + userId + "/set-admin", { method: "POST", body: JSON.stringify({ isAdmin: true }) }); openAdminUser(userId); }
        catch (e) { showError(e.message); }
      };
    }
    actions.appendChild(adminBtn);
    const recoverBtn = document.createElement("button");
    recoverBtn.className = "btn btn-sm";
    recoverBtn.style.cssText = "background:var(--surface2);color:var(--text)";
    recoverBtn.textContent = "Recover account";
    recoverBtn.onclick = async () => {
      if (!confirm("Generate new authenticator secret?")) return;
      try {
        const res = await api("/admin/user/" + userId + "/recover", { method: "POST" });
        $("#recoverUsername").textContent = res.username;
        $("#recoverSecret").textContent = String(res.secret).replace(/=+$/g, "");
        $("#recoverQr").innerHTML = "";
        new QRCode($("#recoverQr"), { text: res.otpauthUrl, width:220, height:220, colorDark:"#000", colorLight:"#fff", correctLevel: QRCode.CorrectLevel.H });
        closeModal("adminUserModal");
        openModal("recoverModal");
      } catch (e) { showError(e.message); }
    };
    actions.appendChild(recoverBtn);
    if (me && me.isAdmin && data.user.username !== "admin") {
      const reportBtn = document.createElement("button");
      reportBtn.className = "btn btn-sm";
      reportBtn.style.cssText = "background:var(--surface2)";
      reportBtn.textContent = "Report";
      reportBtn.onclick = () => {
        reportTargetId = data.user.id;
        $("#reportUsername").textContent = data.user.username;
        $("#reportReason").value = "";
        closeModal("adminUserModal");
        openModal("reportModal");
      };
      actions.appendChild(reportBtn);
    }
    if (me && me.username === "admin" && data.user.username !== "admin") {
      const lv = data.user.restrictionLevel | 0;
      [0, 1, 2].forEach((level) => {
        const b = document.createElement("button");
        b.className = "btn btn-sm";
        b.style.cssText = lv === level ? "outline:2px solid var(--accent-hi)" : "background:var(--surface2)";
        b.textContent = level === 0 ? "Unrestrict" : ("Restrict L" + level);
        b.onclick = async () => {
          try {
            await api("/admin/user/" + data.user.id + "/restrict", { method: "POST", body: JSON.stringify({ level }) });
            openAdminUser(data.user.id);
          } catch (err) { showError(err.message); }
        };
        actions.appendChild(b);
      });
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-sm btn-danger";
      delBtn.textContent = "Delete user";
      delBtn.onclick = async () => {
        if (!confirm("Permanently delete @" + data.user.username + "?")) return;
        try {
          await api("/admin/user/" + data.user.id, { method: "DELETE" });
          closeModal("adminUserModal");
          loadAdminPanel("users");
        } catch (err) { showError(err.message); }
      };
      actions.appendChild(delBtn);
    }
    $("#adminContacts").innerHTML = data.contacts.length
      ? data.contacts.map((c) => `<div class="item" style="cursor:default"><strong>@${esc(c.user.username)}</strong></div>`).join("")
      : '<div class="empty" style="padding:12px">No contacts</div>';
    $("#adminHistory").innerHTML = data.messages.length
      ? data.messages.map((m) => `<div class="history-msg"><div class="history-meta">${new Date(m.createdAt).toLocaleString()}</div><div>${esc(m.text)}</div></div>`).join("")
      : '<div class="empty" style="padding:12px">No messages</div>';
    openModal("adminUserModal");
  } catch (e) { showError(e.message); }
}

$("#submitReport").onclick = async () => {
  try {
    await api("/report", { method: "POST", body: JSON.stringify({ userId: reportTargetId, reason: $("#reportReason").value.trim() }) });
    closeModal("reportModal");
    showError("Report submitted");
  } catch (e) { showError(e.message); }
};

let heartbeatTimer = null;
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (!me) return;
  const beat = () => api("/presence/heartbeat", { method: "POST" }).catch(() => {});
  beat();
  heartbeatTimer = setInterval(beat, 45000);
}

(async () => {
  if (token) {
    try {
      const d = await api("/auth/me");
      me = d.user;
      if (!me) { token = null; localStorage.removeItem("dc_token"); }
    } catch { token = null; localStorage.removeItem("dc_token"); }
  }
  updateAuthUI();
  loadRooms();
  if (me) startHeartbeat();
})();
