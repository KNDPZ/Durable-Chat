// Client for Durable Chat — API under /api/*
let token = localStorage.getItem("dc_token") || null;
let me = null, currentRoom = null, currentMembers = [], ws = null;
let pendingSecret = null, pendingUsername = null, myContacts = [];
let selectedCreateMembers = new Set();

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 5000);
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch("/api" + path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("dc_theme", t);
  $("#themeIcon").textContent = t === "dark" ? "☀️" : "🌙";
  $("#themeLabel").textContent = t === "dark" ? "Light mode" : "Dark mode";
}
applyTheme(localStorage.getItem("dc_theme") || "dark");
$("#themeToggle").onclick = () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  closeDropdown();
};

const dropdown = $("#dropdown");
$("#gearBtn").onclick = (e) => { e.stopPropagation(); dropdown.classList.toggle("open"); };
document.addEventListener("click", () => dropdown.classList.remove("open"));
function closeDropdown() { dropdown.classList.remove("open"); }

function updateAuthUI() {
  if (me) {
    $("#userChip").style.display = "inline-flex";
    $("#userChip").innerHTML = "@" + me.username + (me.isAdmin ? ' <span class="badge badge-admin">admin</span>' : "");
    $("#authBtn").style.display = "none";
    $("#logoutBtn").style.display = "block";
    $("#createRoomBtn").style.display = "inline-block";
    $("#privateSection").style.display = "block";
    $("#adminTab").style.display = me.isAdmin ? "inline-block" : "none";
  } else {
    $("#userChip").style.display = "none";
    $("#authBtn").style.display = "block";
    $("#logoutBtn").style.display = "none";
    $("#createRoomBtn").style.display = "none";
    $("#privateSection").style.display = "none";
    $("#adminTab").style.display = "none";
  }
}

$("#authBtn").onclick = () => { closeDropdown(); showAuthStep("choice"); $("#authModal").style.display = "flex"; };
$("#logoutBtn").onclick = async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  token = null; me = null; localStorage.removeItem("dc_token");
  updateAuthUI(); closeDropdown(); loadRooms(); loadContacts();
};

function showAuthStep(step) {
  ["choice", "login", "register-user", "register-totp"].forEach((s) => {
    const el = $("#authStep-" + s);
    if (el) el.style.display = s === step ? "block" : "none";
  });
  const t = {
    choice: ["Welcome", "Choose an option"],
    login: ["Log in", "Username + authenticator code"],
    "register-user": ["Create account", "Pick a username"],
    "register-totp": ["Authenticator", "Scan QR then enter code"],
  };
  $("#authTitle").textContent = t[step][0];
  $("#authDesc").textContent = t[step][1];
}
$("#showLogin").onclick = () => showAuthStep("login");
$("#showRegister").onclick = () => showAuthStep("register-user");
$("#backToChoice1").onclick = () => showAuthStep("choice");
$("#backToChoice2").onclick = () => showAuthStep("choice");
$("#backToUser").onclick = () => showAuthStep("register-user");
["authModal", "createRoomModal", "membersModal", "adminUserModal", "recoverModal"].forEach((id) => {
  $("#" + id).onclick = (e) => { if (e.target === $("#" + id)) $("#" + id).style.display = "none"; };
});
$("#closeAdminUser").onclick = () => ($("#adminUserModal").style.display = "none");
$("#closeRecover").onclick = () => ($("#recoverModal").style.display = "none");
$("#closeMembers").onclick = () => ($("#membersModal").style.display = "none");

