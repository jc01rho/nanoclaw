# Running Agents on Local Ollama

NanoClaw agents can be routed to a local [Ollama](https://ollama.com) instance instead of the Anthropic API. This cuts API costs to zero and keeps all inference on your hardware.

## How It Works

Ollama exposes an Anthropic-compatible `/v1/messages` endpoint. The Claude Code CLI (which runs inside agent containers) uses the Anthropic SDK, which reads `ANTHROPIC_BASE_URL` to find the API host. Pointing that variable at Ollama is all that's needed — no new provider code, no changes to the agent runtime.

```
┌─────────────────────────────┐
│  Agent container            │
│                             │
│  Claude Code CLI            │
│    ↓ ANTHROPIC_BASE_URL     │
│    http://host.docker.      │      ┌──────────────────┐
│    internal:11434    ───────┼─────▶│  Ollama :11434   │
│                             │      │  gemma4:latest   │
└─────────────────────────────┘      └──────────────────┘
```

`host.docker.internal` is Docker's magic hostname that resolves to the host machine from inside a container — so Ollama running on your Mac or Linux box is reachable at that address.

## Direct endpoint routing

NanoClaw now calls Anthropic-compatible endpoints directly. For Ollama, point `ANTHROPIC_BASE_URL` at `http://host.docker.internal:11434` and ensure the container can resolve that host.

## Network Isolation

Setting `ANTHROPIC_BASE_URL` redirects requests but doesn't prevent a misconfigured agent from accidentally reaching `api.anthropic.com` directly. The `blockedHosts` field in `container.json` adds a Docker `--add-host` flag that resolves the domain to `0.0.0.0`, making it physically unreachable from inside the container:

```json
"blockedHosts": ["api.anthropic.com"]
```

With this in place, even if the model setting drifts back to a Claude model name, the API call will fail immediately rather than silently billing your account.

## Model Selection

The Claude Code CLI reads its model from `~/.claude/settings.json` inside the container, which NanoClaw bind-mounts from `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`. Set `"model": "gemma4:latest"` (or whatever Ollama model you've pulled) there. Use the exact name from `ollama list`.

Model selection considerations for Apple Silicon:

| Model | Size | Quality | Speed (M4 Pro) |
|-------|------|---------|----------------|
| `gemma4:latest` | 12B | Good general-purpose | Fast |
| `qwen3-coder:latest` | 32B | Excellent for coding tasks | Moderate |
| `llama3.2:latest` | 3B | Basic | Very fast |

The agent uses tool calls extensively (read/write files, shell commands). Models that support tool use reliably work best. Gemma 4 and Qwen 3 Coder both handle structured tool calls well.

## What Changes at the Code Level

Three files need to support this feature. See `/add-ollama-provider` for the exact changes.

**`src/container-config.ts`** — `ContainerConfig` interface needs `env` and `blockedHosts` fields so the per-group JSON can carry them.

**`src/container-runner.ts`** — At container spawn time, `env` entries become `-e KEY=VAL` Docker flags, and `blockedHosts` entries become `--add-host HOST:0.0.0.0` flags.

**`container/Dockerfile`** — The container runs as the host user's uid (e.g. 501 on macOS), not as the `node` user (uid 1000). The home directory must be `chmod 777` so any uid can write `~/.claude.json` and `~/.claude/settings.json`.

## Tradeoffs

| | Ollama (local) | Anthropic API |
|---|---|---|
| Cost | Free | Pay-per-token |
| Privacy | Fully local | Data sent to Anthropic |
| Model quality | Good (open-weight) | Excellent (Claude) |
| Cold start | 5–30s (model load) | ~1s |
| Context window | Varies by model | 200k tokens (Sonnet) |
| Tool use reliability | Good (large models) | Excellent |
| Hardware req. | 16GB+ RAM | None |

For personal automation on capable hardware, the tradeoff favors local. For complex multi-step tasks requiring large context or high reliability, Claude is still ahead.

## Reverting to Claude

Remove the `env` and `blockedHosts` keys from `groups/<folder>/container.json`, remove `"model"` from the shared settings file, and restart the service. No rebuild needed.

## See Also

- `/add-ollama-provider` — step-by-step skill to configure any agent group for Ollama
- [Ollama Anthropic compatibility docs](https://ollama.com/blog/openai-compatibility) — upstream docs on the API bridge
- `docs/architecture.md` — how the container spawn and env injection pipeline works
