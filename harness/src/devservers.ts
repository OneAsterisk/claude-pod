import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, proxyUrl } from "./config.ts";

type DevServer = { cwd: string; port: number; proc: ChildProcess; log: string[]; startedAt: number };

const servers = new Map<string, DevServer>(); // keyed by worktree path
const MAX_LOG_LINES = 200;

/** main-ui keeps the Next app in console/. Fall back to the worktree root. */
function appDir(worktree: string): string {
  const consoleDir = path.join(worktree, "console");
  return existsSync(path.join(consoleDir, "package.json")) ? consoleDir : worktree;
}

/** Read one KEY=value from a dotenv file. Handles `export KEY=` and quoted values. */
function readEnvValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m?.[1] !== key) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    return value || undefined;
  }
  return undefined;
}

function freePort(): number {
  const used = new Set([...servers.values()].map((s) => s.port));
  const port = config.devPorts.find((p) => !used.has(p));
  if (!port) throw new Error(`All dev ports in use (${config.devPorts.join(", ")})`);
  return port;
}

export function startDevServer(worktree: string): { port: number; url: string } {
  const existing = servers.get(worktree);
  if (existing) return { port: existing.port, url: proxyUrl(existing.port) };

  const cwd = appDir(worktree);
  if (!existsSync(path.join(cwd, "package.json"))) throw new Error("No package.json in worktree");
  const port = freePort();
  // Port is a number from config, so nothing user-supplied reaches the shell.
  const script = `[ -d node_modules ] || yarn install; exec yarn dev -p ${port}`;
  // main-ui's private @runpod/* packages need NPM_TOKEN for yarn install. The
  // harness env does not carry it, but each worktree gets a copy of .env.local.
  const npmToken = process.env.NPM_TOKEN ?? readEnvValue(path.join(cwd, ".env.local"), "NPM_TOKEN");
  const env = { ...process.env, PORT: String(port), ...(npmToken ? { NPM_TOKEN: npmToken } : {}) };
  const proc = spawn("bash", ["-lc", script], { cwd, detached: true, env });
  const server: DevServer = { cwd: worktree, port, proc, log: [], startedAt: Date.now() };
  const onData = (buf: Buffer) => {
    server.log.push(...buf.toString().split("\n").filter(Boolean));
    if (server.log.length > MAX_LOG_LINES) server.log.splice(0, server.log.length - MAX_LOG_LINES);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    server.log.push(`[exited with code ${code}]`);
    if (servers.get(worktree) === server) servers.delete(worktree);
  });
  servers.set(worktree, server);
  return { port, url: proxyUrl(port) };
}

export function stopDevServer(worktree: string): boolean {
  const s = servers.get(worktree);
  if (!s || s.proc.pid === undefined) return false;
  try {
    process.kill(-s.proc.pid, "SIGTERM"); // whole process group: bash, yarn, next
  } catch {
    s.proc.kill("SIGTERM");
  }
  servers.delete(worktree);
  return true;
}

export function devServerStatus(worktree: string) {
  const s = servers.get(worktree);
  return s ? { port: s.port, url: proxyUrl(s.port), startedAt: s.startedAt, log: s.log } : null;
}

export function stopAll() {
  for (const wt of [...servers.keys()]) stopDevServer(wt);
}