$("#doLogin").onclick = async () => {
  try {
    const d = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#loginUsername").value.trim(), code: $("#loginCode").value.trim() }),
    });
    token = d.token; me = d.user; localStorage.setItem("dc_token", token);
    $("#authModal").style.display = "none"; updateAuthUI(); loadRooms(); loadContacts(); startHeartbeat();
  } catch (e) { showError(e.message); btn.disabled = false; }
};
$("#checkUsername").onclick = async () => {
  const username = $("#regUsername").value.trim();
  try {
    const d = await api("/auth/start-register", { method: "POST", body: JSON.stringify({ username }) });
    if (d.error) throw new Error(d.error);
    pendingUsername = username; pendingSecret = d.secret;
    // Show secret without padding (easier to type manually)
    const secretClean = String(d.secret).replace(/=+$/g, "");
    $("#secretText").textContent = secretClean;
    $("#qrcode").innerHTML = "";
    // High error correction so phone cameras scan reliably
    new QRCode($("#qrcode"), {
      text: d.otpauthUrl,
      width: 220,
      height: 220,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
    // Also show the URI so user can add account manually if scan fails
    let uriEl = document.getElementById("otpauthUri");
    if (!uriEl) {
      uriEl = document.createElement("div");
      uriEl.id = "otpauthUri";
      uriEl.className = "secret-box";
      uriEl.style.fontSize = "0.7rem";
      uriEl.style.wordBreak = "break-all";
      $("#qrcode").parentNode.insertBefore(uriEl, $("#secretText"));
    }
    uriEl.textContent = d.otpauthUrl;
    showAuthStep("register-totp");
  } catch (e) { showError(e.message); }
};
$("#completeReg").onclick = async () => {
  const btn = $("#completeReg");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const d = await api("/auth/complete-register", {
      method: "POST",
      body: JSON.stringify({ username: pendingUsername, secret: pendingSecret, code: $("#regCode").value.trim() }),
    });
    if (d.error) throw new Error(d.error);
    token = d.token; me = d.user; localStorage.setItem("dc_token", token);
    $("#authModal").style.display = "none"; updateAuthUI(); loadRooms(); loadContacts(); startHeartbeat();
  } catch (e) { showError(e.message); btn.disabled = false; }
};

$$(".tab").forEach((tab) => {
  tab.onclick = () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    ["rooms", "contacts", "search", "admin"].forEach((p) => {
      const el = $("#panel-" + p);
      if (el) el.style.display = tab.dataset.tab === p ? "block" : "none";
    });
    if (tab.dataset.tab === "contacts") loadContacts();
    if (tab.dataset.tab === "admin") loadAdminPanel("online");
  };
});
$$(".sub-tab").forEach((st) => {
  st.onclick = () => {
    $$(".sub-tab").forEach((t) => t.classList.remove("active"));
    st.classList.add("active");
    ["online", "users", "admins", "lookup"].forEach((p) => {
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
    const path = which === "online" ? "/admin/online" : which === "admins" ? "/admin/admins" : "/admin/users";
    const users = await api(path);
    if (!users.length) { el.innerHTML = '<div class="empty">None</div>'; return; }
    el.innerHTML = users.map((u) =>
      `<div class="item"><div>${u.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(u.username)}</strong>${u.isAdmin ? ' <span class="badge badge-admin">admin</span>' : ""}</div>
       <button class="btn btn-sm" data-id="${u.id}">View</button></div>`
    ).join("");
    el.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); openAdminUser(btn.dataset.id); };
    });
  } catch { el.innerHTML = '<div class="empty">Failed</div>'; }
}

async function loadRooms() {
  try {
    const data = await api("/rooms");
    renderRoomList($("#publicRooms"), data.public);
    if (me) renderRoomList($("#privateRooms"), data.private);
  } catch { $("#publicRooms").innerHTML = '<div class="empty">Failed</div>'; }
}
function renderRoomList(container, rooms) {
  if (!rooms.length) { container.innerHTML = '<div class="empty">No rooms yet</div>'; return; }
  container.innerHTML = rooms.map((r) =>
    `<div class="item" data-id="${r.id}"><div><strong>${esc(r.name)}</strong></div><span class="badge badge-${r.visibility}">${r.visibility}</span></div>`
  ).join("");
  container.querySelectorAll(".item").forEach((el) => { el.onclick = () => openRoom(el.dataset.id); });
}

