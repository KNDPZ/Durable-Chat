// Telegram-style Durable Chat client
let token = localStorage.getItem("dc_token") || null;
let me = null, currentRoom = null, currentMembers = [], activeUsers = [], ws = null;
let pendingSecret = null, pendingUsername = null, myContacts = [];
let selectedCreateMembers = new Set();
let replyToMsg = null, forwardMsg = null, reportTargetId = null;
let allRooms = { public: [], private: [] };
let sidebarTab = "dms";
let unreadMap = {};
let dmSeen = false;
const REACTIONS = ["👍","👎","❤️","😂","😢","😠","🖕"];

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function letterAvatar(name, url, sizeClass) {
  const letter = (name || "?").charAt(0).toUpperCase();
  if (url) return `<div class="chat-avatar has-img ${sizeClass||""}" style="background-image:url('${esc(url)}')"></div>`;
  return `<div class="chat-avatar ${sizeClass||""}">${esc(letter)}</div>`;
}

function groupAvatarStack(previews, count, roomAvatarUrl) {
  if (roomAvatarUrl) {
    return `<div class="chat-avatar has-img private" style="background-image:url('${esc(roomAvatarUrl)}')"></div>`;
  }
  const list = previews || [];
  const total = count || list.length;
  if (!list.length) return `<div class="chat-avatar private">G</div>`;
  if (total === 1) return letterAvatar(list[0].username, list[0].avatarUrl, "private");
  // Up to 3 faces; 4th cell is count if more than 4 people, else 4th face if exactly 4
  let html = '<div class="avatar-stack">';
  if (total > 4) {
    list.slice(0, 3).forEach((m, i) => {
      const bg = m.avatarUrl ? `background-image:url('${esc(m.avatarUrl)}')` : "";
      const letter = (m.username || "?").charAt(0).toUpperCase();
      html += `<div class="s s${i+1}" style="${bg}">${m.avatarUrl ? "" : esc(letter)}</div>`;
    });
    html += `<div class="s s4">${total - 3}+</div>`;
  } else {
    list.slice(0, 4).forEach((m, i) => {
      const bg = m.avatarUrl ? `background-image:url('${esc(m.avatarUrl)}')` : "";
      const letter = (m.username || "?").charAt(0).toUpperCase();
      html += `<div class="s s${i+1}" style="${bg}">${m.avatarUrl ? "" : esc(letter)}</div>`;
    });
  }
  html += "</div>";
  return html;
}

function msgAvatarHtml(username, avatarUrl) {
  const letter = (username || "?").charAt(0).toUpperCase();
  if (avatarUrl) return `<div class="msg-avatar" style="background-image:url('${esc(avatarUrl)}')"></div>`;
  return `<div class="msg-avatar">${esc(letter)}</div>`;
}

// Crop state
let cropState = { img: null, scale: 1, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0, onDone: null };

function openCropper(file, onDone) {
  const img = new Image();
  img.onload = () => {
    cropState = { img, scale: 1, ox: 0, oy: 0, dragging: false, lx: 0, ly: 0, onDone };
    $("#cropZoom").value = 100;
    drawCrop();
    openModal("cropModal");
  };
  img.src = URL.createObjectURL(file);
}

function drawCrop() {
  const canvas = $("#cropCanvas");
  if (!canvas || !cropState.img) return;
  const ctx = canvas.getContext("2d");
  const size = 320;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, size, size);
  const img = cropState.img;
  const base = Math.max(size / img.width, size / img.height) * cropState.scale;
  const w = img.width * base;
  const h = img.height * base;
  const x = (size - w) / 2 + cropState.ox;
  const y = (size - h) / 2 + cropState.oy;
  ctx.drawImage(img, x, y, w, h);
  // circle mask overlay
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.arc(size/2, size/2, size/2 - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // redraw image clipped - simpler approach: dark corners
  ctx.globalCompositeOperation = "source-over";
}

function getCroppedBlob() {
  return new Promise((resolve) => {
    const size = 320;
    const out = document.createElement("canvas");
    out.width = size; out.height = size;
    const ctx = out.getContext("2d");
    const img = cropState.img;
    const base = Math.max(size / img.width, size / img.height) * cropState.scale;
    const w = img.width * base;
    const h = img.height * base;
    const x = (size - w) / 2 + cropState.ox;
    const y = (size - h) / 2 + cropState.oy;
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    out.toBlob((b) => resolve(b), "image/jpeg", 0.9);
  });
}

