import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPromptInjection } from './prompt-injection.mjs';

export default function (pi: ExtensionAPI) {
  registerPromptInjection(pi);
}