$("#createRoomBtn").onclick = async () => {
  $("#createRoomModal").style.display = "flex";
  $("#newRoomName").value = "";
  selectedCreateMembers = new Set();
  $("#newRoomVis").value = "public";
  $("#privateOpts").style.display = "none";
  await refreshCreateMemberPicker();
};
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
        <input type="checkbox" value="${c.user.id}" class="create-member-cb" style="width:auto" ${selectedCreateMembers.has(c.user.id) ? "checked" : ""}/>
        ${c.user.online ? '<span class="online-dot"></span>' : ""}@${esc(c.user.username)}</label>`
    ).join("");
    box.querySelectorAll(".create-member-cb").forEach((cb) => {
      cb.onchange = () => { if (cb.checked) selectedCreateMembers.add(cb.value); else selectedCreateMembers.delete(cb.value); };
    });
  } catch { box.innerHTML = '<div class="empty" style="padding:8px">Failed</div>'; }
}
$("#cancelCreateRoom").onclick = () => ($("#createRoomModal").style.display = "none");
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
    $("#createRoomModal").style.display = "none";
    loadRooms();
    openRoom(room.id);
  } catch (e) { showError(e.message); }
};

async function openRoom(roomId) {
  try {
    const data = await api("/rooms/" + roomId + "/messages");
    currentRoom = data.room;
    currentMembers = data.members || [];
    $("#view-home").style.display = "none";
    $("#view-room").style.display = "block";
    $("#roomName").textContent = data.room.name;
    const badge = $("#roomBadge");
    badge.textContent = data.room.visibility;
    badge.className = "badge badge-" + data.room.visibility;
    const canPost = !!me && (data.room.visibility !== "private" || currentMembers.some((m) => m.id === me.id) || me.isAdmin);
    $("#chatInputRow").style.display = canPost ? "flex" : "none";
    $("#loginToChat").style.display = canPost ? "none" : "block";
    $("#deleteRoomBtn").style.display = me && (data.room.createdBy === me.id || me.isAdmin) ? "inline-block" : "none";
    const canManage = me && data.room.visibility === "private" && (data.room.createdBy === me.id || data.room.allowMembersInvite);
    $("#manageMembersBtn").style.display = canManage ? "inline-block" : "none";
    if (data.room.visibility === "private" && currentMembers.length) {
      $("#membersBar").style.display = "block";
      $("#membersBar").innerHTML = currentMembers.map((m) =>
        `<span class="member-chip">${m.online ? '<span class="online-dot"></span>' : ""}@${esc(m.username)}</span>`
      ).join("");
    } else $("#membersBar").style.display = "none";
    renderMessages(data.messages, data.room.visibility === "registered" && !me);
    connectWS(roomId);
  } catch (e) { showError(e.message); }
}

$("#deleteRoomBtn").onclick = async () => {
  if (!currentRoom || !confirm("Delete this room?")) return;
  try { await api("/rooms/" + currentRoom.id, { method: "DELETE" }); $("#backBtn").click(); loadRooms(); }
  catch (e) { showError(e.message); }
};

$("#manageMembersBtn").onclick = async () => {
  if (!currentRoom) return;
  try {
    currentMembers = await api("/rooms/" + currentRoom.id + "/members");
    $("#membersList").innerHTML = currentMembers.map((m) =>
      `<div class="item" style="cursor:default"><div>${m.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(m.username)}</strong>${m.id === currentRoom.createdBy ? ' <span class="badge">creator</span>' : ""}</div>
       ${me && me.id === currentRoom.createdBy && m.id !== currentRoom.createdBy ? `<button class="btn-ghost btn-sm remove-member" data-id="${m.id}">Remove</button>` : ""}</div>`
    ).join("") || '<div class="empty">No members</div>';
    $("#membersList").querySelectorAll(".remove-member").forEach((btn) => {
      btn.onclick = async () => {
        try { await api("/rooms/" + currentRoom.id + "/members/" + btn.dataset.id, { method: "DELETE" }); $("#manageMembersBtn").click(); }
        catch (e) { showError(e.message); }
      };
    });
    const picker = $("#addMemberPicker");
    if (!myContacts.length) myContacts = await api("/contacts");
    const memberIds = new Set(currentMembers.map((m) => m.id));
    const available = myContacts.filter((c) => !memberIds.has(c.user.id));
    if (!available.length) picker.innerHTML = '<div class="empty" style="padding:8px">No contacts to add</div>';
    else {
      picker.innerHTML = available.map((c) =>
        `<div class="item" style="padding:8px"><div>${c.user.online ? '<span class="online-dot"></span>' : ""}@${esc(c.user.username)}</div>
         <button class="btn btn-sm add-to-room" data-id="${c.user.id}">Add</button></div>`
      ).join("");
      picker.querySelectorAll(".add-to-room").forEach((btn) => {
        btn.onclick = async () => {
          try {
            const res = await api("/rooms/" + currentRoom.id + "/members", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
            if (res.error) throw new Error(res.error);
            $("#manageMembersBtn").click();
          } catch (e) { showError(e.message); }
        };
      });
    }
    $("#membersModal").style.display = "flex";
  } catch (e) { showError(e.message); }
};

function renderMessages(messages, blur) {
  const box = $("#messages");
  box.innerHTML = messages.map((m) =>
    `<div class="msg ${me && m.userId === me.id ? "mine" : ""} ${blur ? "blurred" : ""}">
      <div class="meta">@${esc(m.username)} · ${new Date(m.createdAt).toLocaleString()}</div>
      <div>${esc(m.text)}</div></div>`
  ).join("");
  box.scrollTop = box.scrollHeight;
}
function connectWS(roomId) {
  if (ws) try { ws.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/room/${roomId}`);
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.t === "message" || data.type === "message") {
        const m = data.message;
        const box = $("#messages");
        const div = document.createElement("div");
        div.className = "msg" + (me && m.userId === me.id ? " mine" : "");
        div.innerHTML = `<div class="meta">@${esc(m.username)} · just now</div><div>${esc(m.text)}</div>`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
      }
    } catch {}
  };
}
$("#backBtn").onclick = () => {
  if (ws) try { ws.close(); } catch {}
  currentRoom = null;
  $("#view-room").style.display = "none";
  $("#view-home").style.display = "block";
  loadRooms();
};
$("#sendBtn").onclick = sendMsg;
$("#msgInput").onkeydown = (e) => { if (e.key === "Enter") sendMsg(); };
async function sendMsg() {
  const text = $("#msgInput").value.trim();
  if (!text || !currentRoom) return;
  try {
    await api("/rooms/" + currentRoom.id + "/messages", { method: "POST", body: JSON.stringify({ text }) });
    $("#msgInput").value = "";
  } catch (e) { showError(e.message); }
}

