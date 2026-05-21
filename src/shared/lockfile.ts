import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LockfileData {
  pid: number;
  port: number;
  started_at: string;
}

export function lockfilePath(): string {
  return join(tmpdir(), "group-chat-mcp.lock");
}

export function readLockfile(): LockfileData | null {
  const path = lockfilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LockfileData;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.started_at === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeLockfile(data: Omit<LockfileData, "started_at">): void {
  const full: LockfileData = { ...data, started_at: new Date().toISOString() };
  writeFileSync(lockfilePath(), JSON.stringify(full), { encoding: "utf8" });
}

export function removeLockfile(): void {
  try {
    unlinkSync(lockfilePath());
  } catch {
    // already gone, ignore
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
