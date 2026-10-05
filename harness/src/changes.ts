import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** "uncommitted": working tree vs HEAD. "branch": working tree vs where this branch forked from main. */
export type ChangeBase = "uncommitted" | "branch";

export type ChangedFile = { path: string; status: "A" | "M" | "D" | "R" | "T"; oldPath?: string };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function baseRef(cwd: string, base: ChangeBase): Promise<string> {
  if (base === "uncommitted") return "HEAD";
  for (const ref of ["origin/HEAD", "origin/main", "main"]) {
    try {
      return (await git(cwd, ["merge-base", "HEAD", ref])).trim();
    } catch {
      // Try the next candidate.
    }
  }
  return "HEAD";
}

export async function listChanges(cwd: string, base: ChangeBase) {
  const ref = await baseRef(cwd, base);
  // -z output: STATUS\0PATH\0, or for renames STATUS\0OLD\0NEW\0.
  const parts = (await git(cwd, ["diff", "--name-status", "-M", "-z", ref])).split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++][0] as ChangedFile["status"] | "C";
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      files.push(code === "R" ? { path: newPath, status: "R", oldPath } : { path: newPath, status: "A" });
    } else {
      files.push({ path: parts[i++], status: code === "T" ? "M" : code });
    }
  }
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const p of untracked) files.push({ path: p, status: "A" });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ref, files };
}

/** Reject absolute paths and anything that escapes the worktree. */
function safeRelative(cwd: string, file: string): string {
  if (!file || path.isAbsolute(file)) throw new Error("Invalid file path");
  const resolved = path.resolve(cwd, file);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) throw new Error("Invalid file path");
  return path.relative(cwd, resolved);
}

type Side = { text: string } | { binary: true } | { tooLarge: true };

function toSide(buf: Buffer): Side {
  if (buf.length > MAX_FILE_BYTES) return { tooLarge: true };
  if (buf.subarray(0, 8000).includes(0)) return { binary: true };
  return { text: buf.toString("utf8") };
}

export async function fileDiff(cwd: string, base: ChangeBase, file: string, oldPath?: string) {
  const rel = safeRelative(cwd, file);
  const relOld = oldPath ? safeRelative(cwd, oldPath) : rel;
  const ref = await baseRef(cwd, base);

  const original: Side = await run("git", ["show", `${ref}:${relOld}`], {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_FILE_BYTES + 1,
  })
    .then(({ stdout }) => toSide(stdout))
    .catch(() => ({ text: "" })); // Added file, or too large for the buffer.

  const modified: Side = await readFile(path.join(cwd, rel))
    .then(toSide)
    .catch(() => ({ text: "" })); // Deleted file.

  return { file: rel, oldPath: relOld !== rel ? relOld : undefined, ref, original, modified };
}
