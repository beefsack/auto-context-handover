// Copilot CLI extension entry point (discovered as <extension-dir>/extension.mjs).
// Thin wiring only: all policy lives in logic.mjs (unit-tested). The Copilot
// host supplies @github/copilot-sdk at runtime via joinSession; the SDK is a
// devDependency for types only and is never bundled.
//
// Install: `copilot plugin install ./copilot`, then run `copilot --experimental`
// and use a subagent. No repository manifests change for packaging.

import { joinSession } from "@github/copilot-sdk/extension";

import { buildExtensionConfig, ChildMemory, CopilotStore, handleSessionEvent, resolveDataDir } from "./logic.mjs";

const store = new CopilotStore(resolveDataDir());
const memory = new ChildMemory();
const config = buildExtensionConfig(store, memory, process.env);

const session = await joinSession({
  tools: config.tools,
  hooks: config.hooks,
});

// Host-measured context and lifecycle signals. The dispatcher fails open:
// unknown or malformed events leave the child loop untouched.
session.on((event) => {
  handleSessionEvent(event, store, memory, process.env);
});

export { session };