$("#cropZoom").oninput = () => {
  cropState.scale = Number($("#cropZoom").value) / 100;
  drawCrop();
};
(function bindCropDrag() {
  const canvas = () => $("#cropCanvas");
  const down = (e) => {
    cropState.dragging = true;
    const p = e.touches ? e.touches[0] : e;
    cropState.lx = p.clientX; cropState.ly = p.clientY;
  };
  const move = (e) => {
    if (!cropState.dragging) return;
    e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    cropState.ox += p.clientX - cropState.lx;
    cropState.oy += p.clientY - cropState.ly;
    cropState.lx = p.clientX; cropState.ly = p.clientY;
    drawCrop();
  };
  const up = () => { cropState.dragging = false; };
  document.addEventListener("DOMContentLoaded", () => {});
  setTimeout(() => {
    const c = $("#cropCanvas");
    if (!c) return;
    c.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    c.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  }, 0);
})();
$("#cancelCrop").onclick = () => { closeModal("cropModal"); cropState.onDone = null; };
$("#applyCrop").onclick = async () => {
  const blob = await getCroppedBlob();
  closeModal("cropModal");
  if (cropState.onDone) cropState.onDone(blob);
};



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
    const av = $("#drawerAvatar");
    if (av) {
      if (me.avatarUrl) { av.style.backgroundImage = "url(" + me.avatarUrl + "?t=" + Date.now() + ")"; av.textContent = ""; }
      else { av.style.backgroundImage = ""; av.textContent = me.username.charAt(0).toUpperCase(); }
    }
    $("#drawerAuth").style.display = "none";
    $("#drawerLogout").style.display = "flex";
    $("#drawerContacts").style.display = "flex";
    $("#drawerBlocked").style.display = "flex";
    $("#drawerCreate").style.display = "flex";
    $("#drawerAdmin").style.display = me.isAdmin ? "flex" : "none";
  } else {
    $("#drawerName").textContent = "Guest";
    $("#drawerSub").textContent = "Not logged in";
    const av = $("#drawerAvatar");
    if (av) { av.style.backgroundImage = ""; av.textContent = "?"; }
    $("#drawerAuth").style.display = "flex";
    $("#drawerLogout").style.display = "none";
    $("#drawerContacts").style.display = "none";
    $("#drawerBlocked").style.display = "none";
    $("#drawerCreate").style.display = "none";
    $("#drawerAdmin").style.display = "none";
  }
}

$("#drawerAuth").onclick = () => { closeDrawer(); showAuthStep("choice"); openModal("authModal"); };
$("#drawerLogout").onclick = async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  token = null; me = null; localStorage.removeItem("dc_token");
  updateAuthUI(); closeDrawer();
  location.href = "/";
};
$("#drawerContacts").onclick = () => { closeDrawer(); openModal("contactsModal"); loadContacts(); };
$("#drawerCreate").onclick = () => { closeDrawer(); openCreateRoom(); };
$("#drawerAdmin").onclick = () => { closeDrawer(); openModal("adminModal"); loadAdminPanel("online"); };

function openModal(id) { $("#" + id).classList.add("open"); }
function closeModal(id) { $("#" + id).classList.remove("open"); }
["authModal","createRoomModal","contactsModal","searchModal","adminModal","membersModal","adminUserModal","reportModal","forwardModal","editHistoryModal","recoverModal","roomSettingsModal","notifModal"].forEach((id) => {
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
    try { unreadMap = await api("/rooms/unread"); } catch { unreadMap = {}; }
    renderChatList($("#sidebarSearch").value);
    refreshBell();
  } catch {
    $("#chatList").innerHTML = '<div class="empty">Failed to load</div>';
  }
}


