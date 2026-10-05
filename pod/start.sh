#!/usr/bin/env bash
# Runs on every pod boot (template start command). Idempotent, no prompts.
# Container disk is wiped on stop, so apt packages are reinstalled each boot.
# Everything under $HOME (/workspace/home) persists on the network volume.
set -euo pipefail

export HOME="${HOME:-/workspace/home}"
POD_REPO="/workspace/claude-pod"
REPOS_DIR="/workspace/repos"
LOG="/workspace/start.log"
mkdir -p "$HOME" "$REPOS_DIR" /workspace/worktrees
exec > >(tee -a "$LOG") 2>&1
echo "=== boot $(date -Is) ==="

# ---- System packages (every boot) ----
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git tmux cron jq curl unzip build-essential openssh-server ca-certificates gnupg >/dev/null

# Latest gh from GitHub's official apt repo.
if [ ! -f /etc/apt/sources.list.d/github-cli.list ]; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
fi
apt-get install -y -qq gh >/dev/null

# ---- User tooling under $HOME (first boot only) ----
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

if ! command -v mise >/dev/null; then
  curl -fsSL https://mise.run | sh
fi
mise use -g node@24 >/dev/null
mise exec -- corepack enable

if ! command -v claude >/dev/null; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

# Shell setup for SSH logins. Never set ANTHROPIC_API_KEY: it breaks
# Remote Control and claude.ai connectors (subscription login is used instead).
if ! grep -q "claude-pod" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'EOF'
# claude-pod
[ -f /etc/rp_environment ] && . /etc/rp_environment
export PATH="$HOME/.local/bin:$PATH"
eval "$(mise activate bash)"
cd /workspace
EOF
fi
# SSH logins read .bash_profile, not .bashrc.
[ -f "$HOME/.bash_profile" ] || echo '[ -f ~/.bashrc ] && . ~/.bashrc' > "$HOME/.bash_profile"

# ---- Claude config (first boot only; edit ~/.claude directly afterward) ----
if [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  mkdir -p "$HOME/.claude/commands"
  cp "$POD_REPO/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  cp "$POD_REPO/claude/settings.json" "$HOME/.claude/settings.json"
  cp "$POD_REPO"/claude/commands/*.md "$HOME/.claude/commands/"
  touch "$HOME/.claude/.i-have-adhd-always"
fi

# ---- Repos (first boot only) ----
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git || true
fi
for repo in runpod/main-ui runpod/RunPod; do
  dest="$REPOS_DIR/$(basename "$repo")"
  if [ ! -d "$dest/.git" ]; then
    gh repo clone "$repo" "$dest" || echo "WARN: clone of $repo failed. Run 'gh auth login', then rerun this script."
  fi
done

# ---- SSH ----
# Runpod injects PUBLIC_KEY with every SSH key on the account. On a shared
# account that includes teammates, so SSH_PUBLIC_KEY (set in the template)
# wins and becomes the only authorized key.
mkdir -p /root/.ssh "$HOME/.ssh"
AUTHORIZED_KEY="${SSH_PUBLIC_KEY:-${PUBLIC_KEY:-}}"
if [ -n "$AUTHORIZED_KEY" ]; then
  echo "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys
fi
# Persist host keys so the fingerprint does not change on every boot.
if [ -d "$HOME/.ssh/host_keys" ]; then
  cp "$HOME"/.ssh/host_keys/ssh_host_* /etc/ssh/
else
  ssh-keygen -A
  mkdir -p "$HOME/.ssh/host_keys" && cp /etc/ssh/ssh_host_* "$HOME/.ssh/host_keys/"
fi
# Point root's home at the volume so SSH sessions see the same ~/.claude.
# usermod refuses while root has running processes (this script), so edit passwd directly.
sed -i -E "s|^(root:[^:]*:0:0:[^:]*:)[^:]*:|\1$HOME:|" /etc/passwd
cp /root/.ssh/authorized_keys "$HOME/.ssh/authorized_keys" 2>/dev/null || true
chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh/authorized_keys" 2>/dev/null || true
# sshd does not pass the container env to logins, so save the template env
# (Runpod secrets included) for .bashrc to source.
export -p | grep -E ' (GH_TOKEN|HARNESS_PASSWORD|OP_SERVICE_ACCOUNT_TOKEN|RUNPOD_[A-Z_]+)=' > /etc/rp_environment || true
chmod 600 /etc/rp_environment
service ssh start || /usr/sbin/sshd

# ---- Cron (Slack digest) ----
crontab "$POD_REPO/pod/crontab"
service cron start || cron

# ---- Harness ----
cd "$POD_REPO/harness"
mise exec -- npm ci --silent
if ! tmux has-session -t harness 2>/dev/null; then
  tmux new-session -d -s harness \
    "cd '$POD_REPO/harness' && HOME='$HOME' mise exec -- npm start 2>&1 | tee -a /workspace/harness.log"
fi

echo "=== boot done $(date -Is) ==="
# Keep the container alive.
sleep infinity
