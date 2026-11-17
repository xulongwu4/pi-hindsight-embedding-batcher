# Hindsight embedding batcher for Pi

A Pi extension package for fresh Hindsight memory retrieval and semantic relevance filtering. A separate local Gemini gateway rotates Google API keys for stored-text embeddings. The installed Hindsight coding-agent runtime is loaded unchanged, not vendored or patched.

## Requirements

- Node.js 24 or later and Pi.
- `@vectorize-io/hindsight-coding-agents` **0.8.7**, installed at `~/.hindsight/coding-agents`, with its normal server configuration.
- A working Hindsight API. The gateway expects it at `http://127.0.0.1:8888`.
- Pi Google credentials for `gemini-decision-1`; optionally a registered `startlux/startlux-decision-27b-autothink` classifier for fallback.
- The embedding gateway requires a Google key with access and available quota for `gemini-embedding-2`.

The cache adapter and injection parser depend on the verified Hindsight 0.8.7 format. A newer runtime needs compatibility testing. Unsupported versions do not receive ungated automatic injection.

## Install the Pi extension

```sh
pi install git:github.com/xulongwu4/pi-hindsight-embedding-batcher
```

This adds the Git source to Pi's `packages` settings. The package exposes one entrypoint, `index.ts`, which registers:

1. `prompt-injection.ts`: refresh the per-prompt retrieval cache.
2. `gated-hindsight.ts`: load Hindsight's original extension, filter automatic injection, and space out session retains.

Remove any direct registration of `~/.hindsight/coding-agents/dist/pi.js` or these individual component files. Registering them alongside the package can duplicate hooks and bypass filtering. Preserve unrelated extensions. Run `/reload` or restart Pi after changing registration.

Installing this package does **not** install the Hindsight API, its coding-agent runtime, or the gateway service.

## Memory behavior

Every nonempty `before_agent_start` prompt can trigger fresh upstream retrieval. The cache adapter removes only `reflectAnswer` and `reflectAttempts`; it preserves page rosters, turn counts, unknown fields, and cold-bank behavior. It rejects unsafe paths and malformed cache data. Retrieval still runs through the original Hindsight extension.

The wrapper filters memory before Pi persists it. Hindsight tools and other hooks remain upstream behavior. Accepted memory is visible in chat. Previously accepted history is not rewritten.

The semantic gate classifies whole original passages with native Google `gemini-decision-1`, then tries StartLux if Google fails. It does not rewrite facts. It requires relevance probability at least **0.5**, considers at most **20 candidates**, and retains at most **3 passages / 3,000 characters**, including framing. Rosters, no-history filler, unrelated passages, and instructions manipulating the gate are rejected. Structured passages stay whole rather than being truncated. Conservative filtering can reject useful facts; it is not a truth guarantee.

All Google attempts share a five-second deadline. StartLux has a separate five-second deadline. A valid low score is final, not a reason to seek another model's approval. Both providers failing suppresses the injection. Candidate passages and task context are sent to the selected classifier providers. Native Google calls are not included in Pi's classifier usage totals.

### Retention cadence

Hindsight's Pi extension retains the session after every agent run. The wrapper passes only every **10th** `agent_end` of a session to it (`RETAIN_EVERY` in `gated-hindsight.ts`). On `session_shutdown` (quit, reload, new, resume, fork) it passes the last skipped run first, then lets Hindsight's shutdown handler wait for that retain.

No turns are dropped: each retain reads the whole session branch and sends everything since the previous retain. If Pi is killed without a shutdown event, up to nine runs stay unretained until the session is resumed and retained again. Hindsight waits at most 10 seconds for the retain request at shutdown.

### Optional account pooling

The wrapper listens for `pi-multiprovider:service`. A compatible service with `runWithAccount` uses its existing scheduler, account policy, pins, affinity, and cooldowns. Retryable failures can select another eligible account; each account is tried at most once within the Google deadline.

The pooled request bridge is an additive API and may not be present in your installed pi-multiprovider release. An announcing service without this bridge, with unknown readiness, or with an exhausted pool falls back to StartLux rather than bypassing pool restrictions.

If no service has announced by the first prompt, the wrapper uses Pi's default Google credential. A later announcement takes precedence. **A plugin that fails before announcing can look absent and trigger this default-account fallback.** An explicit unpooled result also permits default credentials.

