import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isPidAlive,
  readLockfile,
  removeLockfile,
} from "../shared/lockfile.js";
import { BrokerClient } from "./client.js";

const DEFAULT_PORT = 7531;
const SPAWN_READY_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

export interface EnsureBrokerOptions {
  preferredPort: number;
}

export interface BrokerHandle {
  url: string;
  spawned: boolean;
}

/**
 * Ensures a broker is reachable and returns its base URL. Three outcomes:
 *  1. Lockfile present + healthy → reuse it.
 *  2. Lockfile present + stale (pid gone or unreachable) → remove and spawn.
 *  3. No lockfile → spawn on the preferred port.
 *
 * Auto-spawn requires the package to be built (`npm run build`). In dev, run
 * `npm run dev:serve` in a second terminal instead.
 */
export async function ensureBrokerRunning(
  opts: EnsureBrokerOptions,
): Promise<BrokerHandle> {
  const lock = readLockfile();
  if (lock) {
    const url = `http://127.0.0.1:${lock.port}`;
    const client = new BrokerClient(url);
    if (isPidAlive(lock.pid) && (await client.health())) {
      return { url, spawned: false };
    }
    removeLockfile();
  }

  const port = opts.preferredPort || DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;

  const cliPath = findCompiledCli();
  if (!cliPath) {
    throw new Error(
      `Broker not running and compiled binary not found at expected path. ` +
        `Either run \`npm run build\` first, or start the broker manually with ` +
        `\`npm run dev:serve\` in another terminal.`,
    );
  }

  const child = spawn(process.execPath, [cliPath, "serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ready = await waitForHealth(url, SPAWN_READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(
      `Spawned broker on port ${port} but it did not become healthy within ` +
        `${SPAWN_READY_TIMEOUT_MS}ms.`,
    );
  }
  return { url, spawned: true };
}

function findCompiledCli(): string | null {
  const compiled = fileURLToPath(new URL("../cli.js", import.meta.url));
  return existsSync(compiled) ? compiled : null;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const client = new BrokerClient(url);
  while (Date.now() < deadline) {
    if (await client.health()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