function renderChatList(filter = "") {
  const q = filter.trim().toLowerCase();
  const box = $("#chatList");
  let items = [];

  if (sidebarTab === "dms") {
    items = (allRooms.private || []).filter((r) => r.isDm || (r.id && r.id.startsWith("dm:")));
  } else if (sidebarTab === "joined") {
    // private non-DM rooms user is in
    items = (allRooms.private || []).filter((r) => !r.isDm && !(r.id && r.id.startsWith("dm:")));
  } else {
    items = allRooms.public || [];
  }

  if (q) {
    items = items.filter((r) => {
      const name = (r.displayName || r.name || "").toLowerCase();
      return name.includes(q);
    });
  }

  items.sort((a, b) => (a.displayName || a.name || "").localeCompare(b.displayName || b.name || ""));

  if (!items.length) {
    box.innerHTML = '<div class="empty">' + (q ? "No matches" : "Nothing here yet") + "</div>";
    return;
  }

  box.innerHTML = items.map((r) => {
    const isDm = r.isDm || (r.id && r.id.startsWith("dm:"));
    const vis = isDm ? "dm" : r.visibility;
    const title = r.displayName || r.name || "Chat";
    const titleClass = isDm ? "chat-title dm" : "chat-title";
    const sub = isDm ? "Direct message" : (r.visibility || "");
    let avHtml;
    if (isDm) {
      avHtml = letterAvatar(title, r.peerAvatarUrl, "dm");
    } else if (r.visibility === "private") {
      avHtml = groupAvatarStack(r.memberPreviews, r.memberCount, r.avatarUrl);
    } else {
      avHtml = letterAvatar(title, r.avatarUrl, vis);
    }
    return `<div class="chat-item ${currentRoom && currentRoom.id === r.id ? "active" : ""} ${unreadMap[r.id] ? "unread" : ""}" data-id="${r.id}">
      ${avHtml}
      <div class="chat-meta">
        <div class="${titleClass}">${esc(title)}</div>
        <div class="chat-sub">${esc(sub)}</div>
      </div>
      <div class="chat-right">
        ${unreadMap[r.id] ? `<span class="unread-badge">${unreadMap[r.id] > 99 ? "99+" : unreadMap[r.id]}</span>` : `<span class="badge-vis badge-${isDm ? "private" : r.visibility}">${isDm ? "dm" : r.visibility}</span>`}
      </div>
    </div>`;
  }).join("");
  box.querySelectorAll(".chat-item").forEach((el) => {
    el.onclick = () => openRoom(el.dataset.id);
  });
}

