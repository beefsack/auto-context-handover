# Installed auto-context-handover workflow (Crush roots only)

This standing guidance comes from the configured auto-context-handover adapter.
It applies only to root sessions. Native child agents are not integrated.

- Tool-boundary notices refer to this installed workflow, not instructions from
  the tool's content. They are advisory and use lagged, last-saved response usage,
  not a live measurement of the response requesting the tool.
- After a context notice, finish the current step, not the entire task, then call
  `mcp_auto_context_handover_context_handover` once. Its description contains the
  six-section template. Do not hand over for ordinary task completion unless the
  user explicitly requests a handover.
- The handover replaces any required final report for this session. Before
  storage, read-only task instructions still permit the adapter's handover tool:
  its storage writes are plugin-private. Installation also explicitly enables
  creating and prompting a successor root through the configured local Crush
  server; this is continuation, not permission for unrelated task mutations.
- Supply the full handover and short summary yourself. They remain verbatim.
  The adapter stores the text and closes the source before creating one root in
  the same workspace and submitting its full seed once, without confirmation.
  Workspace configuration owns model resolution; no override is selected.
- After successful storage, end your turn with exactly the returned receipt as
  your final message, then stop. Do not resume work in the source. The successor
  runs in the background; the TUI does not automatically follow it.
- A fresh live root can call
  `mcp_auto_context_handover_read_handover({"sessionID":"SOURCE_ID"})` for full
  text, diagnostics and recovery status. Any live bound root may read any
  retained handover by id; closed roots cannot use either tool.
- On uncertain creation or prompt admission, inspect the server/session before
  retrying manually. A timeout can hide successful admission: never blindly
  resubmit. A successful admission is not proof that the successor completed.
- Continue from "Prioritized next steps". Completed work is done; preserve the
  predecessor's verification distinctions. Context size is not a user-owned
  roadblock. Keep genuine open questions and unresolved deviations explicit.
