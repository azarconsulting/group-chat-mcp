import { spawn } from "node:child_process";
import { removeLockfile, writeLockfile } from "../shared/lockfile.js";

export const EMPTY_GRACE_MS = 30_000;

export function installLockfile(pid: number, port: number): void {
  writeLockfile({ pid, port });

  const cleanup = () => {
    removeLockfile();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

export interface GraceExitOptions {
  graceMs?: number;
  onTimerStart?: (deadlineMs: number) => void;
  onTimerCancel?: () => void;
}

export function createGraceExit(opts: GraceExitOptions = {}): {
  onAllRoomsEmpty: () => void;
  cancel: () => void;
  getDeadline: () => number | null;
} {
  const graceMs = opts.graceMs ?? EMPTY_GRACE_MS;
  let timer: NodeJS.Timeout | null = null;
  let deadlineMs: number | null = null;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      deadlineMs = null;
      opts.onTimerCancel?.();
    }
  };
  const onAllRoomsEmpty = () => {
    if (timer) clearTimeout(timer); // restart without firing onTimerCancel
    deadlineMs = Date.now() + graceMs;
    opts.onTimerStart?.(deadlineMs);
    timer = setTimeout(() => {
      console.log(`broker idle for ${graceMs / 1000}s, exiting`);
      removeLockfile();
      process.exit(0);
    }, graceMs);
  };
  return {
    onAllRoomsEmpty,
    cancel,
    getDeadline: () => deadlineMs,
  };
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? { command: "cmd.exe", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { command: "open", args: [url] }
        : { command: "xdg-open", args: [url] };

  try {
    const child = spawn(cmd.command, cmd.args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best effort
  }
}