$("#sidebarSearch").oninput = async () => {
  const q = $("#sidebarSearch").value.trim();
  if (q.length >= 1) await doGlobalSearch(q);
  else renderChatList("");
};
$$(".stab").forEach((t) => {
  t.onclick = () => {
    $$(".stab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    sidebarTab = t.dataset.tab;
    renderChatList($("#sidebarSearch").value);
  };
});

async function doGlobalSearch(q) {
  try {
    // @user search
    if (q.trim().startsWith("@")) {
      const users = await api("/users/search?q=" + encodeURIComponent(q.trim()));
      const box = $("#chatList");
      if (!users.length) { box.innerHTML = '<div class="empty">No users</div>'; return; }
      box.innerHTML = '<div style="padding:8px 14px;font-size:.72rem;color:var(--muted);text-transform:uppercase">Users</div>' +
        users.map((u) => {
          if (me && u.id === me.id) {
            return `<div class="chat-item" data-self="1">
              ${letterAvatar(u.username, u.avatarUrl, "dm")}
              <div class="chat-meta"><div class="chat-title dm">@${esc(u.username)}</div>
              <div class="chat-sub">That's you — tap for profile</div></div></div>`;
          }
          const btns = me ? `<div class="chat-right" style="display:flex;gap:4px;flex-direction:column">
            ${!u.isContact ? `<button class="btn btn-sm add-from-search" data-id="${u.id}">Add contact</button>` : ""}
            <button class="btn-ghost btn-sm block-from-search" data-id="${u.id}">Block</button>
          </div>` : "";
          return `<div class="chat-item" data-user="${u.id}">
            ${letterAvatar(u.username, u.avatarUrl, "dm")}
            <div class="chat-meta"><div class="chat-title dm">@${esc(u.username)}</div>
            <div class="chat-sub">${u.isContact ? "In contacts" : "Not in contacts"}</div></div>
            ${btns}
          </div>`;
        }).join("");
      box.querySelectorAll("[data-self]").forEach((el) => { el.onclick = () => openProfile(); });
      box.querySelectorAll(".add-from-search").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await api("/contacts", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
            btn.textContent = "Added"; btn.disabled = true;
          } catch (err) { showError(err.message); }
        };
      });
      box.querySelectorAll(".block-from-search").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm("Are you sure you want to block this user?")) return;
          try {
            await api("/blocks", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
            btn.textContent = "Blocked"; btn.disabled = true;
            showError("User blocked");
          } catch (err) { showError(err.message); }
        };
      });
      box.querySelectorAll("[data-user]").forEach((el) => {
        el.onclick = async (e) => {
          if (e.target.closest("button")) return;
          try {
            const room = await api("/dm", { method: "POST", body: JSON.stringify({ userId: el.dataset.user }) });
            await loadRooms();
            openRoom(room.id);
          } catch (err) { showError(err.message); }
        };
      });
      return;
    }
    const data = await api("/search?q=" + encodeURIComponent(q));
    const box = $("#chatList");
    let html = "";
    if (data.contacts && data.contacts.length) {
      html += '<div style="padding:8px 14px;font-size:.72rem;color:var(--muted);text-transform:uppercase">Contacts</div>';
      html += data.contacts.map((u) =>
        `<div class="chat-item" data-contact="${u.id}">
          <div class="chat-avatar dm">${esc(u.username.charAt(0).toUpperCase())}</div>
          <div class="chat-meta"><div class="chat-title dm">@${esc(u.username)}</div>
          <div class="chat-sub">Contact</div></div></div>`
      ).join("");
    }
    if (data.rooms && data.rooms.length) {
      html += '<div style="padding:8px 14px;font-size:.72rem;color:var(--muted);text-transform:uppercase">Rooms</div>';
      html += data.rooms.map((r) =>
        `<div class="chat-item" data-room="${r.id}" data-member="${r.isMember ? 1 : 0}" data-pending="${r.pendingJoin ? 1 : 0}">
          <div class="chat-avatar ${r.visibility}">${esc((r.name||"?").charAt(0).toUpperCase())}</div>
          <div class="chat-meta"><div class="chat-title">${esc(r.name)}</div>
          <div class="chat-sub">${r.isMember ? "Joined" : r.pendingJoin ? "Join pending" : "Searchable · tap to request join"}</div></div>
          <div class="chat-right"><span class="badge-vis badge-${r.visibility}">${r.visibility}</span></div></div>`
      ).join("");
    }
    // Also filter local list
    const localQ = q.toLowerCase();
    const local = [];
    for (const r of [...(allRooms.private||[]), ...(allRooms.public||[])]) {
      const name = (r.displayName || r.name || "").toLowerCase();
      if (name.includes(localQ)) local.push(r);
    }
    if (local.length) {
      html += '<div style="padding:8px 14px;font-size:.72rem;color:var(--muted);text-transform:uppercase">Your chats</div>';
      html += local.map((r) => {
        const isDm = r.isDm || (r.id && r.id.startsWith("dm:"));
        const title = r.displayName || r.name;
        return `<div class="chat-item" data-id="${r.id}">
          <div class="chat-avatar ${isDm?"dm":r.visibility}">${esc(title.charAt(0).toUpperCase())}</div>
          <div class="chat-meta"><div class="chat-title ${isDm?"dm":""}">${esc(title)}</div>
          <div class="chat-sub">${isDm?"Direct message":r.visibility}</div></div></div>`;
      }).join("");
    }
    if (!html) html = '<div class="empty">No matches</div>';
    box.innerHTML = html;
    box.querySelectorAll("[data-id]").forEach((el) => { el.onclick = () => openRoom(el.dataset.id); });
    box.querySelectorAll("[data-contact]").forEach((el) => {
      el.onclick = async () => {
        try {
          const room = await api("/dm", { method: "POST", body: JSON.stringify({ userId: el.dataset.contact }) });
          await loadRooms();
          openRoom(room.id);
        } catch (e) { showError(e.message); }
      };
    });
    box.querySelectorAll("[data-room]").forEach((el) => {
      el.onclick = async () => {
        if (el.dataset.member === "1") { openRoom(el.dataset.room); return; }
        if (el.dataset.pending === "1") { showError("Join request already pending"); return; }
        if (!me) { showError("Login required"); return; }
        if (!confirm("Request to join this room?")) return;
        try {
          await api("/rooms/join-request", { method: "POST", body: JSON.stringify({ roomId: el.dataset.room }) });
          showError("Join request sent");
          doGlobalSearch(q);
        } catch (e) { showError(e.message); }
      };
    });
  } catch (e) {
    renderChatList(q);
  }
}


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
    currentRoom.isCreator = !!data.isCreator;
    currentRoom.isRoomAdmin = !!data.isRoomAdmin;
    // resolve DM display name
    if (currentRoom.id.startsWith("dm:")) {
      const other = currentMembers.filter((m) => !me || m.id !== me.id);
      currentRoom.displayName = other.length ? other.map((m) => m.username).join(", ") : "Direct message";
    } else {
      currentRoom.displayName = currentRoom.name;
    }
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
    const canInvite = isPrivate && me && (data.isCreator || data.isRoomAdmin || data.room.allowMembersInvite);
    $("#headerInviteBtn").style.display = canInvite ? "inline-block" : "none";
    const isDm = currentRoom.id.startsWith("dm:");
    const canLeave = me && currentMembers.some((m) => m.id === me.id) && (isDm || (isPrivate && !data.isCreator));
    $("#headerLeaveBtn").style.display = canLeave ? "inline-block" : "none";
    // Creator of non-DM can delete; DM participants can also delete chat
    const canDelete = me && (data.isCreator || (me.username === "admin") || (isDm && currentMembers.some((m) => m.id === me.id)));
    $("#headerDeleteBtn").style.display = canDelete && !isDm ? "inline-block" : (isDm && canLeave ? "inline-block" : (canDelete ? "inline-block" : "none"));
    if (isDm) $("#headerDeleteBtn").title = "Delete chat";
    else $("#headerDeleteBtn").title = "Delete room";
    api("/rooms/mark-read", { method: "POST", body: JSON.stringify({ roomId }) }).then(() => {
      delete unreadMap[roomId];
      renderChatList($("#sidebarSearch").value);
    }).catch(() => {});
    if (roomId.startsWith("dm:")) refreshDmSeen(roomId); else dmSeen = false;
    const canSettings = me && !currentRoom.id.startsWith("dm:") && (data.isCreator || data.isRoomAdmin || (me.username === "admin"));
    $("#headerManageBtn").style.display = canSettings ? "inline-block" : "none";
    $("#headerManageBtn").title = "Room settings";
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
    const other = currentMembers.filter((m) => !me || m.id !== me.id);
    titleEl.textContent = currentRoom.displayName || (other.length ? other.map((m) => m.username).join(", ") : currentRoom.name);
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
  if (!currentRoom) return;
  const isDm = currentRoom.id.startsWith("dm:");
  if (!confirm(isDm
    ? "Delete this conversation? All messages will be permanently removed."
    : "Delete this room? All messages will be permanently removed.")) return;
  try {
    await api("/rooms/" + currentRoom.id, { method: "DELETE" });
    showEmpty();
    loadRooms();
    showError("Deleted — messages purged");
  } catch (e) { showError(e.message); }
};
$("#headerMembersBtn").onclick = () => openMembersModal(false);
$("#headerManageBtn").onclick = () => openRoomSettings();
$("#backMobile").onclick = () => {
  $("#sidebar").classList.remove("hidden-mobile");
  $("#mainPane").classList.remove("open-mobile");
  showEmpty();
};