let searchTimer;
$("#searchInput").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 300); };
async function doSearch() {
  const q = $("#searchInput").value.trim();
  if (!q) { $("#searchResults").innerHTML = '<div class="empty">Type to search</div>'; return; }
  try {
    const users = await api("/users/search?q=" + encodeURIComponent(q));
    if (!users.length) { $("#searchResults").innerHTML = '<div class="empty">No users</div>'; return; }
    $("#searchResults").innerHTML = users.map((u) =>
      `<div class="item"><div>${u.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(u.username)}</strong>${u.isAdmin ? ' <span class="badge badge-admin">admin</span>' : ""}</div>
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

async function loadContacts() {
  if (!me) { $("#contactsList").innerHTML = '<div class="empty">Login to see contacts</div>'; return; }
  try {
    myContacts = await api("/contacts");
    if (!myContacts.length) { $("#contactsList").innerHTML = '<div class="empty">No contacts yet</div>'; return; }
    $("#contactsList").innerHTML = myContacts.map((c) =>
      `<div class="item" style="cursor:default">
        <div>${c.user.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(c.user.username)}</strong>
          ${c.isFriend ? ' <span class="badge badge-friend">Friends</span>' : ' <span class="badge">Contact</span>'}</div>
        <div class="contact-actions">
          <button class="btn btn-sm msg-contact" data-id="${c.user.id}">Message</button>
          <button class="btn-ghost btn-sm remove-contact" data-id="${c.user.id}">Remove</button>
        </div></div>`
    ).join("");
    $("#contactsList").querySelectorAll(".msg-contact").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const room = await api("/dm", { method: "POST", body: JSON.stringify({ userId: btn.dataset.id }) });
          if (room.error) throw new Error(room.error);
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

let adminSearchTimer;
$("#adminSearchInput").oninput = () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(doAdminSearch, 300); };
async function doAdminSearch() {
  const q = $("#adminSearchInput").value.trim();
  if (!q) { $("#adminSearchResults").innerHTML = '<div class="empty">Type to search</div>'; return; }
  try {
    const users = await api("/users/search?q=" + encodeURIComponent(q));
    if (!users.length) { $("#adminSearchResults").innerHTML = '<div class="empty">None</div>'; return; }
    $("#adminSearchResults").innerHTML = users.map((u) =>
      `<div class="item"><div>${u.online ? '<span class="online-dot"></span>' : ""}<strong>@${esc(u.username)}</strong>${u.isAdmin ? ' <span class="badge badge-admin">admin</span>' : ""}</div>
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
    recoverBtn.style.cssText = "background:var(--surface2);color:var(--text);border:1px solid var(--border)";
    recoverBtn.textContent = "Recover account";
    recoverBtn.onclick = async () => {
      if (!confirm("Generate new authenticator secret?")) return;
      try {
        const res = await api("/admin/user/" + userId + "/recover", { method: "POST" });
        if (res.error) throw new Error(res.error);
        $("#recoverUsername").textContent = res.username;
        $("#recoverSecret").textContent = String(res.secret).replace(/=+$/g, "");
        $("#recoverQr").innerHTML = "";
        new QRCode($("#recoverQr"), {
          text: res.otpauthUrl,
          width: 220,
          height: 220,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
        $("#adminUserModal").style.display = "none";
        $("#recoverModal").style.display = "flex";
      } catch (e) { showError(e.message); }
    };
    actions.appendChild(recoverBtn);
    $("#adminContacts").innerHTML = data.contacts.length
      ? data.contacts.map((c) => `<div class="item" style="cursor:default"><strong>@${esc(c.user.username)}</strong>${c.isFriend ? ' <span class="badge badge-friend">Friends</span>' : ""}</div>`).join("")
      : '<div class="empty" style="padding:16px">No contacts</div>';
    $("#adminHistory").innerHTML = data.messages.length
      ? data.messages.map((m) => `<div class="history-msg"><div class="history-meta">Room ${String(m.roomId || "").slice(0, 8)}… · ${new Date(m.createdAt).toLocaleString()}</div><div>${esc(m.text)}</div></div>`).join("")
      : '<div class="empty" style="padding:12px">No messages</div>';
    $("#adminUserModal").style.display = "flex";
  } catch (e) { showError(e.message); }
}

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
