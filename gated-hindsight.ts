import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gateHindsightResult } from './relevance-gate.mjs';

const RETAIN_EVERY = 10;

// The proxy intercepts registration only. Upstream retrieval, tools and shutdown
// still run unchanged; the gate sees the result before Pi persists it. Upstream
// retention sees every RETAIN_EVERY-th agent_end, plus the last skipped one at
// session_shutdown. It reads the whole session branch, so skipped runs are not lost.
export function registerGatedHindsight(pi: ExtensionAPI, upstream: (pi: ExtensionAPI) => unknown, version: string) {
  // This fallback is consumed only by before_agent_start, after startup. A failed
  // plugin load can look absent; any announcement (even unready) takes precedence.
  let poolService: unknown = { hasPool: () => false };
  pi.events.on('pi-multiprovider:service', value => { poolService = value; });
  const getPoolService = () => poolService;
  let runs = 0;
  let retain: ((...args: unknown[]) => unknown) | undefined;
  let skipped: { event: unknown } | undefined;
  const proxy = new Proxy(pi, {
    get(target, property) {
      if (property === 'on') {
        return (name: string, handler: (...args: unknown[]) => unknown) => {
          if (name === 'agent_end') {
            retain = handler;
            return target.on('agent_end', (event: unknown, ctx: unknown) => {
              if (++runs % RETAIN_EVERY) { skipped = { event }; return; }
              skipped = undefined;
              return handler(event, ctx);
            });
          }
          if (name === 'session_shutdown') {
            return target.on('session_shutdown', async (event: unknown, ctx: unknown) => {
              const last = skipped;
              skipped = undefined;
              let result;
              try {
                if (last) await retain?.(last.event, ctx);
              } finally {
                result = await handler(event, ctx);
              }
              return result;
            });
          }
          if (name !== 'before_agent_start') return Reflect.apply(target.on, target, [name, handler]);
          return target.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
            const result = await handler(event, ctx);
            return gateHindsightResult(result, event, ctx, version, { getPoolService });
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return upstream(proxy);
}

export default async function (pi: ExtensionAPI) {
  const root = join(homedir(), '.hindsight/coding-agents');
  let version = 'unknown';
  try {
    const installedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    if (typeof installedVersion === 'string') version = installedVersion;
  } catch { /* Keep upstream available, but reject automatic injection. */ }
  const upstream = await import(pathToFileURL(join(root, 'dist/pi.js')).href);
  await registerGatedHindsight(pi, upstream.default, version);
}
