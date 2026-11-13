import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DRAIN_URL = 'http://127.0.0.1:8890/control/drain';
export const DRAIN_TIMEOUT_MS = 2000;
const tokenFile = join(homedir(), '.config/hindsight/embedding-gateway.env');

function failed(detail) {
  return {
    accepted: false,
    warning: `Embedding gateway drain not confirmed: ${detail}. Check the embedding gateway service and ~/.config/hindsight/embedding-gateway.env.`,
  };
}

/**
 * Only the acknowledgement is awaited. The gateway owns the drain after Pi exits.
 * @param {{readFile?: typeof readFile, fetch?: typeof globalThis.fetch}} [options]
 * @returns {Promise<{accepted: boolean, warning?: string}>}
 */
export async function requestDrain(options = {}) {
  const read = options.readFile ?? readFile;
  const send = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failed('request timed out after 2000 ms'));
    }, DRAIN_TIMEOUT_MS);
  });

  const request = async () => {
    let failure = 'could not read the gateway token file';
    try {
      const contents = await read(tokenFile, { encoding: 'utf8', signal: controller.signal });
      controller.signal.throwIfAborted();
      // Read only a literal dotenv assignment; never execute or expand shell content.
      const match = contents.match(/^\s*EMBEDDING_GATEWAY_TOKEN=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))[ \t]*\r?$/m);
      const token = match?.[1] ?? match?.[2] ?? match?.[3];
      if (!token || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) {
        return failed('gateway token is missing or invalid');
      }

      failure = 'could not reach the gateway';
      const response = await send(DRAIN_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 202) return failed(`HTTP ${response.status}`);
      failure = 'gateway returned an invalid drain acknowledgement';
      const body = await response.json();
      if (body?.draining !== true) return failed(failure);
      return { accepted: true };
    } catch {
      // Neither thrown errors nor response bodies are safe to log: they may echo auth.
      return failed(failure);
    }
  };

  try {
    // Bound the whole handshake, even if a dependency does not honor AbortSignal.
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort(); // Also close unread error bodies and timed-out requests.
  }
}

/**
 * Current Pi emits session_shutdown for quit, reload, new, resume, and fork.
 * Pi already maps graceful exit keys/SIGHUP/SIGTERM to that event. Do not add
 * process signal handlers or agent_end drains, or hook cancellable before events.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{readFile?: typeof readFile, fetch?: typeof globalThis.fetch, warn?: (message: string) => void}} [options]
 */
export function registerLifecycle(pi, options = {}) {
  const warn = options.warn ?? ((message) => console.error(message));
  let shutdown;
  pi.on('session_shutdown', async (_event, ctx) => {
    // One request per retiring runtime, including concurrent duplicate dispatch.
    shutdown ??= (async () => {
      const result = await requestDrain(options);
      if (result.warning) {
        // Keep a stderr warning because a terminal notification can vanish on exit.
        warn(result.warning);
        if (ctx.hasUI) ctx.ui.notify(result.warning, 'warning');
      }
    })();
    await shutdown;
  });
}
