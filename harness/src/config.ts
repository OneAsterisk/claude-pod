import path from "node:path";
import os from "node:os";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

const workspace = process.env.WORKSPACE_DIR ?? "/workspace";

export const config = {
  host: process.env.HARNESS_HOST ?? "0.0.0.0",
  port: Number(process.env.HARNESS_PORT ?? 7777),
  password: required("HARNESS_PASSWORD"),
  // Set by Runpod on every pod. Used to build proxy links.
  podId: process.env.RUNPOD_POD_ID ?? "",
  reposDir: process.env.REPOS_DIR ?? path.join(workspace, "repos"),
  worktreesDir: process.env.WORKTREES_DIR ?? path.join(workspace, "worktrees"),
  // A plain folder for sessions that are not about either repo (GitHub, Slack, Linear checks).
  generalDir: process.env.GENERAL_DIR ?? path.join(workspace, "general"),
  branchPrefix: process.env.BRANCH_PREFIX ?? "benpapp/",
  devPorts: (process.env.DEV_PORTS ?? "3000,3001,3002,3003,3004,3005")
    .split(",")
    .map((p) => Number(p.trim())),
  home: os.homedir(),
};

export function proxyUrl(port: number): string {
  return config.podId
    ? `https://${config.podId}-${port}.proxy.runpod.net`
    : `http://localhost:${port}`;
}
