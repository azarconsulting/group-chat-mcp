import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Message } from "../shared/types.js";
import {
  createGraceExit,
  EMPTY_GRACE_MS,
  installLockfile,
  openBrowser,
} from "./lifecycle.js";
import { PeerNotInRoomError, RoomNotFoundError, Store } from "./store.js";
import { UI_HTML } from "./ui.js";

export interface BrokerOptions {
  port: number;
  host?: string;
  /**
   * When true (default for `serve`), the broker writes a lockfile, opens the
   * browser to its URL, and exits 30s after the last room empties.
   */
  manageLifecycle?: boolean;
  onAllRoomsEmpty?: () => void;
}

export async function startBroker(opts: BrokerOptions): Promise<{
  app: FastifyInstance;
  store: Store;
  url: string;
}> {
  const manageLifecycle = opts.manageLifecycle ?? true;
  const sockets = new Set<WebSocket>();

  const broadcast = (payload: unknown) => {
    const json = JSON.stringify(payload);
    for (const s of sockets) {
      if (s.readyState === s.OPEN) s.send(json);
    }
  };

  const grace = manageLifecycle
    ? createGraceExit({
        graceMs: EMPTY_GRACE_MS,
        onTimerStart: (deadline) =>
          broadcast({ type: "shutdown_pending", deadline }),
        onTimerCancel: () => broadcast({ type: "shutdown_cancelled" }),
      })
    : null;

  const store = new Store({
    onRoomEmpty: () => {
      if (store.listRooms().length === 0) {
        opts.onAllRoomsEmpty?.();
        grace?.onAllRoomsEmpty();
      }
    },
  });

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof RoomNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof PeerNotInRoomError) return reply.code(409).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode) return reply.code(e.statusCode).send({ error: e.message });
    reply.code(500).send({ error: e.message ?? "internal error" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(UI_HTML);
  });

  app.get("/rooms", async () => store.listRooms());

  app.get("/ws", { websocket: true }, (socket) => {
    handleWebSocket(socket, store, sockets, () => grace?.getDeadline() ?? null);
  });

  app.post<{
    Params: { room: string };
    Body: { as: string };
  }>(
    "/rooms/:room/join",
    {
      schema: {
        body: {
          type: "object",
          required: ["as"],
          properties: { as: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req) => store.joinRoom(req.params.room, req.body.as),
  );

  app.post<{
    Params: { room: string };
    Body: { peer: string };
  }>(
    "/rooms/:room/leave",
    {
      schema: {
        body: {
          type: "object",
          required: ["peer"],
          properties: { peer: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req) => store.leaveRoom(req.params.room, req.body.peer),
  );

  app.delete<{ Params: { room: string } }>(
    "/rooms/:room",
    async (req) => store.deleteRoom(req.params.room),
  );

  app.delete<{ Params: { room: string; peer: string } }>(
    "/rooms/:room/peers/:peer",
    async (req) => store.leaveRoom(req.params.room, req.params.peer),
  );

  app.post<{
    Params: { room: string };
    Body: { peer: string; text: string };
  }>(
    "/rooms/:room/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["peer", "text"],
          properties: {
            peer: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req) => store.sendMessage(req.params.room, req.body.peer, req.body.text),
  );

  app.get<{
    Params: { room: string };
    Querystring: { peer: string; timeout_s?: string };
  }>(
    "/rooms/:room/messages/wait",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["peer"],
          properties: {
            peer: { type: "string", minLength: 1 },
            timeout_s: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const timeoutMs = clampTimeout(req.query.timeout_s);
      return store.waitForMessage(req.params.room, req.query.peer, timeoutMs);
    },
  );

  app.get<{
    Params: { room: string };
    Querystring: { peer: string; count?: string };
  }>(
    "/rooms/:room/messages/last",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["peer"],
          properties: {
            peer: { type: "string", minLength: 1 },
            count: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const count = clampCount(req.query.count);
      return store.getLastMessages(req.params.room, req.query.peer, count);
    },
  );

  const host = opts.host ?? "127.0.0.1";
  await app.listen({ port: opts.port, host });
  const url = `http://${host}:${opts.port}`;

  if (manageLifecycle) {
    installLockfile(process.pid, opts.port);
    // Cancel any pending grace timer if a peer joins (rooms-changed fires).
    store.on("rooms-changed", () => {
      if (store.listRooms().length > 0) grace?.cancel();
    });
    // A fresh broker starts with zero rooms — kick off the countdown so we
    // also exit if nobody ever joins.
    if (store.listRooms().length === 0) grace?.onAllRoomsEmpty();
    openBrowser(url);
  }

  // Store the cancel handle so an explicit shutdown could call it later if needed.
  // Currently nothing calls it externally — grace.cancel() runs on rooms-changed.

  return { app, store, url };
}

function clampTimeout(raw: string | undefined): number {
  const n = raw === undefined ? 60 : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60_000;
  return Math.min(Math.max(n, 0), 300) * 1000;
}

function clampCount(raw: string | undefined): number {
  const n = raw === undefined ? 1 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 100);
}

interface SocketSession {
  watchRooms: boolean;
  subscribedRoom: string | null;
  assignedPeer: string | null;
}

function handleWebSocket(
  socket: WebSocket,
  store: Store,
  sockets: Set<WebSocket>,
  getShutdownDeadline: () => number | null,
): void {
  const session: SocketSession = {
    watchRooms: false,
    subscribedRoom: null,
    assignedPeer: null,
  };

  sockets.add(socket);

  const sendJson = (obj: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };

  // If a shutdown countdown is already in progress, tell this newcomer.
  const deadline = getShutdownDeadline();
  if (deadline !== null) sendJson({ type: "shutdown_pending", deadline });

  const onMessage = (msg: Message) => {
    if (msg.room === session.subscribedRoom) sendJson({ type: "message", message: msg });
  };

  const onRoomsChanged = () => {
    if (session.watchRooms) sendJson({ type: "rooms", rooms: store.listRooms() });
  };

  const onPeersChanged = (room: string, peers: string[]) => {
    if (room === session.subscribedRoom) {
      sendJson({ type: "peers", room, peers });
      // Detect being kicked: I'm subscribed but not in the peer list.
      if (session.assignedPeer && !peers.includes(session.assignedPeer)) {
        session.subscribedRoom = null;
        session.assignedPeer = null;
        sendJson({ type: "unsubscribed", reason: "kicked" });
      }
    }
  };

  const onRoomDeleted = (room: string) => {
    if (room === session.subscribedRoom) {
      session.subscribedRoom = null;
      session.assignedPeer = null;
      sendJson({ type: "unsubscribed", reason: "deleted" });
    }
  };

  store.on("message", onMessage);
  store.on("rooms-changed", onRoomsChanged);
  store.on("peers-changed", onPeersChanged);
  store.on("room-deleted", onRoomDeleted);

  const detach = () => {
    store.off("message", onMessage);
    store.off("rooms-changed", onRoomsChanged);
    store.off("peers-changed", onPeersChanged);
    store.off("room-deleted", onRoomDeleted);
  };

  const leaveCurrent = () => {
    if (session.subscribedRoom && session.assignedPeer) {
      try {
        store.leaveRoom(session.subscribedRoom, session.assignedPeer);
      } catch {
        // room already gone
      }
    }
    session.subscribedRoom = null;
    session.assignedPeer = null;
  };

  socket.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      sendJson({ type: "error", error: "invalid json" });
      return;
    }
    handleClientMessage(parsed as Record<string, unknown>, session, store, sendJson, leaveCurrent);
  });

  socket.on("close", () => {
    sockets.delete(socket);
    leaveCurrent();
    detach();
  });
}

function handleClientMessage(
  msg: Record<string, unknown>,
  session: SocketSession,
  store: Store,
  sendJson: (obj: unknown) => void,
  leaveCurrent: () => void,
): void {
  switch (msg.type) {
    case "watch_rooms": {
      session.watchRooms = true;
      sendJson({ type: "rooms", rooms: store.listRooms() });
      return;
    }
    case "subscribe": {
      const room = typeof msg.room === "string" ? msg.room : null;
      const as = typeof msg.as === "string" ? msg.as : "human";
      if (!room) {
        sendJson({ type: "error", error: "missing room" });
        return;
      }
      leaveCurrent();
      try {
        const result = store.joinRoom(room, as);
        session.subscribedRoom = result.room;
        session.assignedPeer = result.assigned_peer;
        sendJson({
          type: "subscribed",
          room: result.room,
          assigned_peer: result.assigned_peer,
          peers: result.peers,
          messages: store.getAllMessages(result.room),
        });
      } catch (err) {
        sendJson({ type: "error", error: (err as Error).message });
      }
      return;
    }
    case "unsubscribe": {
      leaveCurrent();
      sendJson({ type: "unsubscribed", reason: "self" });
      return;
    }
    case "delete_room": {
      const room = typeof msg.room === "string" ? msg.room : null;
      if (!room) {
        sendJson({ type: "error", error: "missing room" });
        return;
      }
      try {
        store.deleteRoom(room);
      } catch (err) {
        sendJson({ type: "error", error: (err as Error).message });
      }
      return;
    }
    case "kick_peer": {
      const room = typeof msg.room === "string" ? msg.room : null;
      const peer = typeof msg.peer === "string" ? msg.peer : null;
      if (!room || !peer) {
        sendJson({ type: "error", error: "missing room or peer" });
        return;
      }
      try {
        store.leaveRoom(room, peer);
      } catch (err) {
        sendJson({ type: "error", error: (err as Error).message });
      }
      return;
    }
    case "send": {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!session.subscribedRoom || !session.assignedPeer) {
        sendJson({ type: "error", error: "subscribe to a room before sending" });
        return;
      }
      if (!text) {
        sendJson({ type: "error", error: "empty message" });
        return;
      }
      try {
        store.sendMessage(session.subscribedRoom, session.assignedPeer, text);
      } catch (err) {
        sendJson({ type: "error", error: (err as Error).message });
      }
      return;
    }
    default:
      sendJson({ type: "error", error: `unknown message type: ${String(msg.type)}` });
  }
}
