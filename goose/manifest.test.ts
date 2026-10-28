import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { TOOL_NAMES } from "./text.ts";

/** Host name_to_key: alphanumerics plus -/_ preserved, whitespace removed, else _, lowercased. */
function hostNameToKey(name: string): string {
  let out = "";
  for (const ch of name) {
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-") {
      out += ch;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      continue;
    } else {
      out += "_";
    }
  }
  return out.toLowerCase();
}

describe("plugin manifest drift", () => {
  it("derives the host extkey from plugin.json plus .mcp.json", () => {
    const root = new URL("./", import.meta.url);
    const plugin = JSON.parse(fs.readFileSync(new URL("./plugin.json", root), "utf8")) as {
      name?: unknown;
    };
    assert.equal(typeof plugin.name, "string");
    const pluginName = plugin.name as string;
    const document = JSON.parse(fs.readFileSync(new URL("./.mcp.json", root), "utf8")) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
    };
    const servers = document.mcpServers;
    assert.ok(servers && typeof servers === "object");
    const names = Object.keys(servers);
    assert.deepEqual(names, ["auto-context-handover"]);
    const serverName = names[0] as string;
    // Release host extension name is plugin:server; extkey applies name_to_key.
    const extensionName = `${pluginName}:${serverName}`;
    assert.equal(extensionName, "auto-context-handover:auto-context-handover");
    const extkey = hostNameToKey(extensionName);
    assert.equal(extkey, "auto-context-handover_auto-context-handover");
    assert.equal(TOOL_NAMES.handover, `${extkey}__context_handover`);
    assert.equal(TOOL_NAMES.read, `${extkey}__read_handover`);
    const entry = servers[serverName] as { command?: unknown; args?: unknown };
    assert.equal(entry.command, "node");
    assert.ok(
      Array.isArray(entry.args) &&
        (entry.args as unknown[]).some((arg) => typeof arg === "string" && arg.includes("${PLUGIN_ROOT}/server.ts")),
      "server entry must reference ${PLUGIN_ROOT}/server.ts",
    );
  });

  it("hooks manifest parses with SessionStart/Stop entry paths", () => {
    const root = new URL("./", import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(new URL("./hooks/hooks.json", root), "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ type?: unknown; command?: unknown }> }>>;
    };
    assert.ok(manifest.hooks && typeof manifest.hooks === "object");
    for (const event of ["SessionStart", "Stop"] as const) {
      const groups: unknown = manifest.hooks?.[event];
      assert.ok(Array.isArray(groups) && groups.length > 0, event);
      const commands: string[] = [];
      const typedGroups = groups as Array<{ hooks?: Array<{ type?: unknown; command?: unknown }> }>;
      for (const group of typedGroups) {
        assert.ok(Array.isArray(group.hooks));
        const hooks = group.hooks as Array<{ type?: unknown; command?: unknown }>;
        for (const hook of hooks) {
          assert.equal(hook.type, "command");
          assert.equal(typeof hook.command, "string");
          commands.push(hook.command as string);
        }
      }
      assert.ok(
        commands.some((command) => command.includes("${PLUGIN_ROOT}/hook.ts")),
        `${event} must reference \${PLUGIN_ROOT}/hook.ts`,
      );
    }
  });
});
