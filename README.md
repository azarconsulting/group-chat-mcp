# group-chat-mcp

An MCP server that lets two or more Claude Code instances talk to each other,
with a live web UI so you can read the conversation and step in as a third
participant.

Useful when you have a frontend Claude in one VS Code window and a backend
Claude in another, and you'd rather have them coordinate directly than copy
handover documents back and forth.

> Vibe-coded with [Claude Code](https://claude.com/claude-code) — designed
> conversationally, no spec written up front.

## Why this exists

I kept having two Claude Code sessions open — one in a frontend repo, one in
a backend repo — and the only way to keep them in sync was to ask one to
write a handover document, paste it into the other, then do the same in
reverse for the reply. Constant context-shuffling. This is the same idea but
without the copy-paste step, plus a UI so I can see what they're saying to
each other and step in when they get something wrong.

## Status & disclaimer

This is **early, lightly-tested software** written for my own use. There is a
small end-to-end smoke test and the major paths work on Windows, but there's
no broader test suite, no CI, and no production track record.

**Use at your own risk.** Fork it, install it, modify it freely under the
[MIT license](LICENSE), but understand that:

- There is no warranty of any kind — see the LICENSE for the full legal text.
- It has only been exercised on Windows + Node 25. macOS / Linux paths are
  written but not verified.
- The broker has no authentication and is intended for single-user, local
  collaboration only. See [Security model](#security-model).
- Bugs and breaking changes between versions are likely while it's pre-1.0.

If you find a problem or want a feature, open an issue — but please don't
expect a response on any particular schedule.

## How it works

```
  Claude Code (frontend repo)              Claude Code (backend repo)
         │                                          │
         │ stdio                                    │ stdio
         ▼                                          ▼
   MCP server  ──── HTTP ────►  BROKER  ◄──── HTTP ──── MCP server
                                  ▲
                                  │ WebSocket
                                  │
                            Browser UI
                                  ▲
                                  │ you, watching/typing
```

- Each Claude Code spawns its own MCP stdio process.
- The first MCP process to start auto-spawns the broker and opens the web UI
  in your default browser.
- Other MCP processes detect the running broker via a lockfile and connect to
  it. No manual coordination needed.
- The broker exits 30 seconds after the last peer leaves (or, if nothing ever
  connects, 30 seconds after startup).

## Install & build

```sh
npm install
npm run build
```

Requires Node 25+.

## Register with Claude Code

User scope (available in every project):

```sh
claude mcp add group-chat -s user -- node "<absolute path>/dist/cli.js" mcp
```

Then in each repo's `CLAUDE.md`, brief Claude on what to identify as:

```markdown
## Group chat
When you need to coordinate with the other Claude, use the `group-chat` MCP.
Join room `feature-x` as `frontend` (or whatever role fits this repo).
```

Verify it's registered:

```sh
claude mcp list
```

## What Claude can do

Six tools are exposed:

| Tool | Purpose |
|---|---|
| `list_rooms` | See active rooms, peers, message counts |
| `join_room` | Join a room (or create it) as a peer name |
| `send_message` | Broadcast to the room |
| `wait_for_message` | Block until a new message arrives (cursor-based, max 300s) |
| `get_last_message` | Fast-forward to the most recent N messages, skip the rest |
| `leave_room` | Leave the room (auto-GC'd when empty) |

The MCP server tracks each Claude's room+peer state in-process, so Claude only
passes the message text — not the peer name — to most tools.

### Context-inflation protection

The broker keeps a per-peer cursor and only delivers each message once. Claude
never re-reads its own messages or anything it has already seen. The
`get_last_message` tool advances the cursor past the entire history, so Claude
can do a quick catch-up without pulling all prior messages into context.

## What you can do in the web UI

- See all active rooms in the sidebar with peer counts.
- **Create a new room** by typing a name and hitting Create.
- **Click a room** to subscribe and watch the conversation live (you join as
  `human`, or whatever name you put in the composer).
- **Type messages** to participate as `human`.
- **Click a peer name** in the room header to kick that peer (useful for
  removing ghost Claudes that died without leaving).
- **Click the ×** on a room in the sidebar to delete the whole room.
- When the broker is about to exit (no peers connected), a red countdown shows
  in the top-right.

## Commands

```sh
group-chat-mcp serve [--port 7531]    # start the broker manually
group-chat-mcp mcp [--port 7531]      # start the MCP stdio server
                                      # (Claude Code does this for you)
```

## Environment

| Variable | Default | What it does |
|---|---|---|
| `GROUP_CHAT_PORT` | `7531` | Broker port |
| `GROUP_CHAT_URL` | (unset) | Bypass auto-spawn; connect to a broker at this URL |

## Security model

This is designed for **single-user local collaboration** on the machine where
your Claude Code instances run. Specifically:

- The broker binds to `127.0.0.1` only — it is not reachable from other
  machines on your network.
- There is **no authentication**. Any process running locally with network
  access can read, post to, and delete rooms via the broker's HTTP API and
  WebSocket. The same is true of the web UI: anyone with a browser pointed at
  `http://127.0.0.1:7531` can join rooms as `human`.
- Messages live only in memory and only for the lifetime of the broker
  process. Nothing is persisted to disk.
- Do not expose the broker port to other machines (e.g. by reverse-proxying
  it, port-forwarding it, or changing the bind host to `0.0.0.0`). If you
  need that, add auth first.

If you're running untrusted code on the same machine, treat this MCP as
in-band with that code — it offers no isolation from it.

## Lifecycle details

- **Lockfile**: `<tmpdir>/group-chat-mcp.lock` holds the broker pid + port.
- **Auto-spawn**: The MCP server reads the lockfile, pings `/health`, and
  spawns a detached broker if none is running. Stale lockfiles (dead pid or
  unreachable broker) are removed automatically.
- **Graceful shutdown**: 30 seconds after the last peer leaves the last room,
  the broker exits and clears its lockfile. Any peer joining (including you
  creating a room in the UI) cancels the timer.
- **Abrupt shutdown**: If the broker is killed via Task Manager or similar,
  the lockfile is left behind. The next MCP startup detects this via a pid
  liveness check and cleans it up.
- **Browser tab**: On shutdown the UI shows a "Broker shut down" overlay
  and attempts `window.close()`. Most browsers block this for tabs opened
  externally — the overlay gives you a manual close button as a fallback.

## Testing

```sh
npx tsx test/e2e.ts
```

Spawns two MCP clients against a freshly-spawned broker, runs them through
the full conversation lifecycle, and verifies cursor delivery, long-poll
wakeup, peer kick, room deletion, and grace-period exit.

## Project layout

```
src/
├── cli.ts              # serve | mcp subcommands
├── shared/
│   ├── types.ts        # domain shapes
│   └── lockfile.ts     # tmpdir lockfile + pid-alive check
├── broker/
│   ├── store.ts        # in-memory rooms + per-peer cursors + EventEmitter
│   ├── server.ts       # Fastify HTTP + WebSocket + serves UI
│   ├── lifecycle.ts    # lockfile install, browser open, grace-period exit
│   └── ui.ts           # inlined single-page UI (HTML + CSS + JS)
└── mcp/
    ├── client.ts       # typed HTTP client for the broker
    ├── server.ts       # MCP stdio server with 6 tools
    └── launch.ts       # ensureBrokerRunning — lockfile detect + auto-spawn

test/
└── e2e.ts              # end-to-end test using the MCP SDK client
```
