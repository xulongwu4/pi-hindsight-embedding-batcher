import * as nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Private cache contract verified against @vectorize-io/hindsight-coding-agents 0.8.7.
// Load this entry point BEFORE Hindsight; the upstream hook still owns retrieval.
export function registerPromptInjection(pi, {
  cacheRoot = join(tmpdir(), 'hindsight-pi'),
  packageFile = join(homedir(), '.hindsight/coding-agents/package.json'),
  fs = nodeFs,
  warn = console.warn,
} = {}) {
  let warnedVersion = false;
  const warning = (ctx, message) => {
    try {
      if (ctx?.hasUI) ctx.ui.notify(message, 'warning');
      else warn(message);
    } catch {
      // A broken warning sink must not interrupt the user's prompt.
    }
  };

  pi.on('before_agent_start', (event, ctx) => {
    if (typeof event.prompt !== 'string' || !event.prompt.trim()) return;
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return;
    let supported = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      supported = pkg.name === '@vectorize-io/hindsight-coding-agents' && pkg.version === '0.8.7';
    } catch {
      // Missing or unreadable installation is also an unverified cache contract.
    }
    if (!supported) {
      if (!warnedVersion) {
        warnedVersion = true;
        warning(ctx, 'Hindsight prompt refresh skipped: installed package is not verified 0.8.7.');
      }
      return;
    }

    let temporary;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) {
        throw new Error('Unsafe session ID');
      }
      const directory = fs.lstatSync(cacheRoot, { throwIfNoEntry: false });
      if (!directory) return;
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe cache directory');
      const cacheFile = join(cacheRoot, `${sessionId}.json`);
      const original = fs.lstatSync(cacheFile, { throwIfNoEntry: false });
      if (!original) return;
      if (!original.isFile() || original.isSymbolicLink()) throw new Error('Unsafe cache file');
      const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
      const fd = fs.openSync(cacheFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let cache;
      try {
        if (!sameFile(original, fs.fstatSync(fd))) throw new Error('Cache changed');
        cache = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally {
        fs.closeSync(fd);
      }
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('Invalid cache');
      if (!Object.hasOwn(cache, 'reflectAnswer') && !Object.hasOwn(cache, 'reflectAttempts')) return;
      delete cache.reflectAnswer;
      delete cache.reflectAttempts;

      // Exclusive creation and rename keep readers from seeing partial JSON.
      const candidate = join(cacheRoot, `.${sessionId}.${randomUUID()}.tmp`);
      const out = fs.openSync(candidate, 'wx', 0o600);
      temporary = candidate;
      try {
        fs.writeFileSync(out, JSON.stringify(cache));
      } finally {
        fs.closeSync(out);
      }
      const currentDirectory = fs.lstatSync(cacheRoot);
      const current = fs.lstatSync(cacheFile);
      if (!currentDirectory.isDirectory() || currentDirectory.dev !== directory.dev
        || currentDirectory.ino !== directory.ino || !current.isFile() || !sameFile(original, current)) {
        throw new Error('Cache changed');
      }
      fs.renameSync(temporary, cacheFile);
      temporary = undefined;
    } catch {
      // Never include prompts, paths, cache contents, or exception messages.
      warning(ctx, 'Hindsight prompt refresh skipped: session cache could not be safely updated.');
    } finally {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* Best-effort cleanup after a failed write. */ }
      }
    }
  });
}
