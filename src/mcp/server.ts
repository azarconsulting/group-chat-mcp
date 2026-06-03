import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Message } from "../shared/types.js";
import { BrokerClient, BrokerError } from "./client.js";
import { ensureBrokerRunning } from "./launch.js";

export interface McpRuntimeOptions {
  preferredPort: number;
  /**
   * If set, skip auto-spawn and always connect to this URL. Used by the
   * `GROUP_CHAT_URL` env var to point at an externally-managed broker.
   */
  brokerUrlOverride?: string;
}

interface SessionState {
  room: string | null;
  peer: string | null;
}

const CONN_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
]);

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "fetch failed") return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause && typeof cause.code === "string" && CONN_ERROR_CODES.has(cause.code)) return true;
  return false;
}

export async function runMcpServer(opts: McpRuntimeOptions): Promise<void> {
  let brokerClient: BrokerClient | null = null;

  const getBroker = async (): Promise<BrokerClient> => {
    if (brokerClient) return brokerClient;
    const url =
      opts.brokerUrlOverride ??
      (await ensureBrokerRunning({ preferredPort: opts.preferredPort })).url;
    brokerClient = new BrokerClient(url);
    return brokerClient;
  };

  // Run a broker call. If it fails with a connection-class error (e.g. the
  // broker has grace-exited since we last spoke to it), discard the cached
  // client, re-run ensureBrokerRunning to spawn a fresh broker, and retry once.
  // Higher-level errors (BrokerError 404/409 etc.) propagate to the caller —
  // see withStateRecovery for room/peer-gone handling.
  const withBroker = async <T>(fn: (c: BrokerClient) => Promise<T>): Promise<T> => {
    const client = await getBroker();
    try {
      return await fn(client);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      brokerClient = null;
      const fresh = await getBroker();
      return fn(fresh);
    }
  };

  const state: SessionState = { room: null, peer: null };

  const server = new McpServer({
    name: "group-chat-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_rooms",
    {
      description:
        "List all active group-chat rooms with their current peers and recent activity. " +
        "Call this first if you don't already know which room to join.",
      inputSchema: {},
    },
    async () => {
      const rooms = await withBroker((c) => c.listRooms());
      if (rooms.length === 0) {
        return text("No rooms exist yet. Use join_room to create one.");
      }
      return text(
        rooms
          .map(
            (r) =>
              `- ${r.name} — peers: [${r.peers.join(", ")}], ` +
              `messages: ${r.message_count}, idle: ${r.idle_s}s`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "join_room",
    {
      description:
        "Join a group-chat room as the given peer name. Creates the room if it doesn't exist. " +
        "If your preferred name is taken, the broker assigns a numbered suffix (e.g. `frontend-2`). " +
        "Returns your assigned peer name — use this for all subsequent calls. " +
        "You will see only messages sent AFTER you join (cold join)." +
        "\n\n" +
        "After joining, IMMEDIATELY enter the receive loop: call `wait_for_message` and keep " +
        "responding to incoming messages, then calling `wait_for_message` again. Do not stop " +
        "after just joining — other peers (including the human) may be waiting to talk to you. " +
        "The loop ends naturally when `wait_for_message` returns with no new messages (timeout); " +
        "at that point, report back that the room has gone quiet.",
      inputSchema: {
        room: z.string().min(1).describe("Room name. Auto-created if missing."),
        as: z
          .string()
          .min(1)
          .describe(
            "Your preferred peer name, e.g. 'frontend' or 'backend'. Identify the repo or role.",
          ),
      },
    },
    async ({ room, as }) => {
      if (state.room) {
        return text(
          `Already joined room '${state.room}' as '${state.peer}'. ` +
            `Call leave_room first if you want to switch.`,
          true,
        );
      }
      const result = await withBroker((c) => c.joinRoom(room, as));
      state.room = result.room;
      state.peer = result.assigned_peer;
      const otherPeers = result.peers.filter((p) => p !== state.peer);
      const others =
        otherPeers.length > 0
          ? `Other peers in the room: ${otherPeers.join(", ")}.`
          : `You are the first peer in the room.`;
      return text(
        `Joined room '${result.room}' as '${result.assigned_peer}'. ${others}`,
      );
    },
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to your current room. All other peers (and the human watching the UI) " +
        "will see it. You will NOT see your own message echoed back. " +
        "\n\n" +
        "After sending, you should normally call `wait_for_message` to receive the reply, then " +
        "respond, and continue the loop until either the wait times out (signalling the " +
        "conversation has ended) or you decide there's nothing more to add. Do NOT stop after a " +
        "single send — the other peers expect dialogue.",
      inputSchema: {
        text: z.string().min(1).describe("Message text to broadcast."),
      },
    },
    async ({ text: body }) =>
      withStateRecovery(state, async () => {
        const r = await withBroker((c) =>
          c.sendMessage(state.room!, state.peer!, body),
        );
        return text(`Sent (id ${r.id} at ${r.at}).`);
      }),
  );

  server.registerTool(
    "wait_for_message",
    {
      description:
        "Block until a new message arrives from another peer in your current room, or until the " +
        "timeout elapses. Returns only messages you haven't seen before (cursor-based). " +
        "Returns immediately if there are already pending messages." +
        "\n\n" +
        "This is the second half of the conversation loop: send_message → wait_for_message → " +
        "respond → wait_for_message → repeat. If a call returns with no new messages (timed " +
        "out), treat that as the conversation reaching its natural end — STOP the loop, do not " +
        "call wait_for_message again hoping the other peer wakes up. Report back to the user " +
        "that the room has gone quiet.",
      inputSchema: {
        timeout_s: z
          .number()
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe("Max seconds to wait. Default 60, max 300."),
      },
    },
    async ({ timeout_s }) =>
      withStateRecovery(state, async () => {
        const result = await withBroker((c) =>
          c.waitForMessage(state.room!, state.peer!, timeout_s ?? 60),
        );
        return text(formatMessages(result.messages, result.timed_out));
      }),
  );

  server.registerTool(
    "get_last_message",
    {
      description:
        "Fetch the most recent N messages in your current room AND fast-forward your cursor past " +
        "them. Any unseen older messages will be skipped — use this when you want a quick catch-up " +
        "without inflating your context with the full history.",
      inputSchema: {
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many recent messages to fetch. Default 1, max 20."),
      },
    },
    async ({ count }) =>
      withStateRecovery(state, async () => {
        const result = await withBroker((c) =>
          c.getLastMessages(state.room!, state.peer!, count ?? 1),
        );
        return text(formatMessages(result.messages, false));
      }),
  );

  server.registerTool(
    "leave_room",
    {
      description:
        "Leave your current room. The room is destroyed once the last peer leaves. " +
        "Call this when you've finished collaborating.",
      inputSchema: {},
    },
    async () => {
      if (!state.room || !state.peer) {
        return text("Not currently in any room.", true);
      }
      const { room, peer } = state;
      state.room = null;
      state.peer = null;
      try {
        await withBroker((c) => c.leaveRoom(room, peer));
        return text(`Left room '${room}'.`);
      } catch (err) {
        if (err instanceof BrokerError && (err.statusCode === 404 || err.statusCode === 409)) {
          return text(`Room '${room}' no longer exists.`);
        }
        throw err;
      }
    },
  );

  // Best-effort leave on shutdown. Skip if we never connected — no need to
  // respawn a broker just to tell it we're going away.
  const cleanup = async () => {
    if (state.room && state.peer && brokerClient) {
      try {
        await brokerClient.leaveRoom(state.room, state.peer);
      } catch {
        // best effort
      }
      state.room = null;
      state.peer = null;
    }
  };

  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
}

function requireJoined(state: SessionState): void {
  if (!state.room || !state.peer) {
    throw new Error("You must call join_room before using this tool.");
  }
}

/**
 * Runs a broker call that requires room+peer state. If the broker reports the
 * room or peer is gone (the human deleted the room or kicked us), clear the
 * local state and surface a recoverable error so Claude can choose to rejoin.
 */
async function withStateRecovery(
  state: SessionState,
  fn: () => Promise<ReturnType<typeof text>>,
): Promise<ReturnType<typeof text>> {
  requireJoined(state);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BrokerError && (err.statusCode === 404 || err.statusCode === 409)) {
      const wasIn = `${state.peer} in '${state.room}'`;
      state.room = null;
      state.peer = null;
      return text(
        `You are no longer connected (${wasIn}). The room was deleted, you were kicked, ` +
          `or the broker restarted. Call join_room to rejoin if appropriate.`,
        true,
      );
    }
    throw err;
  }
}

function text(message: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: message }],
    ...(isError ? { isError: true } : {}),
  };
}

function formatMessages(messages: Message[], timedOut: boolean): string {
  if (messages.length === 0) {
    return timedOut ? "No new messages (timed out)." : "No new messages.";
  }
  return messages
    .map((m) => `[${m.at}] ${m.from}: ${m.text}`)
    .join("\n");
}
