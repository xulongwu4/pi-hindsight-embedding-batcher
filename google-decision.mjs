const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function classifyGoogleDecision(ctx, input, { signal, getPoolService } = {}) {
  try {
    signal?.throwIfAborted();
    if (!isObject(input) || !isObject(input.questions)) throw new Error('input');
    const state = JSON.stringify(input.state);
    if (typeof state !== 'string') throw new Error('input');
    const questions = Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      if (!isObject(question) || question.type !== 'bool' ||
          typeof question.instructions !== 'string') throw new Error('question');
      const native = { type: 'noul', instructions: question.instructions };
      if (question.criteria !== undefined) {
        if (!isObject(question.criteria) || typeof question.criteria.true !== 'string' ||
            typeof question.criteria.false !== 'string') throw new Error('criteria');
        native.criteria = {
          true_description: question.criteria.true,
          false_description: question.criteria.false,
        };
      }
      return [id, native];
    }));
    const body = JSON.stringify({ model: 'gemini-decision-1', input: state, questions });
    const request = async ({ auth, signal: attemptSignal }) => {
      signal?.throwIfAborted();
      attemptSignal?.throwIfAborted();
      const apiKey = auth?.apiKey;
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Google decision auth unavailable');
      let response;
      try {
        response = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: attemptSignal,
          redirect: 'error',
        });
      } catch {
        // The shared scheduler needs a safe failure kind, never raw transport errors.
        throw Object.assign(new Error('Google decision network request failed'), { code: 'NETWORK_ERROR' });
      }
      if (!response.ok) {
        const error = new Error('Google decision HTTP request failed');
        if (Number.isInteger(response.status)) error.status = response.status;
        const retryAfter = response.headers?.get('retry-after');
        if (typeof retryAfter === 'string' && retryAfter.length <= 64 &&
            (/^\d+$/.test(retryAfter) || /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter))) {
          error.headers = { 'retry-after': retryAfter };
        }
        throw error;
      }
      let result;
      try { result = await response.json(); }
      catch { throw new Error('Invalid Google decision response'); }
      signal?.throwIfAborted();
      attemptSignal?.throwIfAborted();
      if (!isObject(result) || !isObject(result.answers)) throw new Error('Invalid Google decision response');
      const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
        if (!isObject(answer) || answer.type !== 'noul' || !Number.isFinite(answer.noul) ||
            answer.noul < 0 || answer.noul > 1) throw new Error('Invalid Google decision response');
        // Confidence is certainty in either outcome, not the probability of true.
        return [id, { type: 'bool', probability: answer.noul }];
      }));
      for (const id of Object.keys(questions)) {
        if (!Object.hasOwn(answers, id)) throw new Error('Invalid Google decision response');
      }
      return { provider: 'google', model: 'gemini-decision-1', stopReason: 'stop', answers };
    };
    signal?.throwIfAborted();
    const service = getPoolService?.();
    const pooled = service?.hasPool?.('google');
    if (pooled !== false) {
      if (pooled !== true || typeof service?.runWithAccount !== 'function') throw new Error('pool unavailable');
      return await service.runWithAccount('google', ctx, {
        signal: signal ?? new AbortController().signal, modelId: 'gemini-decision-1',
      }, request);
    }
    // Only a confirmed unpooled provider may resolve ordinary Pi auth.
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider('google');
    return await request({ auth: { apiKey }, signal });
  } catch {
    // Do not expose credentials, prompts, response bodies, or upstream exceptions.
    throw new Error('Google decision classification failed');
  }
}
