import { closeSync, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { hasCode } from "./integrity.js";

/**
 * fsync one closed file's contents. Renaming a file is atomic, but its bytes
 * are only guaranteed on media after fsync, so a rename that follows a write
 * is only as durable as that write. On macOS even fsync leaves the drive's
 * write cache unflushed; see syncDirectoryChain for the stated limit.
 */
export function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * fsync a directory and each of its ancestors, so a rename or a new shard
 * is flushed to the filesystem.
 *
 * Platform limits, stated honestly (ISSUE-324):
 * - Windows does not expose directory fsync through node:fs. The file fsync
 *   above is still mandatory there, and the refusals below are tolerated.
 * - On macOS, fsync does not flush the drive's write cache: only fcntl
 *   F_FULLFSYNC does, and node:fs exposes no fcntl. A rename synced here
 *   survives process death, but a power cut on macOS can still lose it.
 *   The zero-dependency rule keeps this a stated limit, not a native seam.
 * - On other POSIX platforms, directory fsync persists the rename.
 */
export function syncDirectoryChain(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    syncDirectory(current);
    if (dirname(current) === current) return;
  }
}

function syncDirectory(path: string): void {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) {
    if (process.platform === "win32" &&
        (hasCode(error, "EISDIR") || hasCode(error, "EPERM") || hasCode(error, "EACCES"))) return;
    throw error;
  }
  try { fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === "win32" &&
        (hasCode(error, "EINVAL") || hasCode(error, "EPERM") || hasCode(error, "EBADF")))) throw error;
  } finally { closeSync(fd); }
}
