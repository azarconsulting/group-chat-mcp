import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lockfilePath, readLockfile, removeLockfile } from "../src/shared/lockfile.js";

const COMPILED_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function log(label: string, ...rest: unknown[]) {
  console.log(`\n[${label}]`, ...rest);
}

async function newClient(label: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [COMPILED_CLI, "mcp"],
    stderr: "pipe",
  });
  const client = new Client({ name: `test-${label}`, version: "0.0.0" });
  transport.stderr?.on("data", (buf) => {
    process.stderr.write(`  [${label} stderr] ${buf}`);
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = (result.content as Array<{ type: string; text?: string }>) ?? [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

async function main() {
  // Clean any pre-existing state
  if (existsSync(lockfilePath())) {
    log("setup", "removing stale lockfile at", lockfilePath());
    removeLockfile();
  }
  assert(!existsSync(lockfilePath()), "lockfile should not exist at start");

  log("setup", "compiled cli:", COMPILED_CLI);
  assert(existsSync(COMPILED_CLI), "compiled cli missing — run `npm run build`");

  log("step", "spawning frontend MCP client (broker is lazy — should NOT exist yet)");
  const fe = await newClient("frontend");

  await sleep(300);
  assert(
    !existsSync(lockfilePath()),
    "broker should not be running before any tool call (lazy spawn)",
  );

  log("step", "listing tools from frontend client (must not spawn broker)");
  const tools = await fe.client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  log("check", "tools exposed:", toolNames.join(", "));
  assert.deepEqual(toolNames, [
    "get_last_message",
    "join_room",
    "leave_room",
    "list_rooms",
    "send_message",
    "wait_for_message",
  ]);
  assert(
    !existsSync(lockfilePath()),
    "listTools should not have spawned the broker",
  );

  log("step", "frontend lists rooms (first broker call — triggers lazy spawn)");
  let out = await callTool(fe.client, "list_rooms");
  log("output", out);
  assert.match(out, /No rooms/);

  await sleep(200);
  const lock = readLockfile();
  log("check", "lockfile after first tool call:", lock);
  assert(lock, "broker should be running after first broker call");
  assert(lock.port === 7531, `lockfile port should be 7531, got ${lock.port}`);

  log("step", "frontend joins room 'feature-x'");
  out = await callTool(fe.client, "join_room", { room: "feature-x", as: "frontend" });
  log("output", out);
  assert.match(out, /Joined room 'feature-x' as 'frontend'/);

  log("step", "spawning backend MCP client (should reuse running broker)");
  const be = await newClient("backend");
  await sleep(300);
  const lock2 = readLockfile();
  assert(lock2 && lock2.pid === lock.pid, "second MCP should reuse same broker pid");

  log("step", "backend lists rooms (should see feature-x)");
  out = await callTool(be.client, "list_rooms");
  log("output", out);
  assert.match(out, /feature-x/);

  log("step", "backend joins feature-x");
  out = await callTool(be.client, "join_room", { room: "feature-x", as: "backend" });
  log("output", out);
  assert.match(out, /Joined room 'feature-x' as 'backend'/);
  assert.match(out, /Other peers in the room: frontend/);

  log("step", "frontend sends message");
  out = await callTool(fe.client, "send_message", { text: "hello from frontend" });
  log("output", out);
  assert.match(out, /Sent \(id 1/);

  log("step", "backend waits for message (short timeout)");
  out = await callTool(be.client, "wait_for_message", { timeout_s: 2 });
  log("output", out);
  assert.match(out, /frontend: hello from frontend/);

  log("step", "long-poll: backend waits in background, frontend sends after delay");
  const waitPromise = callTool(be.client, "wait_for_message", { timeout_s: 5 });
  await sleep(500);
  out = await callTool(fe.client, "send_message", { text: "second message" });
  log("output", out);
  const waitResult = await waitPromise;
  log("output", waitResult);
  assert.match(waitResult, /frontend: second message/);

  log("step", "frontend should NOT see its own messages");
  out = await callTool(fe.client, "wait_for_message", { timeout_s: 1 });
  log("output", out);
  assert.match(out, /No new messages/);

  log("step", "backend leaves room");
  out = await callTool(be.client, "leave_room");
  log("output", out);
  assert.match(out, /Left room 'feature-x'/);

  log("step", "frontend leaves room");
  out = await callTool(fe.client, "leave_room");
  log("output", out);
  assert.match(out, /Left room 'feature-x'/);

  log("step", "killing broker mid-session to exercise lazy-respawn-on-connection-failure");
  const brokerPidBeforeKill = lock.pid;
  try {
    process.kill(brokerPidBeforeKill, "SIGTERM");
  } catch {
    // already gone
  }
  // Give the broker time to actually exit before the next fetch.
  await sleep(500);

  log("step", "next tool call should transparently respawn the broker");
  out = await callTool(fe.client, "list_rooms");
  log("output", out);
  assert.match(out, /No rooms/);
  await sleep(200);
  const lockAfter = readLockfile();
  assert(lockAfter, "broker should be running again after respawn");
  assert(
    lockAfter.pid !== brokerPidBeforeKill,
    `respawned broker should have a different pid (was ${brokerPidBeforeKill}, now ${lockAfter.pid})`,
  );

  log("step", "closing both clients");
  await fe.close();
  await be.close();

  log("check", "respawned broker should still be running during 30s grace period");
  await sleep(300);
  const lock3 = readLockfile();
  assert(lock3 && lock3.pid === lockAfter.pid, "broker should still be alive in grace period");

  log("cleanup", "killing broker pid", lock3.pid);
  try {
    process.kill(lock3.pid, "SIGTERM");
  } catch {
    // already gone
  }
  // Wait for lockfile cleanup
  for (let i = 0; i < 20; i++) {
    if (!existsSync(lockfilePath())) break;
    await sleep(100);
  }
  if (existsSync(lockfilePath())) removeLockfile();

  console.log("\n✓ all end-to-end checks passed");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("\n✗ test failed:", err);
  process.exit(1);
});
