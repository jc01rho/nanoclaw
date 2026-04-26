---
name: use-native-credential-proxy
description: Configure direct `.env`-based credential management for Anthropic-compatible API calls. Reads API key or OAuth token from `.env` and injects them into container API requests.
---

# Use Direct Host Credentials

This skill configures NanoClaw to use direct host-managed credentials from `.env`. Containers get the needed API settings as environment variables — no external credential gateway needed.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/credential-proxy.ts` is imported in `src/index.ts`:

```bash
grep "credential-proxy" src/index.ts
```

If it shows an import for `startCredentialProxy`, the native proxy is already active. Skip to Phase 3 (Setup).

### Check if direct env config is already active

```bash
grep "ANTHROPIC_BASE_URL" .env
```

If direct env config is already present, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/native-credential-proxy
git merge upstream/skill/native-credential-proxy || {
  git checkout --theirs pnpm-lock.yaml
  git add pnpm-lock.yaml
  git merge --continue
}
```

This merges in:
- `src/credential-proxy.ts` and `src/credential-proxy.test.ts` (the proxy implementation)
- Restored credential proxy usage in `src/index.ts`, `src/container-runner.ts`, `src/container-runtime.ts`, `src/config.ts`
- Removed the old gateway dependency
- Restored `CREDENTIAL_PROXY_PORT` config (default 3001)
- Restored platform-aware proxy bind address detection
- Reverted setup skill to `.env`-based credential instructions

If the merge reports conflicts beyond `pnpm-lock.yaml`, resolve them by reading the conflicted files and understanding the intent of both sides.

### Update main group CLAUDE.md

Replace the old gateway auth reference with the direct `.env` path:

In `groups/main/CLAUDE.md`, replace:
> Credentials are managed from `.env` — see the runtime config files.

with:
> The native credential proxy manages credentials (including Anthropic auth) via `.env` — see `src/credential-proxy.ts`.

### Validate code changes

```bash
pnpm install
pnpm run build
pnpm exec vitest run src/credential-proxy.test.ts src/container-runner.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup Credentials

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, add it to `.env`:

```bash
# Add to .env (create file if needed)
echo 'CLAUDE_CODE_OAUTH_TOKEN=<token>' >> .env
```

Note: `ANTHROPIC_AUTH_TOKEN` is also supported as a fallback.

### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Add it to `.env`:

```bash
echo 'ANTHROPIC_API_KEY=<key>' >> .env
```

### After either path

**If the user's response happens to contain a token or key** (starts with `sk-ant-` or looks like a token): write it to `.env` on their behalf using the appropriate variable name.

**Optional:** If the user needs a custom API endpoint, they can add `ANTHROPIC_BASE_URL=<url>` to `.env` (defaults to `https://api.anthropic.com`).

## Phase 4: Verify

1. Rebuild and restart:

```bash
pnpm run build
```

Then restart the service:
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`
- WSL/manual: stop and re-run `bash start-nanoclaw.sh`

2. Check logs for successful proxy startup:

```bash
tail -20 logs/nanoclaw.log | grep "Credential proxy"
```

Expected: `Credential proxy started` with port and auth mode.

3. Send a test message in the registered chat to verify the agent responds.

4. Note: after applying this skill, `.env` is the credential source used by setup and runtime.

## Troubleshooting

**"Credential proxy upstream error" in logs:** Check that `.env` has a valid `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Verify the API is reachable: `curl -s https://api.anthropic.com/v1/messages -H "x-api-key: test" | head`.

**Port 3001 already in use:** Set `CREDENTIAL_PROXY_PORT=<other port>` in `.env` or as an environment variable.

**Container can't reach proxy (Linux):** The proxy binds to the `docker0` bridge IP by default. If that interface doesn't exist (e.g. rootless Docker), set `CREDENTIAL_PROXY_HOST=0.0.0.0` as an environment variable.

**OAuth token expired (401 errors):** Re-run `claude setup-token` in a terminal and update the token in `.env`.

## Removal

To revert to a different credential strategy:

1. Find the merge commit: `git log --oneline --merges -5`
2. Revert it: `git revert <merge-commit> -m 1` (undoes the skill branch merge, keeps your other changes)
3. `pnpm install`
4. `pnpm run build`
5. Reconfigure credentials for your chosen runtime path
6. Remove `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from `.env`
