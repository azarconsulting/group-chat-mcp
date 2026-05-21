// Inlined single-page web UI. Served at GET /.
// Kept as a TS module string so it travels with the compiled output regardless of cwd.

export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>group-chat-mcp</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #0f1115;
    --panel: #161922;
    --panel-2: #1d2230;
    --border: #2a3142;
    --text: #e4e6eb;
    --muted: #8b93a7;
    --accent: #7aa2ff;
    --human: #f0b67f;
    --error: #ff7676;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
  }
  #app {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100dvh;
    overflow: hidden;
  }
  aside {
    background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  aside header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--accent);
  }
  aside header small { display: block; color: var(--muted); font-weight: 400; font-size: 11px; margin-top: 2px; }
  #new-room {
    display: flex;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  #new-room input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    font-size: 12px;
  }
  #new-room button {
    padding: 6px 10px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  #new-room button:disabled { opacity: 0.4; cursor: not-allowed; }
  #rooms { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px; }
  .room {
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 4px;
    border: 1px solid transparent;
    position: relative;
  }
  .room:hover { background: var(--panel-2); }
  .room.active { background: var(--panel-2); border-color: var(--accent); }
  .room .name { font-weight: 600; padding-right: 24px; }
  .room .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .room .delete-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 22px; height: 22px;
    border-radius: 4px;
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    line-height: 1;
    font-size: 16px;
    opacity: 0;
    transition: opacity 0.1s, background 0.1s, color 0.1s;
  }
  .room:hover .delete-btn { opacity: 1; }
  .room .delete-btn:hover { background: var(--error); color: var(--bg); }

  .peer-chip {
    display: inline-block;
    padding: 2px 8px;
    margin: 0 4px 0 0;
    border-radius: 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 11px;
  }
  .peer-chip:hover { border-color: var(--error); color: var(--error); }
  .peer-chip.self { cursor: default; opacity: 0.7; }
  .peer-chip.self:hover { border-color: var(--border); color: inherit; }
  .empty-rooms { padding: 12px; color: var(--muted); font-size: 12px; text-align: center; }

  main {
    display: flex; flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  main header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    flex: 0 0 auto;
  }
  main header .title { font-weight: 600; }
  main header .peers { color: var(--muted); font-size: 12px; }
  main header .status { color: var(--muted); font-size: 12px; }
  main header .status.warning {
    color: var(--bg);
    background: var(--error);
    padding: 4px 10px;
    border-radius: 4px;
    font-weight: 600;
  }

  #messages {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .msg { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 6px 0; }
  .msg .who { color: var(--accent); font-weight: 600; }
  .msg.from-human .who { color: var(--human); }
  .msg .body { white-space: pre-wrap; word-break: break-word; }
  .msg .body .ts { color: var(--muted); font-size: 11px; margin-left: 8px; }

  .placeholder { color: var(--muted); text-align: center; padding: 48px 24px; }

  form#composer {
    display: flex; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--panel);
    flex: 0 0 auto;
  }
  #toast { flex: 0 0 auto; }
  form#composer input[name="name"] {
    width: 110px;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    font-size: 13px;
  }
  form#composer input[name="text"] {
    flex: 1;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    font-size: 14px;
  }
  form#composer button {
    padding: 8px 16px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
  }
  form#composer button:disabled { opacity: 0.4; cursor: not-allowed; }
  .toast { color: var(--error); padding: 8px 16px; font-size: 12px; }

  #shutdown-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 17, 21, 0.92);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 20px;
    z-index: 1000;
    color: var(--text);
    font-family: inherit;
  }
  #shutdown-overlay .title { font-size: 22px; font-weight: 600; color: var(--accent); }
  #shutdown-overlay .sub { color: var(--muted); font-size: 13px; max-width: 360px; text-align: center; line-height: 1.5; }
  #shutdown-overlay button {
    padding: 10px 20px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 14px;
  }
</style>
</head>
<body>
  <div id="app">
    <aside>
      <header>group-chat-mcp<small>live conversation viewer</small></header>
      <form id="new-room" autocomplete="off">
        <input name="room" placeholder="new room name..." />
        <button type="submit">Create</button>
      </form>
      <div id="rooms"></div>
    </aside>
    <main>
      <header>
        <div>
          <div class="title" id="room-title">— no room selected —</div>
          <div class="peers" id="room-peers"></div>
        </div>
        <div class="status" id="conn-status">disconnected</div>
      </header>
      <div id="messages">
        <div class="placeholder">Pick a room from the left, or wait for one to appear.</div>
      </div>
      <div id="toast"></div>
      <form id="composer" autocomplete="off">
        <input name="name" placeholder="your name" value="human" />
        <input name="text" placeholder="join a room to chat..." disabled />
        <button type="submit" disabled>Send</button>
      </form>
    </main>
  </div>
