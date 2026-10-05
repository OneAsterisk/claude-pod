# claude-pod

A Runpod CPU pod running Claude Code for `runpod/main-ui` and `runpod/RunPod`. It includes a password-protected web harness for listing, viewing, and starting sessions.

| Path | What it is |
|---|---|
| `pod/start.sh` | Boot script (template start command). Idempotent, no prompts |
| `pod/crontab` | Weekday Slack digest of Linear tickets |
| `claude/` | Copied into `~/.claude` on first boot: `CLAUDE.md`, `settings.json`, `commands/` |
| `harness/` | Web harness (Hono + Agent SDK, plain HTML/JS) |

Persistence: the template sets `HOME=/workspace/home`, which lives on the network volume. `~/.claude`, `~/.claude.json`, connector auth, gh config, mise, Node, and SSH keys survive restarts. The container disk does not, so `start.sh` reinstalls apt packages on every boot (about 1 to 2 min).

## 1. Runpod setup

### Secrets (Console → Secrets)

| Secret | Required | Used for |
|---|---|---|
| `HARNESS_PASSWORD` | yes | Harness login |
| `GH_TOKEN` | yes | Cloning this repo and the work repos on boot. Scopes: `repo`, `read:org`, `admin:ssh_signing_key` |
| `OP_SERVICE_ACCOUNT_TOKEN` | no | fnox / 1Password for RunPod SST dev |

Do **not** add `ANTHROPIC_API_KEY`. It switches Claude to API-key auth, which breaks Remote Control and the claude.ai Slack connector.

### Network volume

100 GB in a datacenter with `cpu3g` stock (for example `US-KS-2`). About $7/month.

### Template

- Image: `runpod/base:1.0.2-ubuntu2404`
- Container disk: 30 GB
- Volume mount path: `/workspace`
- Expose TCP ports: `22`
- Expose HTTP ports: `7777,3000,3001,3002,3003,3004,3005,6006`
- Environment variables:
  ```
  HOME=/workspace/home
  SSH_PUBLIC_KEY=<your ~/.ssh/id_ed25519.pub>
  HARNESS_PASSWORD={{ RUNPOD_SECRET_HARNESS_PASSWORD }}
  GH_TOKEN={{ RUNPOD_SECRET_GH_TOKEN }}
  OP_SERVICE_ACCOUNT_TOKEN={{ RUNPOD_SECRET_OP_SERVICE_ACCOUNT_TOKEN }}
  ```
- Start command:
  ```
  bash -c 'export HOME=/workspace/home; [ -d /workspace/claude-pod/.git ] || { git clone https://x-access-token:$GH_TOKEN@github.com/OneAsterisk/claude-pod.git /workspace/claude-pod && git -C /workspace/claude-pod remote set-url origin https://github.com/OneAsterisk/claude-pod.git; }; exec bash /workspace/claude-pod/pod/start.sh'
  ```

### Pod

CPU pod, `cpu3g` (General Purpose), 16 vCPU / 64 GB ($0.64/hr), in `US-KS-2`. Attach the network volume.

The Runpod account is shared, so `SSH_PUBLIC_KEY` matters: `start.sh` makes it the only authorized key. Without it, every SSH key on the account could log in.

Boot log: `/workspace/start.log`. Harness log: `/workspace/harness.log`.

## 2. First run (once, over SSH, about 20 to 30 min)

SSH in using the pod's **Connect** menu (use the "SSH over exposed TCP" command for scp support).

1. Sign in to Claude with your subscription:
   ```bash
   claude auth login
   ```
2. Accept Remote Control once (Ctrl+C after it starts):
   ```bash
   claude remote-control
   ```
3. Install plugins. In `claude`, run `/plugin` and install `posthog` and `i-have-adhd`. The marketplaces are already in `settings.json`.
4. Add connectors:
   ```bash
   claude mcp add --transport http runpod -s user https://mcp.getrunpod.io/
   ```
   ```bash
   claude mcp add --transport http runpod-docs -s user https://docs.runpod.io/mcp
   ```
   ```bash
   claude mcp add --transport http linear-server -s user https://mcp.linear.app/mcp
   ```
   Also add `context`, `vercel`, and `courier` the same way, with the URLs from your local `~/.claude.json`. Then run `/mcp` inside `claude` to sign in to each one. If an OAuth redirect to `localhost:<port>` fails in your browser, reconnect SSH with `-L <port>:localhost:<port>` and retry.
