#!/usr/bin/env bash
# Clone the work repos using the account from `gh auth login`. Safe to rerun:
# repos that already exist are skipped.
set -uo pipefail

REPOS_DIR="${REPOS_DIR:-/workspace/repos}"
# A GH_TOKEN env var overrides the gh login, and the runpod org rejects classic PATs.
unset GH_TOKEN
mkdir -p "$REPOS_DIR"

if ! gh auth status >/dev/null 2>&1; then
  echo "WARN: gh is not signed in. Run 'gh auth login', then: bash /workspace/claude-pod/pod/clone-repos.sh"
  exit 0
fi
gh auth setup-git

for repo in runpod/main-ui runpod/RunPod; do
  dest="$REPOS_DIR/$(basename "$repo")"
  if [ -d "$dest/.git" ]; then
    echo "ok: $repo already cloned"
    continue
  fi
  gh repo clone "$repo" "$dest" || echo "WARN: clone of $repo failed"
done
