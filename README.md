# Hindsight embedding batcher for Pi

A Pi extension package for fresh Hindsight memory retrieval, semantic relevance filtering, and graceful embedding drains. A separate local Gemini gateway batches stored-text embeddings. The installed Hindsight coding-agent runtime is loaded unchanged, not vendored or patched.

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
2. `gated-hindsight.ts`: load Hindsight's original extension and filter automatic injection.
3. `extension.ts`: request a drain on graceful session shutdown.

Remove any direct registration of `~/.hindsight/coding-agents/dist/pi.js` or these individual component files. Registering them alongside the package can duplicate hooks and bypass filtering. Preserve unrelated extensions. Run `/reload` or restart Pi after changing registration.

Installing this package does **not** install the Hindsight API, its coding-agent runtime, or the gateway service.

## Memory behavior

Every nonempty `before_agent_start` prompt can trigger fresh upstream retrieval. The cache adapter removes only `reflectAnswer` and `reflectAttempts`; it preserves page rosters, turn counts, unknown fields, and cold-bank behavior. It rejects unsafe paths and malformed cache data. Retrieval still runs through the original Hindsight extension.

The wrapper filters memory before Pi persists it. Hindsight tools, retention, and other hooks remain upstream behavior. Accepted memory is visible in chat. Previously accepted history is not rewritten.

The semantic gate classifies whole original passages with native Google `gemini-decision-1`, then tries StartLux if Google fails. It does not rewrite facts. It requires relevance probability at least **0.9**, considers at most **20 candidates**, and retains at most **3 passages / 3,000 characters**, including framing. Rosters, no-history filler, unrelated passages, and instructions manipulating the gate are rejected. Structured passages stay whole rather than being truncated. Conservative filtering can reject useful facts; it is not a truth guarantee.

All Google attempts share a five-second deadline. StartLux has a separate five-second deadline. A valid low score is final, not a reason to seek another model's approval. Both providers failing suppresses the injection. Candidate passages and task context are sent to the selected classifier providers. Native Google calls are not included in Pi's classifier usage totals.

### Optional account pooling

The wrapper listens for `pi-multiprovider:service`. A compatible service with `runWithAccount` uses its existing scheduler, account policy, pins, affinity, and cooldowns. Retryable failures can select another eligible account; each account is tried at most once within the Google deadline.

The pooled request bridge is an additive API and may not be present in your installed pi-multiprovider release. An announcing service without this bridge, with unknown readiness, or with an exhausted pool falls back to StartLux rather than bypassing pool restrictions.

If no service has announced by the first prompt, the wrapper uses Pi's default Google credential. A later announcement takes precedence. **A plugin that fails before announcing can look absent and trigger this default-account fallback.** An explicit unpooled result also permits default credentials.

Pooling here applies to the relevance classifier, not the separate embedding gateway. Different API keys in the same Google project generally share quotas.

## Embedding gateway

The gateway uses the native Gemini API and preserves one input to one vector. Hindsight retains its native vector normalization. It supports only `gemini-embedding-2` with **768 dimensions**.

- Stored passages across banks share a FIFO queue.
- Each normal outbound attempt contains at most **28,000 actual embedding tokens** and **100 inputs**. Each input is counted with `countTokens` and must fit **8,192 tokens**.
- Normal attempts are separated by a conservative 60-second cooldown after completion. Small batches are allowed; a full 28K batch is not guaranteed.
- Query embeddings are immediate. An explicit five-minute bootstrap lease permits the first successful single-input startup probe.
- Graceful session shutdown requests a final drain. A `202` response means accepted, not completed. Drains bypass the normal cadence for at most five minutes while checking pending Hindsight operations and a quiet period.
- Observed passage failures make a drain fail rather than report false success. Drain completion means the queue and watched jobs are idle, not that every earlier extraction succeeded.

The last dispatch timestamp is persisted before sending. Failed attempts consume cadence, abandoned unsent work is removed, and responses retain input order across batches. Oversized inputs fail instead of being truncated or split into extra vectors. Upstream calls have a five-minute timeout. Queued synchronous requests are not durable across gateway crashes; accepted Hindsight jobs remain subject to Hindsight's own persistence and timeout behavior. Sustained backlog can still cause failures.

These controls do not enforce a daily Google quota. Queries and drains bypass normal cadence, and other applications can share project limits.

### Configure the services

The templates in `deploy/` assume a separate stable gateway checkout at `~/.local/share/pi-hindsight-embedding-batcher`. Clone this repository there, or adjust `WorkingDirectory`, `ExecStart`, and `ExecStartPre` to your checkout. Pi's managed package checkout and the gateway checkout may be different; update each deliberately.

Keep credentials outside the repository in private files under `~/.config/hindsight`:

- `credentials.env`: `HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY`, the real Google embedding key.
- `embedding-gateway.env`: three distinct random local values, `EMBEDDING_GATEWAY_TOKEN`, `EMBEDDING_GATEWAY_QUERY_TOKEN`, and `EMBEDDING_GATEWAY_PASSAGE_TOKEN`.
- In `embedding-gateway.env`, set `HINDSIGHT_API_QUERY_EMBEDDINGS_GEMINI_API_KEY` to the local query token and `HINDSIGHT_API_PASSAGE_EMBEDDINGS_GEMINI_API_KEY` to the local passage token.

Make the directory private and set both files to mode `0600`. Never use a real Google key as a local gateway token. The gateway replaces local tokens with the real key only for requests to Google's official endpoint.

Configure Hindsight's Google embeddings for `gemini-embedding-2` and output dimensionality `768`. Install the gateway unit under your user systemd directory and the drop-in under `hindsight.service.d/`. The drop-in redirects Hindsight's native Google SDK to the loopback gateway and requests its startup bootstrap lease. Back up existing configuration and data first. Reload the user systemd manager, start the gateway, then restart Hindsight. Keep both services bound to loopback.

The Pi drain hook reads the local control token from the private environment file. It does not copy or manage provider credentials. It waits at most two seconds for acknowledgement; the gateway owns subsequent draining. Forced termination cannot guarantee a shutdown hook.

## Checks and rollback

```sh
npm test
```

Tests use synthetic inputs and mocked provider responses. Optional installed-runtime integration checks require the compatible local Hindsight installation. Tests do not need production API credentials.

To remove the Pi integration, remove this package from Pi settings and restore the original Hindsight entry if desired. To disable gateway routing, remove its Hindsight service drop-in, reload the user systemd manager, and restart Hindsight with valid direct Google credentials before stopping the gateway. Do not stop it while queued work matters.

The gateway and extension are independent processes: reloading Pi does not restart either Hindsight or the gateway.