Pooling here applies to the relevance classifier, not the separate embedding gateway. Different API keys in the same Google project generally share quotas.

## Embedding gateway

The gateway uses the native Gemini API and preserves one input to one vector. Hindsight retains its native vector normalization. It supports only `gemini-embedding-2` with **768 dimensions**.

- Stored passages are forwarded to Google as they arrive. A request above **100 inputs** is split into consecutive requests and the vectors are returned in order.
- The gateway does not count tokens or check input size.
- An explicit five-minute bootstrap lease marks Hindsight's first successful single-input startup probe, which uses the reserved key.
- Stored-passage embeddings use the enabled Google API-key accounts in pi-multiprovider's `~/.local/share/pi/agent/multiprovider-auth.json`, in file order. The key in `credentials.env` is reserved for queries and the startup probe, so recall keeps working when stored passages exhaust their keys. Queries fall back to the pool keys when the reserved key is capped. If the pool file is missing or unreadable, every call uses the reserved key.
- On HTTP 429 the gateway reads the quota ID and retry delay from Google's error body, stops using that key until the reported time, and tries the next key. When every eligible key is capped it answers 429 without calling Google. Caps survive a gateway restart. Without a retry delay the block is one hour for a per-day quota and one minute otherwise. Other upstream errors do not change keys.

Upstream calls have a five-minute timeout. The gateway holds no work; embedding requests in flight fail when it stops.

The gateway does not count usage against a daily Google quota; it reacts when Google reports that one is exhausted. Other applications can share project limits.

`GET /health` lists each account label in `keys` with `blockedUntil`, the epoch time in milliseconds at which a capped key is used again. Logs have one line per upstream embedding attempt (`passage_batch` or `query_embed`) with the account label, HTTP status, input count and, on 429, `quotaId` and `blockedUntil`. Logs contain no memory text or credentials. Capped accounts are stored by account ID, not key, in `~/.local/state/pi-hindsight-embedding-batcher/quota.json`.

### Configure the services

The templates in `deploy/` assume a separate stable gateway checkout at `~/.local/share/pi-hindsight-embedding-batcher`. Clone this repository there, or adjust `WorkingDirectory`, `ExecStart`, and `ExecStartPre` to your checkout. Pi's managed package checkout and the gateway checkout may be different; update each deliberately.

Keep credentials outside the repository in private files under `~/.config/hindsight`:

- `credentials.env`: `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY`, the real Google key reserved for queries. It serves every call when no pool file is readable.
- `embedding-gateway.env`: three distinct random local values, `EMBEDDING_GATEWAY_TOKEN`, `EMBEDDING_GATEWAY_QUERY_TOKEN`, and `EMBEDDING_GATEWAY_PASSAGE_TOKEN`.
- In `embedding-gateway.env`, set `HINDSIGHT_API_QUERY_EMBEDDINGS_GEMINI_API_KEY` to the local query token and `HINDSIGHT_API_PASSAGE_EMBEDDINGS_GEMINI_API_KEY` to the local passage token.

Make the directory private and set both files to mode `0600`. Never use a real Google key as a local gateway token. The gateway replaces local tokens with the real key only for requests to Google's official endpoint.

The pool file is optional and belongs to pi-multiprovider. The gateway reads it at most once per minute, never writes it, and does not share cooldown state with Pi.

Configure Hindsight's Google embeddings for `gemini-embedding-2` and output dimensionality `768`. Install the gateway unit under your user systemd directory and the drop-in under `hindsight.service.d/`. The drop-in redirects Hindsight's native Google SDK to the loopback gateway and requests its startup bootstrap lease. Back up existing configuration and data first. Reload the user systemd manager, start the gateway, then restart Hindsight. Keep both services bound to loopback.

## Checks and rollback

```sh
npm test
```

Tests use synthetic inputs and mocked provider responses. Optional installed-runtime integration checks require the compatible local Hindsight installation. Tests do not need production API credentials.

To remove the Pi integration, remove this package from Pi settings and restore the original Hindsight entry if desired. To disable gateway routing, remove its Hindsight service drop-in, reload the user systemd manager, and restart Hindsight with valid direct Google credentials before stopping the gateway.

The gateway and extension are independent processes: reloading Pi does not restart either Hindsight or the gateway.
