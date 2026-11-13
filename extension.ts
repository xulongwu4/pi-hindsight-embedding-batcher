import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerLifecycle } from './lifecycle.mjs';

export default function (pi: ExtensionAPI) {
  registerLifecycle(pi);
}
