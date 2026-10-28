# Amp adapter

Status (2026-10-29): focused-parentless advisory MVP with automatic fresh-root
attempt after model-authored storage and successful turn end. Offline loading
and fixtures are observed; authenticated routing, model compliance, UI following
and continuation are unverified. Native compaction is unchanged.

## Pins and primary sources

- [P] [Plugins](https://ampcode.com/docs/customize/plugins): TypeScript/default
  function, directory-plugin relative imports, discovery, lifecycle, user-content
  introduction, result replacement, create-and-append examples and subagents.
- [T] [Shipped declarations](https://unpkg.com/@ampcode/plugin@0.0.0-20261028101742-g93a0da1/index.d.ts):
  pinned `@ampcode/plugin@0.0.0-20261028101742-g93a0da1` (types-only package),
  `PluginThread`, `ThreadMessagesOptions`, `PluginToolContext`, event results,
  `Agent` and `CreateAgentThreadOptions`.
- [A] [Plugin API](https://ampcode.com/docs/plugin-api): Bun execution,
  thread-bound tools, shell runner, agent/thread handles and examples.
- [C] [CLI installation](https://ampcode.com/docs/cli),
  [installer](https://ampcode.com/install.sh) and observed release
  `0.0.1793203246-g5eab6d`. The native CLI is separate from the types package;
  installer honors AMP_VERSION. [Pinned download directory](https://static.ampcode.com/cli/0.0.1793203246-g5eab6d/).

## Capabilities and evidence

| Capability | Documented / shipped contract | Observed / unverified |
| --- | --- | --- |
| Measurement | Default messages() view includes latest compaction summary and post-cut messages; full:true adds discarded history. Pages max 20 with offset [T,A]. No usage/window getter established. | Adapter pages default view from start, estimates text/thinking/tool inputs/results chars/4. Missing current prompt/result included by host ids; duplicate/error/incomplete capped walk unknown. Images/system/schema/deferred overhead omitted; can undercount, not a lower bound or exact usage. Accuracy/cadence unverified. |
| Injection | agent.start.message appends after user content, hidden by default; tool.result may replace status/output [P,T]. | Introduction and string/text-block result notices fixture-covered, original status preserved. Unsupported outputs untouched; no system-priority claim. No per-request or compaction interception. |
| Tools / binding | registerTool JSON schemas; execute receives host PluginToolContext.thread and abort signal [T,A]. | Writer requires focused parentless caller, no authored caller id. Reader takes retained threadID, never a path. Offline default import registers both tools; in-session naming/exposure unverified. |
| Storage | Plugins run Bun with imports; ShellFunction available, no private KV store exposed [A,T]. | Node filesystem works in host offline load and real-filesystem fixtures. HOME hashed-id immutable body/claim, 0700/0600 new paths; no quotas/eviction/fsync. Same-user files not a sandbox. |
| Continuation | thread.agent() returns source Agent; createThread({show:true}) returns independent handle; omit parent for root. appendUserMessage sends work; show activates only supported clients [T,P]. Available in event/tool contexts, no command-only restriction established. | Successful agent.end attempts exclusive claim, create, record id, single full seed. Fixture-covered only: authenticated create/admission/UI following and exact model/settings preservation unverified. Never selects a built-in mode/model. |
| Subagents | parentThreadID direct linkage, null if no parent or deleted; agent.run supports parent and returns threadID/text [T,P]. | Known children/backgrounds excluded, no handback/replacement workflow. Focus + null parent is best-effort root attribution, not universal child detection. |
| Loading | Directory index.ts/default function and relative supporting files; plugins exec available in observed CLI help [P,C]. | Real bundled runtime loaded direct adapter and directory forwarder offline, throwing-plugin negative control failed as expected. Not actual lifecycle routing. Global listing/tool catalog require SaaS access/auth. |

## Behavior and limits

- Integer-only AUTO_CONTEXT_HANDOVER_SOFT default 150000, uncapped; no window
  contract/percent support. Invalid/empty explicit values log and disable notices,
  not tools. Shared soft/1.1/1.2 stages; native compaction can precede any notice.
- Storage follows HOME (`~/.amp/auto-context-handover/<sha256(thread-id)>/`),
  not XDG configuration. First successful verbatim body+summary wins atomically;
  claim is separately immutable. No TTL/quota/cleanup/deletion hook; interrupted
  writes may leave temps. Publication is not fsync crash durability.
- Automatic work requires a still-focused parentless source and done turn.
  Fresh root receives source backlink and full handover once with shared framing.
  No source lock/cancel, child automation, original-task capture or chain cap.
  Above-half-soft seed warnings advise later compression, never rewrite/gate.
- Claim precedes creation; successor id tracking precedes seeding. Diagnostics
  are separately nontransactional. Rejection/crash may leave unknown create or
  append admission; inspect existing threads/status before manual recovery.
  Never automatically retry; reload loses pending continuation. Any equipped
  caller can read any retained id; lost measurement remains unknown. Pagination
  across multiple calls is not a host snapshot and can race transcript changes.

## Non-model checks

`ISO`, `REPO`, `AMP` are required isolated directory, intact checkout and pinned
binary paths. Pre-create TMPDIR; a missing directory caused bundled keyring
loading to fail until created. No model session is needed for these checks:

```sh
: "${ISO:?}" "${REPO:?}" "${AMP:?}"
mkdir -p "$ISO/home/tmp" "$ISO/config/amp/plugins/auto-context-handover"
# Save this forwarding file, replacing the placeholder with REPO's absolute path:
# export { default } from "/absolute/path/to/auto-context-handover/amp/index.ts";
env -i PATH="$PATH" HOME="$ISO/home" TMPDIR="$ISO/home/tmp" \
  XDG_CONFIG_HOME="$ISO/config" XDG_DATA_HOME="$ISO/data" \
  XDG_CACHE_HOME="$ISO/cache" "$AMP" version
env -i PATH="$PATH" HOME="$ISO/home" TMPDIR="$ISO/home/tmp" \
  XDG_CONFIG_HOME="$ISO/config" XDG_DATA_HOME="$ISO/data" \
  XDG_CACHE_HOME="$ISO/cache" "$AMP" plugins exec \
  "$ISO/config/amp/plugins/auto-context-handover" session.start --data '{}'
```

- Installer, version, help and plugins show-docs succeeded; version pinned above.
  Real plugins exec direct/forwarded entry exited 0; throwing negative control
  exited 1 before readiness. Node default-factory fake API registered two tools
  and agent.start/tool.result/agent.end. These prove load, not event routing.
- plugins list failed loading global plugins without SaaS access; tools list
  entered device login and was stopped; show-agent-options refused missing key.
  No authentication or model requests were performed. End-to-end catalog,
  callback attribution and fresh-thread continuation require authenticated checks.
- [Completed verification counts and review resolutions](../changes/archive/amp-adapter.md).
