// pi-multiprovider's auth file. Only enabled Google API-key accounts are usable here.
export function parsePool(text) {
  const accounts = JSON.parse(text)?.providers?.google?.accounts;
  if (!Array.isArray(accounts)) throw new Error('No Google accounts in pool file');
  return accounts
    .filter(a => a?.enabled !== false && a?.credential?.type === 'api_key' &&
      typeof a.credential.key === 'string' && a.credential.key && typeof a.id === 'string' && a.id)
    .map(a => ({ id: a.id, label: typeof a.label === 'string' && a.label ? a.label : a.id, key: a.credential.key }));
}

// Google reports the violated quota and the wait in the 429 body, not in a header.
export function quotaFailure(text) {
  let details;
  try { details = JSON.parse(text)?.error?.details; } catch { /* Not JSON: use the defaults. */ }
  if (!Array.isArray(details)) details = [];
  const quotaId = details.flatMap(d => Array.isArray(d?.violations) ? d.violations : [])
    .map(v => v?.quotaId).find(q => typeof q === 'string')?.slice(0, 120) ?? null;
  const seconds = details.map(d => /^(\d+(?:\.\d+)?)s$/.exec(d?.retryDelay)?.[1]).find(Boolean);
  const fallback = quotaId?.includes('PerDay') ? 3600000 : 60000;
  return { quotaId, blockMs: seconds ? Math.min(86400000, Math.ceil(seconds * 1000)) : fallback };
}
