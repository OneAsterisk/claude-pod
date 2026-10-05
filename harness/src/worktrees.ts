import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

const run = promisify(execFile);

// Untracked files that a fresh worktree needs to run (copied from the main checkout).
const COPY_INTO_WORKTREE = [".env", ".env.local", "console/.env.local"];

export type Worktree = { repo: string; path: string; branch: string | null; head: string; main: boolean };

export function listRepos(): { name: string; path: string }[] {
  if (!existsSync(config.reposDir)) return [];
  return readdirSync(config.reposDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(config.reposDir, d.name, ".git")))
    .map((d) => ({ name: d.name, path: path.join(config.reposDir, d.name) }));
}

export function repoPath(name: string): string {
  const repo = listRepos().find((r) => r.name === name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  return repo.path;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoPath(repo) });
  const out: Worktree[] = [];
  for (const block of stdout.trim().split("\n\n")) {
    const lines = block.split("\n");
    const get = (k: string) => lines.find((l) => l.startsWith(k + " "))?.slice(k.length + 1);
    const wtPath = get("worktree");
    if (!wtPath) continue;
    const branch = get("branch")?.replace("refs/heads/", "") ?? null;
    out.push({ repo, path: wtPath, branch, head: get("HEAD")?.slice(0, 8) ?? "", main: out.length === 0 });
  }
  return out;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$/;

export async function addWorktree(repo: string, name: string, base?: string): Promise<Worktree> {
  if (!NAME_RE.test(name)) throw new Error("Worktree name: letters, digits, . _ - only (max 61 chars)");
  const root = repoPath(repo);
  const dest = path.join(config.worktreesDir, repo, name);
  mkdirSync(path.dirname(dest), { recursive: true });
  const branch = `${config.branchPrefix}${name}`;
  await run("git", ["fetch", "origin", "--quiet"], { cwd: root }).catch(() => {});
  const hasOriginHead = await run("git", ["rev-parse", "--verify", "--quiet", "origin/HEAD"], { cwd: root })
    .then(() => true)
    .catch(() => false);
  const args = ["worktree", "add", dest, "-b", branch];
  args.push(base && base.trim() ? base.trim() : hasOriginHead ? "origin/HEAD" : "HEAD");
  await run("git", args, { cwd: root });
  for (const rel of COPY_INTO_WORKTREE) {
    const src = path.join(root, rel);
    const dst = path.join(dest, rel);
    if (existsSync(src) && !existsSync(dst)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  return { repo, path: dest, branch, head: "", main: false };
}

export async function removeWorktree(repo: string, wtPath: string, force: boolean): Promise<void> {
  const wts = await listWorktrees(repo);
  const target = wts.find((w) => w.path === wtPath);
  if (!target) throw new Error("Not a worktree of this repo");
  if (target.main) throw new Error("Refusing to remove the main checkout");
  const args = ["worktree", "remove", wtPath];
  if (force) args.push("--force");
  await run("git", args, { cwd: repoPath(repo) });
}

/** Every directory a session may run in: the General folder, main checkouts, and their worktrees. */
export async function allowedCwds(): Promise<Set<string>> {
  const set = new Set<string>([config.generalDir]);
  for (const r of listRepos()) {
    for (const w of await listWorktrees(r.name).catch(() => [])) set.add(w.path);
  }
  return set;
}