async function openRoomSettings() {
  if (!currentRoom) return;
  $("#settingsName").value = currentRoom.name || "";
  $("#settingsVis").value = currentRoom.visibility || "public";
  $("#settingsSearchable").checked = !!currentRoom.searchable;
  $("#settingsAllowInvite").checked = !!currentRoom.allowMembersInvite;
  $("#settingsDegree").value = currentRoom.inviteDegree || "contacts";
  const isCreator = currentRoom.isCreator || (me && currentRoom.createdBy === me.id);
  // Creator has full access to every room setting
  $("#settingsName").disabled = !isCreator && !(me && me.username === "admin");
  $("#settingsVis").disabled = false;
  $("#settingsSearchable").disabled = false;
  $("#settingsAllowInvite").disabled = false;
  $("#settingsDegree").disabled = false;
  if (!isCreator && !(me && me.username === "admin") && currentRoom.isRoomAdmin) {
    // Secondary admin: can change privacy/invite but not name (already disabled)
  }
  if ($("#settingsAllowAdminAvatar")) {
    $("#settingsAllowAdminAvatar").checked = !!currentRoom.allowAdminAvatar;
    $("#settingsAllowAdminAvatarWrap").style.display = isCreator || (me && me.username === "admin") ? "block" : "none";
  }
  const canChangePhoto = isCreator || (currentRoom.isRoomAdmin && currentRoom.allowAdminAvatar) || (me && me.username === "admin");
  $("#changeRoomAvatarBtn").style.display = canChangePhoto ? "inline-block" : "none";
  const rp = $("#roomAvatarPreview");
  if (currentRoom.avatarUrl) {
    rp.style.backgroundImage = "url(" + currentRoom.avatarUrl + "?t=" + Date.now() + ")";
    rp.textContent = "";
  } else {
    rp.style.backgroundImage = "";
    rp.textContent = (currentRoom.name || "?").charAt(0).toUpperCase();
  }
  // Load admins
  try {
    const adm = await api("/rooms/" + currentRoom.id + "/admins");
    const list = $("#settingsAdminsList");
    list.innerHTML = (adm.admins || []).map((a) => {
      const isC = a.id === adm.creatorId;
      return `<div class="item" style="cursor:default"><div>@${esc(a.username)}${isC ? " (creator)" : ""}</div>
        ${isCreator && !isC ? `<button class="btn-ghost btn-sm demote-admin" data-id="${a.id}">Remove admin</button>` : ""}</div>`;
    }).join("") || '<div class="empty" style="padding:8px">No admins</div>';
    list.querySelectorAll(".demote-admin").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api("/rooms/" + currentRoom.id + "/admins", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id, remove: true }) });
          openRoomSettings();
        } catch (e) { showError(e.message); }
      };
    });
    // Promote members
    if (isCreator && currentMembers.length) {
      const adminIds = new Set((adm.admins || []).map((a) => a.id));
      const promotable = currentMembers.filter((m) => !adminIds.has(m.id));
      if (promotable.length) {
        list.innerHTML += '<div style="font-size:.78rem;color:var(--muted);padding:8px 0">Promote member</div>';
        list.innerHTML += promotable.map((m) =>
          `<div class="item"><div>@${esc(m.username)}</div><button class="btn btn-sm promote-admin" data-id="${m.id}">Make admin</button></div>`
        ).join("");
        list.querySelectorAll(".promote-admin").forEach((btn) => {
          btn.onclick = async () => {
            try {
              await api("/rooms/" + currentRoom.id + "/admins", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
              openRoomSettings();
            } catch (e) { showError(e.message); }
          };
        });
      }
    }
  } catch (e) { $("#settingsAdminsList").innerHTML = '<div class="empty">Failed</div>'; }
  // Join requests
  try {
    const reqs = await api("/rooms/" + currentRoom.id + "/join-requests");
    const jl = $("#settingsJoinList");
    if (!reqs.length) jl.innerHTML = '<div class="empty" style="padding:8px">None</div>';
    else {
      jl.innerHTML = reqs.map((r) =>
        `<div class="item"><div>@${esc(r.username)}</div>
         <div style="display:flex;gap:6px">
           <button class="btn btn-sm approve-join" data-id="${r.userId}">Approve</button>
           <button class="btn-ghost btn-sm deny-join" data-id="${r.userId}">Deny</button>
         </div></div>`
      ).join("");
      jl.querySelectorAll(".approve-join").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api("/rooms/" + currentRoom.id + "/join-requests/" + btn.dataset.id, { method: "POST", body: JSON.stringify({ action: "approve" }) });
            openRoomSettings();
          } catch (e) { showError(e.message); }
        };
      });
      jl.querySelectorAll(".deny-join").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api("/rooms/" + currentRoom.id + "/join-requests/" + btn.dataset.id, { method: "POST", body: JSON.stringify({ action: "deny" }) });
            openRoomSettings();
          } catch (e) { showError(e.message); }
        };
      });
    }
  } catch { $("#settingsJoinList").innerHTML = '<div class="empty" style="padding:8px">—</div>'; }
  openModal("roomSettingsModal");
}

