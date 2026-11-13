import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import promptInjection from './prompt-injection.ts';
import gatedHindsight from './gated-hindsight.ts';

export default async function (pi: ExtensionAPI) {
  promptInjection(pi);
  await gatedHindsight(pi);
}
