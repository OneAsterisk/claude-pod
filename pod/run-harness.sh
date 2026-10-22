#!/usr/bin/env bash
# Starts the harness with the secret env files from the volume loaded. Run inside tmux by start.sh.
set -u
export HOME="${HOME:-/workspace/home}"
export PATH="$HOME/.local/bin:$PATH"
for f in "$HOME"/.config/claude-pod/*.env; do
  [ "$(basename "$f")" = watcher.env ] && continue   # the watcher reads this one itself on every poll
  [ -f "$f" ] && set -a && . "$f" && set +a
done
cd "$(dirname "$0")/../harness" || exit 1
exec mise exec -- npm start