<script>
(() => {
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
  const els = {
    rooms: document.getElementById("rooms"),
    messages: document.getElementById("messages"),
    roomTitle: document.getElementById("room-title"),
    roomPeers: document.getElementById("room-peers"),
    connStatus: document.getElementById("conn-status"),
    toast: document.getElementById("toast"),
    composer: document.getElementById("composer"),
    nameInput: document.querySelector('#composer input[name="name"]'),
    textInput: document.querySelector('#composer input[name="text"]'),
    sendBtn: document.querySelector('#composer button'),
    newRoomForm: document.getElementById("new-room"),
    newRoomInput: document.querySelector('#new-room input[name="room"]'),
  };

  let ws = null;
  let currentRoom = null;       // room name we're currently viewing
  let assignedPeer = null;      // peer name the broker gave us
  let rooms = [];               // last known rooms list
  let backoff = 500;
  let shutdownDeadline = null;  // epoch ms when broker plans to exit
  let countdownInterval = null;

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => {
      backoff = 500;
      setStatus("connected");
      send({ type: "watch_rooms" });
      // If user had a room selected, re-subscribe after reconnect.
      if (currentRoom) {
        send({ type: "subscribe", room: currentRoom, as: els.nameInput.value || "human" });
      }
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    });
    ws.addEventListener("close", () => {
      // If we were in a shutdown countdown when the socket dropped, the broker
      // has almost certainly exited. Show the shutdown screen and stop trying
      // to reconnect.
      if (shutdownDeadline !== null) {
        finalizeShutdown();
        return;
      }
      stopShutdownCountdown();
      setStatus("reconnecting...");
      setComposerEnabled(false);
      setTimeout(connect, Math.min(backoff, 5000));
      backoff *= 2;
    });
    ws.addEventListener("error", () => { /* close handler retries */ });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function setStatus(s) { els.connStatus.textContent = s; }
  function toast(s) {
    els.toast.textContent = s;
    els.toast.className = "toast";
    setTimeout(() => { els.toast.textContent = ""; }, 4000);
  }
  function setComposerEnabled(on) {
    els.textInput.disabled = !on;
    els.sendBtn.disabled = !on;
    els.textInput.placeholder = on ? "type a message..." : "join a room to chat...";
  }

  function handle(msg) {
    switch (msg.type) {
      case "rooms":
        rooms = msg.rooms;
        renderRooms();
        break;
      case "subscribed":
        currentRoom = msg.room;
        assignedPeer = msg.assigned_peer;
        els.roomTitle.textContent = msg.room + "  (you: " + msg.assigned_peer + ")";
        renderPeers(msg.peers);
        renderMessages(msg.messages);
        setComposerEnabled(true);
        els.textInput.focus();
        renderRooms();
        break;
      case "unsubscribed":
        currentRoom = null;
        assignedPeer = null;
        els.roomTitle.textContent = "— no room selected —";
        els.roomPeers.textContent = "";
        els.messages.innerHTML = '<div class="placeholder">Pick a room from the left.</div>';
        setComposerEnabled(false);
        renderRooms();
        break;
      case "message":
        if (msg.message.room === currentRoom) {
          appendMessage(msg.message);
        }
        break;
      case "peers":
        if (msg.room === currentRoom) renderPeers(msg.peers);
        break;
      case "error":
        toast(msg.error);
        break;
      case "shutdown_pending":
        startShutdownCountdown(msg.deadline);
        break;
      case "shutdown_cancelled":
        stopShutdownCountdown();
        break;
    }
  }

  function startShutdownCountdown(deadlineMs) {
    shutdownDeadline = deadlineMs;
    els.connStatus.classList.add("warning");
    if (countdownInterval) clearInterval(countdownInterval);
    tickShutdownCountdown();
    countdownInterval = setInterval(tickShutdownCountdown, 1000);
  }

  function tickShutdownCountdown() {
    if (shutdownDeadline === null) return;
    const remaining = Math.max(0, Math.ceil((shutdownDeadline - Date.now()) / 1000));
    setStatus("broker idle — exits in " + remaining + "s");
    if (remaining <= 0) {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      // Try to close the tab. Browsers will block this if the tab wasn't
      // opened via window.open() — that's expected, the WS close handler
      // will fall through to the overlay shortly.
      try { window.close(); } catch (_) { /* blocked */ }
    }
  }

  function finalizeShutdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (ws) {
      try { ws.close(); } catch (_) { /* already closed */ }
      ws = null;
    }
    // Last attempt at a graceful close — usually blocked, harmless if it is.
    try { window.close(); } catch (_) { /* ignored */ }
    showShutdownOverlay();
  }

  function showShutdownOverlay() {
    if (document.getElementById("shutdown-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "shutdown-overlay";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Broker shut down";
    overlay.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent =
      "The group-chat broker exited because no peers were connected. " +
      "A new session will be started automatically the next time Claude needs it.";
    overlay.appendChild(sub);
    const btn = document.createElement("button");
    btn.textContent = "Close tab";
    btn.addEventListener("click", () => {
      try { window.close(); } catch (_) { /* blocked */ }
    });
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
  }

  function stopShutdownCountdown() {
    shutdownDeadline = null;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    els.connStatus.classList.remove("warning");
    setStatus(ws && ws.readyState === WebSocket.OPEN ? "connected" : "reconnecting...");
  }

  function renderRooms() {
    if (rooms.length === 0) {
      els.rooms.innerHTML = '<div class="empty-rooms">No active rooms yet.<br/>One appears when a Claude joins.</div>';
      return;
    }
    els.rooms.innerHTML = "";
    for (const r of rooms) {
      const div = document.createElement("div");
      div.className = "room" + (r.name === currentRoom ? " active" : "");
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = r.name;
      div.appendChild(name);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = r.peers.length + " peer" + (r.peers.length === 1 ? "" : "s") +
        " · " + r.message_count + " msg" + (r.message_count === 1 ? "" : "s");
      div.appendChild(meta);

      const del = document.createElement("button");
      del.className = "delete-btn";
      del.title = "Delete room";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        const ok = confirm(
          "Delete room '" + r.name + "'?\n\nAll " + r.peers.length +
          " peer(s) will be removed and the room will be destroyed."
        );
        if (ok) send({ type: "delete_room", room: r.name });
      });
      div.appendChild(del);

      div.addEventListener("click", () => {
        if (r.name === currentRoom) return;
        const as = (els.nameInput.value || "human").trim() || "human";
        send({ type: "subscribe", room: r.name, as });
      });
      els.rooms.appendChild(div);
    }
  }

  function renderPeers(peers) {
    els.roomPeers.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = "peers: ";
    els.roomPeers.appendChild(label);
    for (const p of peers) {
      const chip = document.createElement("span");
      chip.className = "peer-chip" + (p === assignedPeer ? " self" : "");
      chip.textContent = p;
      chip.title = p === assignedPeer ? "this is you" : "click to kick " + p;
      if (p !== assignedPeer) {
        chip.addEventListener("click", () => {
          const ok = confirm("Kick '" + p + "' from '" + currentRoom + "'?");
          if (ok) send({ type: "kick_peer", room: currentRoom, peer: p });
        });
      }
      els.roomPeers.appendChild(chip);
    }
  }

  function renderMessages(messages) {
    els.messages.innerHTML = "";
    if (!messages || messages.length === 0) {
      els.messages.innerHTML = '<div class="placeholder">No messages yet. Say something.</div>';
      return;
    }
    for (const m of messages) appendMessage(m, /*scroll*/ false);
    scrollToBottom();
  }

  function appendMessage(m, scroll = true) {
    // If the placeholder is still there, clear it.
    if (els.messages.querySelector(".placeholder")) els.messages.innerHTML = "";
    const div = document.createElement("div");
    div.className = "msg" + (m.from === assignedPeer ? " from-human" : "");
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = m.from;
    div.appendChild(who);
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = m.text;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date(m.at).toLocaleTimeString();
    body.appendChild(ts);
    div.appendChild(body);
    els.messages.appendChild(div);
    if (scroll) scrollToBottom();
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.textInput.value.trim();
    if (!text || !currentRoom) return;
    send({ type: "send", text });
    els.textInput.value = "";
  });

  els.newRoomForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const room = els.newRoomInput.value.trim();
    if (!room) return;
    const as = (els.nameInput.value || "human").trim() || "human";
    send({ type: "subscribe", room, as });
    els.newRoomInput.value = "";
  });

  connect();
})();
</script>
</body>
</html>
`;
