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
  // PR review watcher (Slack DMs + GitHub pushes). See README "Watcher".
  watcher: {
    enabled: process.env.WATCHER_ENABLED !== "0",
    dryRun: process.env.WATCHER_DRY_RUN === "1",
    slackIntervalMs: Number(process.env.WATCHER_SLACK_INTERVAL_MS ?? 60_000),
    githubIntervalMs: Number(process.env.WATCHER_GITHUB_INTERVAL_MS ?? 300_000),
    allowedOwners: (process.env.WATCHER_ALLOWED_OWNERS ?? "runpod").split(",").map((o) => o.trim().toLowerCase()).filter(Boolean),
    allowedSlackUsers: (process.env.WATCHER_SLACK_USERS ?? "U0BS304GAN6").split(",").map((u) => u.trim()).filter(Boolean),
    maxConcurrent: Number(process.env.WATCHER_MAX_CONCURRENT ?? 2),
    maxReviewsPerDay: Number(process.env.WATCHER_MAX_PER_DAY ?? 30),
    // A review is done only when the GitHub review exists at the PR head. These bound the wait.
    maxReviewMinutes: Number(process.env.WATCHER_MAX_REVIEW_MINUTES ?? 60),
    idleNudgeMinutes: Number(process.env.WATCHER_IDLE_NUDGE_MINUTES ?? 8),
    stateFile: process.env.WATCHER_STATE_FILE ?? path.join(workspace, "watcher", "state.json"),
    // SLACK_USER_TOKEN=xoxp-... lives here (chmod 600) when not set in the environment.
    envFile: process.env.WATCHER_ENV_FILE ?? path.join(os.homedir(), ".config", "claude-pod", "watcher.env"),
  },
};

export function proxyUrl(port: number): string {
  return config.podId
    ? `https://${config.podId}-${port}.proxy.runpod.net`
    : `http://localhost:${port}`;
}