5. Check that Slack appears in `/mcp` (claude.ai connector). Note its tool prefix. If it isn't `mcp__claude_ai_Slack__`, update `--allowedTools` in `pod/crontab`.
6. Set up commit signing (your CLAUDE.md requires `-S`):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
   ```
   ```bash
   gh ssh-key add ~/.ssh/id_ed25519.pub --type signing --title runpod-claude-pod
   ```
   ```bash
   git config --global gpg.format ssh && git config --global user.signingkey ~/.ssh/id_ed25519.pub && git config --global commit.gpgsign true
   ```
   ```bash
   git config --global user.name "Ben Papp" && git config --global user.email ben.papp@runpod.io
   ```
7. Install deps. main-ui:
   ```bash
   cd /workspace/repos/main-ui/console && yarn install
   ```
   RunPod (Node 22 via its own mise config, SST dev against AWS):
   ```bash
   cd /workspace/repos/RunPod && make setup && yarn install
   ```
   ```bash
   aws sso login --use-device-code
   ```
8. From your Mac, copy main-ui's env file:
   ```bash
   scp -P <port> ~/repos/main-ui/console/.env.local root@<ip>:/workspace/repos/main-ui/console/.env.local
   ```
   New worktrees copy `.env`, `.env.local`, and `console/.env.local` from the main checkout automatically.

## 3. Daily use

| Task | How |
|---|---|
| Web harness | `https://<podId>-7777.proxy.runpod.net` |
| Drive sessions from claude.ai/code, desktop, or phone | SSH in, then `tmux new -s rc -c /workspace/repos/main-ui 'claude remote-control --spawn worktree'` |
| Preview a worktree's UI | Harness → Worktrees → Start dev server → Open (`https://<podId>-300N.proxy.runpod.net`) |
| Slack DM of Linear tickets | `/dm-tickets assigned to me, In Review` in any session |
| Change the digest | Edit `pod/crontab`, then `crontab /workspace/claude-pod/pod/crontab` |
| Restart the harness | `tmux kill-session -t harness`, then rerun the last block of `pod/start.sh` or reboot |

### Harness features

- **Sessions**: every Claude transcript on the pod (harness, CLI, or Remote Control), with title, repo, branch, last activity, and live status. Filter by repo.
- **Thread view**: messages, collapsed tool calls and results. Sessions the harness is running stream live.
- **New session**: pick a checkout or create a worktree (`/workspace/worktrees/<repo>/<name>` on branch `benpapp/<name>`), a permission mode, and a prompt.
- **Follow-ups**: send messages to any session. Sessions not running get resumed. Interrupt, stop, rename.
- **Approvals**: in `default`/`acceptEdits` mode, tool permission prompts show up with Allow / Deny.
- **Worktrees**: add, remove (confirms first), start/stop a dev server on ports 3000-3005 with proxy link and log.

## 4. Known risks

| Risk | Fallback |
|---|---|
| Next 16 blocks dev requests or HMR from `*.proxy.runpod.net` | Add `allowedDevOrigins: ['*.proxy.runpod.net']` to main-ui `next.config.mjs` locally (don't commit), or `ssh -L 3000:localhost:3000` |
| Clerk dev keys reject the proxy domain | SSH tunnel to localhost |
| Slack connector not loaded in `claude -p` (cron) | Check `/workspace/dm-tickets.log`. Fall back to a Slack token + `chat.postMessage` script |
| Remote Control disabled for the Runpod org | Use the harness only |
| Proxy URLs are public | The harness requires the password. Dev server ports (3000-3005) have no auth; stop them when you're done |

## Local development (Mac)

`harness/.dev.env` (gitignored) holds a local test password and points `WORKSPACE_DIR` at a throwaway folder.

```bash
cd harness && npx tsx --env-file=.dev.env src/server.ts
```

Typecheck:

```bash
cd harness && npx tsc --noEmit
```
