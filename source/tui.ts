// TUI entrypoint (OpenCode resolves conventional root file names).
import { Plugin } from "@opencode/plugin/tui"
import { setupFollow } from "./tui-follow.ts"

export default Plugin.define({
  id: "auto-context-handover-tui",
  setup: (ctx) => setupFollow(ctx),
})