$("#closeSettings").onclick = () => closeModal("roomSettingsModal");
$("#saveSettings").onclick = async () => {
  if (!currentRoom) return;
  try {
    const body = {
      visibility: $("#settingsVis").value,
      searchable: $("#settingsSearchable").checked,
      allowMembersInvite: $("#settingsAllowInvite").checked,
      inviteDegree: $("#settingsDegree").value,
      allowAdminAvatar: $("#settingsAllowAdminAvatar") ? $("#settingsAllowAdminAvatar").checked : false,
    };
    if (!$("#settingsName").disabled) body.name = $("#settingsName").value.trim();
    const room = await api("/rooms/" + currentRoom.id + "/settings", { method: "POST", body: JSON.stringify(body) });
    currentRoom = { ...currentRoom, ...room };
    closeModal("roomSettingsModal");
    renderHeader();
    loadRooms();
  } catch (e) { showError(e.message); }
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
  if (!mine) {
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      ${msgAvatarHtml(m.username, m.userId ? "/avatar/" + m.userId : null)}
      <div class="meta" style="margin:0">@${esc(m.username)}</div>
    </div>`;
  } else {
    html += `<div class="meta">@${esc(m.username)}</div>`;
  }
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
    if (currentRoom.id.startsWith("dm:")) {
      dmSeen = false;
      setTimeout(() => refreshDmSeen(currentRoom.id), 500);
    }
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
    const body = {
      name: $("#newRoomName").value.trim(),
      visibility,
      searchable: $("#newRoomSearchable").checked,
    };
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
        <div style="display:flex;align-items:center;gap:10px">
          ${letterAvatar(c.user.username, c.user.avatarUrl, "dm").replace('chat-avatar','chat-avatar').replace('width:48','')}
          <div>${c.user.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(c.user.username)}</strong>
          ${c.isFriend ? ' <span class="badge-friend">Friends</span>' : ""}</div>
        </div>
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


// Invite / Leave
$("#headerInviteBtn").onclick = () => openMembersModal(true);
$("#headerLeaveBtn").onclick = async () => {
  if (!currentRoom) return;
  const isDm = currentRoom.id.startsWith("dm:");
  if (!confirm(isDm ? "Leave this conversation? If no one remains, messages will be deleted." : "Leave this room?")) return;
  try {
    const res = await api("/rooms/leave", { method: "POST", body: JSON.stringify({ roomId: currentRoom.id }) });
    showEmpty();
    loadRooms();
    if (res.purged) showError("Chat emptied — messages purged");
  } catch (e) { showError(e.message); }
};

async function refreshBell() {
  if (!me) { const b = $("#bellBadge"); if (b) b.style.display = "none"; return; }
  try {
    const d = await api("/notifications/unread-count");
    const b = $("#bellBadge");
    if (!b) return;
    if (d.count > 0) { b.style.display = "block"; b.textContent = d.count > 99 ? "99+" : String(d.count); }
    else b.style.display = "none";
  } catch {}
}

$("#bellBtn").onclick = async () => {
  if (!me) { showError("Login required"); return; }
  try {
    const list = await api("/notifications");
    const box = $("#notifList");
    if (!list.length) box.innerHTML = '<div class="empty">No notifications</div>';
    else {
      box.innerHTML = list.map((n) => {
        let actions = "";
        if (n.type === "contact_added" && n.data) {
          actions = `<div class="notif-actions">
            <button class="btn btn-sm notif-msg" data-uid="${n.data.userId}">Message</button>
            <button class="btn btn-sm notif-add" data-uid="${n.data.userId}">Add back</button>
            <button class="btn-ghost btn-sm notif-block" data-uid="${n.data.userId}">Block</button>
          </div>`;
        }
        return `<div class="notif-item ${n.read ? "" : "unread"}" data-id="${n.id}" data-type="${n.type}" data-room="${(n.data && n.data.roomId) || ""}">
          <div class="notif-title">${esc(n.title)}</div>
          ${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ""}
          <div class="notif-body">${new Date(n.createdAt).toLocaleString()}</div>
          ${actions}
        </div>`;
      }).join("");
      box.querySelectorAll(".notif-item").forEach((el) => {
        el.onclick = async (e) => {
          if (e.target.closest("button")) return;
          try { await api("/notifications/read", { method: "POST", body: JSON.stringify({ id: el.dataset.id }) }); } catch {}
          if ((el.dataset.type === "join_approved" || el.dataset.type === "added_to_room") && el.dataset.room) {
            closeModal("notifModal");
            await loadRooms();
            openRoom(el.dataset.room);
          }
          refreshBell();
        };
      });
      box.querySelectorAll(".notif-msg").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          try {
            const room = await api("/dm", { method: "POST", body: JSON.stringify({ userId: btn.dataset.uid }) });
            closeModal("notifModal");
            await loadRooms();
            openRoom(room.id);
          } catch (err) { showError(err.message); }
        };
      });
      box.querySelectorAll(".notif-add").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await api("/contacts", { method: "POST", body: JSON.stringify({ userId: btn.dataset.uid }) });
            btn.textContent = "Added"; btn.disabled = true;
          } catch (err) { showError(err.message); }
        };
      });
      box.querySelectorAll(".notif-block").forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm("Are you sure you want to block this user?")) return;
          try {
            await api("/blocks", { method: "POST", body: JSON.stringify({ userId: btn.dataset.uid }) });
            btn.textContent = "Blocked"; btn.disabled = true;
          } catch (err) { showError(err.message); }
        };
      });
    }
    openModal("notifModal");
    refreshBell();
  } catch (e) { showError(e.message); }
};
$("#closeNotif").onclick = () => closeModal("notifModal");
$("#markAllRead").onclick = async () => {
  try { await api("/notifications/read", { method: "POST", body: JSON.stringify({}) }); refreshBell(); $("#bellBtn").click(); }
  catch (e) { showError(e.message); }
};

$("#drawerBlocked").onclick = async () => {
  closeDrawer();
  try {
    const list = await api("/blocks");
    const box = $("#blockedList");
    if (!list.length) box.innerHTML = '<div class="empty">No blocked users</div>';
    else {
      box.innerHTML = list.map((u) =>
        `<div class="item"><div>@${esc(u.username)}</div>
         <button class="btn btn-sm unblock" data-id="${u.id}">Unblock</button></div>`
      ).join("");
      box.querySelectorAll(".unblock").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api("/blocks/remove", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
            $("#drawerBlocked").click();
          } catch (e) { showError(e.message); }
        };
      });
    }
    openModal("blockedModal");
  } catch (e) { showError(e.message); }
};
$("#closeBlocked").onclick = () => closeModal("blockedModal");

async function refreshDmSeen(roomId) {
  try {
    const d = await api("/dm/seen?roomId=" + encodeURIComponent(roomId));
    dmSeen = !!d.seen;
    const mines = [...document.querySelectorAll(".msg.mine")];
    mines.forEach((el) => { const old = el.querySelector(".seen-label"); if (old) old.remove(); });
    if (dmSeen && mines.length) {
      const last = mines[mines.length - 1];
      if (last && !last.classList.contains("deleted")) {
        last.insertAdjacentHTML("beforeend", '<div class="seen-label">Seen</div>');
      }
    }
  } catch { dmSeen = false; }
}

setInterval(() => { if (me) refreshBell(); }, 30000);



function openProfile() {
  if (!me) return;
  closeDrawer();
  $("#profileUsername").value = me.username;
  $("#profileEmail").value = me.email || "";
  const prev = $("#profileAvatarPreview");
  if (me.avatarUrl) {
    prev.style.backgroundImage = "url(" + me.avatarUrl + "?t=" + Date.now() + ")";
    prev.textContent = "";
  } else {
    prev.style.backgroundImage = "";
    prev.textContent = me.username.charAt(0).toUpperCase();
  }
  openModal("profileModal");
}
$("#drawerProfile").onclick = () => { if (me) openProfile(); };
$("#closeProfile").onclick = () => closeModal("profileModal");
$("#changeAvatarBtn").onclick = () => $("#avatarFile").click();
$("#profileAvatarPreview").onclick = () => $("#avatarFile").click();
$("#avatarFile").onchange = () => {
  const file = $("#avatarFile").files[0];
  if (!file) return;
  openCropper(file, async (blob) => {
    try {
      const res = await fetch("/api/profile/avatar-upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "image/jpeg" },
        body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      me.avatarUrl = data.avatarUrl;
      updateAuthUI();
      openProfile();
      showError("Photo updated");
    } catch (e) { showError(e.message); }
  });
  $("#avatarFile").value = "";
};
$("#saveProfile").onclick = async () => {
  try {
    const d = await api("/profile/email", { method: "POST", body: JSON.stringify({ email: $("#profileEmail").value.trim() }) });
    me.email = d.email;
    showError("Email saved");
  } catch (e) { showError(e.message); }
};
$("#addDeviceBtn").onclick = async () => {
  try {
    const d = await api("/auth/device-code", { method: "POST" });
    $("#deviceCode").textContent = d.code;
    $("#deviceQr").innerHTML = "";
    const url = location.origin + d.pairUrl;
    new QRCode($("#deviceQr"), { text: url, width: 200, height: 200, colorDark: "#000", colorLight: "#fff", correctLevel: QRCode.CorrectLevel.H });
    closeModal("profileModal");
    openModal("deviceModal");
  } catch (e) { showError(e.message); }
};
$("#closeDevice").onclick = () => closeModal("deviceModal");

// Pair flow from ?pair=code
let pendingPairCode = null;
$("#cancelPair").onclick = () => { closeModal("pairModal"); pendingPairCode = null; };
$("#doPair").onclick = async () => {
  try {
    const d = await api("/auth/device-pair", {
      method: "POST",
      body: JSON.stringify({ code: pendingPairCode, totpCode: $("#pairTotp").value.trim() }),
    });
    token = d.token; me = d.user; localStorage.setItem("dc_token", token);
    closeModal("pairModal");
    updateAuthUI(); loadRooms(); startHeartbeat();
    history.replaceState({}, "", "/app.html");
  } catch (e) { showError(e.message); }
};



$("#changeRoomAvatarBtn").onclick = () => $("#roomAvatarFile").click();
$("#roomAvatarPreview").onclick = () => { if ($("#changeRoomAvatarBtn").style.display !== "none") $("#roomAvatarFile").click(); };
$("#roomAvatarFile").onchange = () => {
  const file = $("#roomAvatarFile").files[0];
  if (!file || !currentRoom) return;
  openCropper(file, async (blob) => {
    try {
      const res = await fetch("/api/rooms/avatar-upload?roomId=" + encodeURIComponent(currentRoom.id), {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "image/jpeg" },
        body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      currentRoom.avatarUrl = data.avatarUrl;
      openRoomSettings();
      loadRooms();
      showError("Room photo updated");
    } catch (e) { showError(e.message); }
  });
  $("#roomAvatarFile").value = "";
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
  const params = new URLSearchParams(location.search);
  const pairCode = params.get("pair");
  if (pairCode) {
    pendingPairCode = pairCode;
    openModal("pairModal");
  }
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
  const roomParam = params.get("room");
  if (roomParam) {
    setTimeout(() => openRoom(roomParam), 400);
  }
})();
