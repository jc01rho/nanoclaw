#!/usr/bin/env bash
set -euo pipefail

# Register a Claude subscription OAuth token into the local `.env` file — the
# only auth path that needs a TTY break in the flow. Paste-based paths are
# handled in-process by setup/auto.ts.
#
# Flow:
#   1. Run `claude setup-token` under a PTY (via script(1)) so the browser
#      OAuth dance works and its token is captured into a tempfile.
#   2. Regex the sk-ant-oat…AA token out of the ANSI-stripped capture.
#   3. Write it to `.env` as `ANTHROPIC_AUTH_TOKEN`.

# Prefer bash 4+ (for `read -e -i` readline preload). macOS ships 3.2 in
# /bin/bash, but Homebrew users usually have 5.x first on PATH. The
# readline preload is optional — on 3.x we fall back to a plain prompt.

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found — installing it now (needed for subscription sign-in)…"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! bash "$SCRIPT_DIR/install-claude.sh"; then
    echo >&2
    echo "Couldn't install the Claude Code CLI automatically." >&2
    echo "Install it manually with" >&2
    echo "  curl -fsSL https://claude.ai/install.sh | bash" >&2
    echo "and re-run setup." >&2
    exit 1
  fi
  # install-claude.sh PATH additions are scoped to its own subshell; redo
  # them here so the rest of this script can see the fresh `claude` binary.
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
fi

command -v script >/dev/null \
  || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

cat <<'EOF'
A browser window will open for you to sign in with your Claude account.
When you finish, we'll save the token to your local .env automatically.

Press Enter to continue, or edit the command first.

EOF

cmd="claude setup-token"
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  # bash 4+: pre-fill the readline buffer so Enter literally submits.
  read -r -e -i "$cmd" -p "$ " cmd </dev/tty
else
  # bash 3.x (macOS default /bin/bash): no readline preload. Fall back.
  echo "$ $cmd"
  read -r -p "Press Enter to run, Ctrl-C to abort. " _ </dev/tty
fi

# `script` arg order differs between BSD (macOS) and util-linux.
if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "$cmd" "$tmpfile"
else
  # BSD script: command is argv after the file, so let it word-split.
  # shellcheck disable=SC2086
  script -q "$tmpfile" $cmd
fi

# Strip ANSI codes + newlines (TTY wraps the token mid-string), then match
# the sk-ant-oat…AA token. perl because BSD grep caps {n,m} at 255.
token=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpfile" \
        | tr -d '\n\r' \
        | perl -ne 'print "$1\n" while /(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g' \
        | tail -1 || true)

if [ -z "$token" ]; then
  keep=$(mktemp -t claude-setup-token-log.XXXXXX)
  cp "$tmpfile" "$keep"
  echo >&2
  echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
  exit 1
fi

echo
echo "Got token: ${token:0:16}…${token: -4}"
echo "Saving it to .env as ANTHROPIC_AUTH_TOKEN…"

env_file=".env"
tmp_env=$(mktemp -t nanoclaw-env.XXXXXX)
touch "$env_file"

updated=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^ANTHROPIC_AUTH_TOKEN= ]]; then
    printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "$token" >> "$tmp_env"
    updated=1
  else
    printf '%s\n' "$line" >> "$tmp_env"
  fi
done < "$env_file"

if [ "$updated" -eq 0 ]; then
  printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "$token" >> "$tmp_env"
fi

mv "$tmp_env" "$env_file"

echo "Done."
