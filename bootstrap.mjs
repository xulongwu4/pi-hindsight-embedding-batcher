// Invoked by Hindsight's ExecStartPre, after the gateway service starts.
const token = process.env.EMBEDDING_GATEWAY_TOKEN;
if (!token) throw new Error('Missing embedding gateway control token');
let acknowledged = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8890/control/bootstrap', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000), redirect: 'error',
    });
    if (response.status === 202 && (await response.json()).bootstrap === true) { acknowledged = true; break; }
  } catch { /* Gateway may still be starting. Never print credentials or response bodies. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!acknowledged) throw new Error('Embedding gateway bootstrap was not acknowledged');
