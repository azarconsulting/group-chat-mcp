// Inlined single-page web UI. Served at GET /.
// Kept as a TS module string so it travels with the compiled output regardless of cwd.

// Pure, DOM-free Markdown parser. Lives here as a source string so the exact
// same code runs in two places: inlined into UI_HTML for the browser, and
// eval'd by test/markdown.ts in plain Node. It must never touch the DOM or any
// browser global — it only turns text into a small AST of plain objects. The
// DOM layer (renderInline/renderBlocks below, inside the page script) walks
// that AST with createElement/createTextNode and NEVER assigns innerHTML, so
// the message rendering stays XSS-safe by construction.
export const MARKDOWN_SRC = String.raw`
const GCMD_TICK = String.fromCharCode(96);

function gcmdIsSpace(ch) {
  return ch === undefined || /\s/.test(ch);
}

// Scheme allowlist for links. Anything else (javascript:, data:, ...) is not a
// link and degrades to literal text, so a hostile href can never become live.
function gcmdSafeHref(raw) {
  const url = String(raw).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:[^\s]+$/i.test(url)) return url;
  return null;
}

// Find a closing emphasis/strike delimiter that is "right-flanking" (preceded
// by a non-space) and, for underscores, not intra-word — so snake_case and
// "a * b" don't turn into emphasis.
function gcmdFindClosingFlanked(text, from, marker, underscore) {
  let pos = from;
  while (true) {
    const idx = text.indexOf(marker, pos);
    if (idx === -1) return -1;
    if (idx === from) { pos = idx + 1; continue; }            // empty span
    if (gcmdIsSpace(text[idx - 1])) { pos = idx + marker.length; continue; }
    if (underscore) {
      const after = text[idx + marker.length];
      if (after !== undefined && /[A-Za-z0-9]/.test(after)) { pos = idx + marker.length; continue; }
    }
    return idx;
  }
}

function gcmdTryEmphasis(text, i) {
  const c = text[i];
  if (c === "~") {
    if (text[i + 1] !== "~") return null;
    if (gcmdIsSpace(text[i + 2])) return null;
    const close = gcmdFindClosingFlanked(text, i + 2, "~~", false);
    if (close === -1) return null;
    return { node: { type: "del", children: gcmdParseInline(text.slice(i + 2, close)) }, end: close + 2 };
  }
  if (c !== "*" && c !== "_") return null;
  const underscore = c === "_";
  if (underscore) {
    const prev = i === 0 ? "" : text[i - 1];
    if (/[A-Za-z0-9]/.test(prev)) return null;                // no intra-word underscore opener
  }
  const dbl = text[i + 1] === c;
  const marker = dbl ? c + c : c;
  const contentStart = i + marker.length;
  if (gcmdIsSpace(text[contentStart])) return null;           // opener must hug its content
  const close = gcmdFindClosingFlanked(text, contentStart, marker, underscore);
  if (close === -1) return null;
  const children = gcmdParseInline(text.slice(contentStart, close));
  return { node: { type: dbl ? "strong" : "em", children: children }, end: close + marker.length };
}

function gcmdTryLink(text, i) {
  const close = text.indexOf("]", i + 1);
  if (close === -1 || text[close + 1] !== "(") return null;
  const paren = text.indexOf(")", close + 2);
  if (paren === -1) return null;
  const href = gcmdSafeHref(text.slice(close + 2, paren));
  if (href === null) {
    return { node: { type: "text", value: text.slice(i, paren + 1) }, end: paren + 1 };
  }
  return { node: { type: "link", href: href, children: gcmdParseInline(text.slice(i + 1, close)) }, end: paren + 1 };
}

// Inline pass: bold, italic, code, strikethrough, links, @mentions.
function gcmdParseInline(text) {
  const nodes = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { nodes.push({ type: "text", value: buf }); buf = ""; } };
  while (i < text.length) {
    const c = text[i];
    if (c === GCMD_TICK) {                                     // inline code span (literal inside)
      let run = 1;
      while (text[i + run] === GCMD_TICK) run++;
      const ticks = text.substr(i, run);
      const close = text.indexOf(ticks, i + run);
      if (close !== -1) {
        flush();
        let code = text.slice(i + run, close);
        if (code.length > 1 && code[0] === " " && code[code.length - 1] === " " && /[^ ]/.test(code)) {
          code = code.slice(1, -1);
        }
        nodes.push({ type: "code", value: code });
        i = close + run;
        continue;
      }
      buf += c; i++; continue;
    }
    if (c === "[") {
      const link = gcmdTryLink(text, i);
      if (link) { flush(); nodes.push(link.node); i = link.end; continue; }
      buf += c; i++; continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      const emph = gcmdTryEmphasis(text, i);
      if (emph) { flush(); nodes.push(emph.node); i = emph.end; continue; }
      buf += c; i++; continue;
    }
    if (c === "@" && (i === 0 || gcmdIsSpace(text[i - 1]))) {
      const m = /^@[\w-]+/.exec(text.slice(i));
      if (m) { flush(); nodes.push({ type: "mention", value: m[0] }); i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    buf += c; i++;
  }
  flush();
  return nodes;
}

// A paragraph's lines join with hard breaks (GitHub-comment style) so the chat
// keeps its line-by-line feel.
function gcmdInlineLines(lines) {
  const out = [];
  for (let k = 0; k < lines.length; k++) {
    if (k > 0) out.push({ type: "break" });
    const nodes = gcmdParseInline(lines[k]);
    for (let j = 0; j < nodes.length; j++) out.push(nodes[j]);
  }
  return out;
}

function gcmdFenceInfo(line) {
  let k = 0;
  while (k < 3 && line[k] === " ") k++;
  let t = 0;
  while (line[k + t] === GCMD_TICK) t++;
  if (t < 3) return null;
  return { len: t, lang: line.slice(k + t).trim() };
}

function gcmdIsFenceClose(line, len) {
  let k = 0;
  while (k < 3 && line[k] === " ") k++;
  let t = 0;
  while (line[k + t] === GCMD_TICK) t++;
  return t >= len && /^\s*$/.test(line.slice(k + t));
}

function gcmdListItem(line) {
  let m = /^\s{0,3}([-*+])\s+(.*)$/.exec(line);
  if (m) return { ordered: false, content: m[2] };
  m = /^\s{0,3}(\d+)[.)]\s+(.*)$/.exec(line);
  if (m) return { ordered: true, content: m[2] };
  return null;
}

// Block pass: paragraphs, fenced code, headings (capped at h3), blockquotes,
// and bullet/ordered lists.
function parseMessage(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = gcmdFenceInfo(line);
    if (fence) {
      i++;
      const code = [];
      while (i < lines.length && !gcmdIsFenceClose(lines[i], fence.len)) { code.push(lines[i]); i++; }
      if (i < lines.length) i++;                              // consume closing fence
      blocks.push({ type: "code_block", lang: fence.lang, value: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 3), children: gcmdParseInline(heading[2].trim()) });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { quoted.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push({ type: "blockquote", children: parseMessage(quoted.join("\n")) });
      continue;
    }

    const item = gcmdListItem(line);
    if (item) {
      const ordered = item.ordered;
      const items = [];
      while (i < lines.length) {
        const it = gcmdListItem(lines[i]);
        if (!it || it.ordered !== ordered) break;
        items.push(gcmdParseInline(it.content));
        i++;
      }
      blocks.push({ type: "list", ordered: ordered, items: items });
      continue;
    }

    const para = [];
    while (i < lines.length) {
      const pl = lines[i];
      if (/^\s*$/.test(pl)) break;
      if (gcmdFenceInfo(pl)) break;
      if (/^(#{1,6})\s+/.test(pl)) break;
      if (/^\s*>/.test(pl)) break;
      if (gcmdListItem(pl)) break;
      para.push(pl);
      i++;
    }
    blocks.push({ type: "paragraph", children: gcmdInlineLines(para) });
  }
  return blocks;
}
`;

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
  .msg .who { color: var(--accent); font-weight: 600; font-size: 16px; }
  .msg.from-human .who { color: var(--human); }
  .msg .body { word-break: break-word; font-size: 16px; line-height: 1.45; }
  .msg .body .ts { color: var(--muted); font-size: 11px; margin-left: 8px; }
  .msg .body .mention { color: var(--accent); font-weight: 600; }
  .msg.from-human .body .mention { color: var(--human); }

  /* Rendered Markdown inside a message body. */
  .md-p { margin: 0 0 8px; }
  .md-p:last-child { margin-bottom: 0; }
  .md-h { font-weight: 700; line-height: 1.3; margin: 4px 0 6px; }
  .md-h1 { font-size: 1.3em; }
  .md-h2 { font-size: 1.18em; }
  .md-h3 { font-size: 1.06em; }
  .md strong { font-weight: 700; }
  .md em { font-style: italic; }
  .md del { opacity: 0.65; }
  .md a { color: var(--accent); text-decoration: underline; }
  .md a:hover { color: var(--text); }
  .md code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .md-pre {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    margin: 6px 0;
    overflow-x: auto;
  }
  .md-pre code {
    display: block;
    background: none;
    border: none;
    padding: 0;
    font-size: 0.9em;
    white-space: pre;
  }
  .md-quote {
    margin: 6px 0;
    padding: 2px 0 2px 12px;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .md-list { margin: 6px 0; padding-left: 22px; }
  .md-list li { margin: 2px 0; }

  .placeholder { color: var(--muted); text-align: center; padding: 48px 24px; }

  form#composer {
    display: flex; gap: 8px;
    align-items: flex-end;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--panel);
    flex: 0 0 auto;
    position: relative;
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
  form#composer textarea[name="text"] {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    font-size: 16px;
    font-family: inherit;
    line-height: 1.4;
    resize: none;
    overflow-y: auto;
    min-height: 44px;
    max-height: 220px;
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

  #mentions-dropdown {
    position: absolute;
    bottom: calc(100% - 4px);
    left: 16px;
    right: 16px;
    max-height: 220px;
    overflow-y: auto;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    display: none;
    z-index: 100;
  }
  #mentions-dropdown.open { display: block; }
  #mentions-dropdown .mention-hint {
    padding: 6px 12px;
    color: var(--muted);
    font-size: 11px;
    border-bottom: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .mention-item {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: baseline;
    gap: 2px;
  }
  .mention-item .at { color: var(--muted); }
  .mention-item .name { color: var(--text); }
  .mention-item.active,
  .mention-item:hover {
    background: var(--accent);
  }
  .mention-item.active .at,
  .mention-item.active .name,
  .mention-item:hover .at,
  .mention-item:hover .name {
    color: var(--bg);
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
        <div id="mentions-dropdown"></div>
        <input name="name" placeholder="your name" value="human" />
        <textarea name="text" rows="1" placeholder="join a room to chat..." disabled></textarea>
        <button type="submit" disabled>Send</button>
      </form>
    </main>
  </div>
<script>
${MARKDOWN_SRC}
</script>
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
    textInput: document.querySelector('#composer [name="text"]'),
    sendBtn: document.querySelector('#composer button'),
    newRoomForm: document.getElementById("new-room"),
    newRoomInput: document.querySelector('#new-room input[name="room"]'),
    mentionsDropdown: document.getElementById("mentions-dropdown"),
  };

  const BASE_TITLE = "group-chat-mcp";
  let unread = false;           // a message arrived while the tab was unfocused
  let ws = null;
  let currentRoom = null;       // room name we're currently viewing
  let assignedPeer = null;      // peer name the broker gave us
  let currentPeers = [];        // last known peer list for currentRoom
  let rooms = [];               // last known rooms list
  let backoff = 500;
  let shutdownDeadline = null;  // epoch ms when broker plans to exit
  let countdownInterval = null;
  let mentionState = null;      // { start, query, items, selectedIndex } when @ dropdown open

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

  // True only when this tab is the one the user is actually looking at — covers
  // both "switched to another tab" (hidden) and "switched to another window"
  // (visible but not focused).
  function isFocused() {
    return document.visibilityState === "visible" && document.hasFocus();
  }
  function markUnread() {
    if (unread) return;
    unread = true;
    document.title = "● " + BASE_TITLE;
  }
  function clearUnread() {
    if (!unread) return;
    unread = false;
    document.title = BASE_TITLE;
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
        currentPeers = msg.peers;
        els.nameInput.value = msg.assigned_peer;
        els.roomTitle.textContent = msg.room + "  (you: " + msg.assigned_peer + ")";
        renderPeers(msg.peers);
        renderMessages(msg.messages);
        setComposerEnabled(true);
        els.textInput.focus();
        renderRooms();
        closeMentions();
        break;
      case "unsubscribed":
        currentRoom = null;
        assignedPeer = null;
        currentPeers = [];
        els.roomTitle.textContent = "— no room selected —";
        els.roomPeers.textContent = "";
        els.messages.innerHTML = '<div class="placeholder">Pick a room from the left.</div>';
        setComposerEnabled(false);
        renderRooms();
        closeMentions();
        break;
      case "message":
        if (msg.message.room === currentRoom) {
          appendMessage(msg.message);
          if (!isFocused()) markUnread();
        }
        break;
      case "peers":
        if (msg.room === currentRoom) {
          currentPeers = msg.peers;
          renderPeers(msg.peers);
          if (mentionState) refreshMentionItems();
        }
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
    const content = document.createElement("div");
    content.className = "md";
    renderBlocks(content, parseMessage(m.text));
    body.appendChild(content);
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date(m.at).toLocaleTimeString();
    // Trail the timestamp on the last paragraph/heading so it sits inline after
    // the text; for block-ish endings (code, list, quote) drop it on its own line.
    const last = content.lastElementChild;
    if (last && (last.classList.contains("md-p") || last.classList.contains("md-h"))) {
      last.appendChild(ts);
    } else {
      content.appendChild(ts);
    }
    div.appendChild(body);
    els.messages.appendChild(div);
    if (scroll) scrollToBottom();
  }

  // Walk the inline AST from parseMessage into DOM nodes. Never uses innerHTML,
  // so message text can never inject markup — code spans set textContent and
  // links only ever carry an allowlisted href.
  function renderInline(parent, nodes) {
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          parent.appendChild(document.createTextNode(node.value));
          break;
        case "break":
          parent.appendChild(document.createElement("br"));
          break;
        case "code": {
          const el = document.createElement("code");
          el.textContent = node.value;
          parent.appendChild(el);
          break;
        }
        case "mention": {
          const el = document.createElement("span");
          el.className = "mention";
          el.textContent = node.value;
          parent.appendChild(el);
          break;
        }
        case "link": {
          const a = document.createElement("a");
          a.href = node.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          renderInline(a, node.children);
          parent.appendChild(a);
          break;
        }
        case "strong":
        case "em":
        case "del": {
          const tag = node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del";
          const el = document.createElement(tag);
          renderInline(el, node.children);
          parent.appendChild(el);
          break;
        }
      }
    }
  }

  // Walk the block AST into DOM nodes.
  function renderBlocks(container, blocks) {
    for (const b of blocks) {
      switch (b.type) {
        case "paragraph": {
          const p = document.createElement("p");
          p.className = "md-p";
          renderInline(p, b.children);
          container.appendChild(p);
          break;
        }
        case "heading": {
          const h = document.createElement("div");
          h.className = "md-h md-h" + b.level;
          renderInline(h, b.children);
          container.appendChild(h);
          break;
        }
        case "code_block": {
          const pre = document.createElement("pre");
          pre.className = "md-pre";
          const code = document.createElement("code");
          code.textContent = b.value;
          pre.appendChild(code);
          container.appendChild(pre);
          break;
        }
        case "blockquote": {
          const bq = document.createElement("blockquote");
          bq.className = "md-quote";
          renderBlocks(bq, b.children);
          container.appendChild(bq);
          break;
        }
        case "list": {
          const list = document.createElement(b.ordered ? "ol" : "ul");
          list.className = "md-list";
          for (const item of b.items) {
            const li = document.createElement("li");
            renderInline(li, item);
            list.appendChild(li);
          }
          container.appendChild(list);
          break;
        }
      }
    }
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (mentionState) { closeMentions(); return; }
    const text = els.textInput.value.trim();
    if (!text || !currentRoom) return;
    send({ type: "send", text });
    els.textInput.value = "";
    autoResize();
  });

  function autoResize() {
    els.textInput.style.height = "auto";
    els.textInput.style.height = els.textInput.scrollHeight + "px";
  }

  els.newRoomForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const room = els.newRoomInput.value.trim();
    if (!room) return;
    const as = (els.nameInput.value || "human").trim() || "human";
    send({ type: "subscribe", room, as });
    els.newRoomInput.value = "";
  });

  // Rename the active peer when the name input is edited (commits on blur/Enter).
  els.nameInput.addEventListener("change", () => {
    const desired = (els.nameInput.value || "").trim();
    if (!desired) {
      els.nameInput.value = assignedPeer || "human";
      return;
    }
    if (!currentRoom || desired === assignedPeer) return;
    send({ type: "subscribe", room: currentRoom, as: desired });
  });

  // --- @-mention dropdown -------------------------------------------------
  function currentMentionToken() {
    const value = els.textInput.value;
    const cursor = els.textInput.selectionStart;
    if (cursor === null || cursor === undefined) return null;
    let i = cursor - 1;
    while (i >= 0 && !/\s/.test(value[i])) {
      if (value[i] === "@") {
        if (i === 0 || /\s/.test(value[i - 1])) {
          return { start: i, query: value.slice(i + 1, cursor) };
        }
        return null;
      }
      i--;
    }
    return null;
  }

  function mentionCandidates(query) {
    const q = query.toLowerCase();
    return currentPeers
      .filter((p) => p !== assignedPeer)
      .filter((p) => p.toLowerCase().includes(q));
  }

  function updateMentions() {
    const token = currentMentionToken();
    if (!token) { closeMentions(); return; }
    const items = mentionCandidates(token.query);
    if (items.length === 0) { closeMentions(); return; }
    if (mentionState && mentionState.start === token.start) {
      mentionState.query = token.query;
      mentionState.items = items;
      mentionState.selectedIndex = Math.min(mentionState.selectedIndex, items.length - 1);
    } else {
      mentionState = { start: token.start, query: token.query, items, selectedIndex: 0 };
    }
    renderMentions();
  }

  function refreshMentionItems() {
    if (!mentionState) return;
    const items = mentionCandidates(mentionState.query);
    if (items.length === 0) { closeMentions(); return; }
    mentionState.items = items;
    mentionState.selectedIndex = Math.min(mentionState.selectedIndex, items.length - 1);
    renderMentions();
  }

  function renderMentions() {
    if (!mentionState) {
      els.mentionsDropdown.classList.remove("open");
      els.mentionsDropdown.innerHTML = "";
      return;
    }
    els.mentionsDropdown.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "mention-hint";
    hint.textContent = "↑↓ navigate · Enter to insert · Esc to close";
    els.mentionsDropdown.appendChild(hint);
    for (let i = 0; i < mentionState.items.length; i++) {
      const peer = mentionState.items[i];
      const item = document.createElement("div");
      item.className = "mention-item" + (i === mentionState.selectedIndex ? " active" : "");
      const at = document.createElement("span");
      at.className = "at";
      at.textContent = "@";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = peer;
      item.appendChild(at);
      item.appendChild(name);
      item.addEventListener("mousedown", (e) => {
        // Prevent the input from losing focus before we read its selection.
        e.preventDefault();
        commitMention(i);
      });
      els.mentionsDropdown.appendChild(item);
    }
    els.mentionsDropdown.classList.add("open");
  }

  function closeMentions() {
    mentionState = null;
    els.mentionsDropdown.classList.remove("open");
    els.mentionsDropdown.innerHTML = "";
  }

  function commitMention(index) {
    if (!mentionState) return;
    const peer = mentionState.items[index];
    if (!peer) return;
    const value = els.textInput.value;
    const before = value.slice(0, mentionState.start);
    let tokenEnd = mentionState.start + 1;
    while (tokenEnd < value.length && !/\s/.test(value[tokenEnd])) tokenEnd++;
    const after = value.slice(tokenEnd);
    const insertion = "@" + peer + " ";
    els.textInput.value = before + insertion + after;
    const newCursor = before.length + insertion.length;
    els.textInput.setSelectionRange(newCursor, newCursor);
    els.textInput.focus();
    autoResize();
    closeMentions();
  }

  els.textInput.addEventListener("input", () => {
    autoResize();
    updateMentions();
  });
  els.textInput.addEventListener("click", updateMentions);
  els.textInput.addEventListener("keyup", (e) => {
    // Update on cursor moves that don't fire 'input'.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      updateMentions();
    }
  });
  els.textInput.addEventListener("keydown", (e) => {
    if (mentionState) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionState.selectedIndex = (mentionState.selectedIndex + 1) % mentionState.items.length;
        renderMentions();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionState.selectedIndex = (mentionState.selectedIndex - 1 + mentionState.items.length) % mentionState.items.length;
        renderMentions();
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commitMention(mentionState.selectedIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeMentions();
      }
      return;
    }
    // Plain Enter sends; Shift+Enter (and other modifiers) inserts a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (typeof els.composer.requestSubmit === "function") {
        els.composer.requestSubmit();
      } else {
        els.composer.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
    }
  });
  els.textInput.addEventListener("blur", () => {
    // Allow mousedown selection (which fires before blur) to commit first.
    setTimeout(() => {
      if (document.activeElement !== els.textInput) closeMentions();
    }, 120);
  });

  // Clear the unread dot the moment the user comes back to this tab/window.
  document.addEventListener("visibilitychange", () => { if (isFocused()) clearUnread(); });
  window.addEventListener("focus", () => { if (isFocused()) clearUnread(); });

  connect();
})();
</script>
</body>
</html>
`;
