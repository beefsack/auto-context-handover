import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CrushApiError, CrushHttpClient } from "./client.ts";

interface Fixture {
  readonly socketPath: string;
  readonly state: {
    version: unknown;
    workspaces: unknown;
    session: unknown;
    agent: unknown;
    createdSessions: Array<{ title: unknown }>;
    createdParent: string;
    agentPosts: number;
    lastAgentBody: unknown;
    agentStatus: number;
    delayMs: number;
  };
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crush-fx-"));
  const socketPath = path.join(dir, "crush.sock");
  const state: Fixture["state"] = {
    version: { version: "v0.98.2" },
    workspaces: [{ id: "ws-1", path: dir }],
    session: { id: "ses-1", parent_session_id: "", prompt_tokens: 100, completion_tokens: 50 },
    agent: { model: { id: "m1", context_window: 200000 }, model_cfg: { provider: "p", model: "m" }, is_ready: true },
    createdSessions: [],
    createdParent: "",
    agentPosts: 0,
    lastAgentBody: undefined,
    agentStatus: 500,
    delayMs: 0,
  };
  const server = http.createServer((req, res) => {
    const respond = (): void => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/v1/version") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.version));
      } else if (req.method === "GET" && url === "/v1/workspaces") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.workspaces));
      } else if (req.method === "GET" && url === "/v1/workspaces/ws-1/sessions/ses-1") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.session));
      } else if (req.method === "GET" && url === "/v1/workspaces/ws-1/agent") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.agent));
      } else if (req.method === "POST" && url === "/v1/workspaces/ws-1/sessions") {
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk));
        req.on("end", () => {
          state.createdSessions.push(JSON.parse(raw) as { title: unknown });
          const n = state.createdSessions.length;
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ id: `ses-new-${n}`, parent_session_id: state.createdParent, title: (state.createdSessions[n - 1] as { title: unknown }).title }),
          );
        });
        return;
      } else if (req.method === "POST" && url === "/v1/workspaces/ws-1/agent") {
        // Fake HTTP allowed for sendAgentPrompt shape/status/timeout coverage;
        // real prompt admission against a user socket is never exercised here.
        let raw = "";
        req.on("data", (chunk: Buffer) => (raw += chunk));
        req.on("end", () => {
          try {
            state.lastAgentBody = JSON.parse(raw);
          } catch {
            state.lastAgentBody = raw;
          }
          state.agentPosts += 1;
          res.writeHead(state.agentStatus, { "content-type": "application/json" }).end(JSON.stringify({ ok: state.agentStatus === 202 }));
        });
        return;
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "not found" }));
      }
    };
    if (state.delayMs > 0) {
      setTimeout(respond, state.delayMs).unref?.();
    } else {
      respond();
    }
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    state,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("crush unix-socket client", () => {
  it("rejects non-absolute sockets and bad timeouts without I/O", () => {
    assert.throws(() => new CrushHttpClient("relative.sock"), CrushApiError);
    assert.throws(() => new CrushHttpClient(""), CrushApiError);
    assert.throws(() => new CrushHttpClient(path.join(os.tmpdir(), "x.sock"), 0), CrushApiError);
  });

  it("reads the accepted non-model fixture contract", async () => {
    const fx = await startFixture();
    try {
      const api = new CrushHttpClient(fx.socketPath);
      assert.deepEqual(await api.getVersion(), { version: "v0.98.2" });
      assert.deepEqual(await api.listWorkspaces(), [{ id: "ws-1", path: (fx.state.workspaces as Array<{ path: string }>)[0]!.path }]);
      const session = await api.getSession("ws-1", "ses-1");
      assert.equal(session.id, "ses-1");
      assert.equal(session.parent_session_id, "");
      assert.equal(session.prompt_tokens, 100);
      assert.equal(session.completion_tokens, 50);
      const agent = await api.getAgent("ws-1");
      assert.equal(agent.model.id, "m1");
      assert.equal(agent.model.context_window, 200000);
      assert.deepEqual(agent.model_cfg, { provider: "p", model: "m" });
      assert.equal(agent.is_ready, true);
      const created = await api.createSession("ws-1", "my title");
      assert.equal(created.id, "ses-new-1");
      assert.deepEqual(fx.state.createdSessions, [{ title: "my title" }]);
      assert.equal(fx.state.agentPosts, 0);
    } finally {
      await fx.close();
    }
  });

  it("rejects wrong shapes, statuses, and non-JSON bodies", async () => {
    const fx = await startFixture();
    try {
      const api = new CrushHttpClient(fx.socketPath);
      fx.state.version = { nope: 1 };
      await assert.rejects(api.getVersion(), CrushApiError);
      fx.state.version = { version: "v0.98.2" };
      fx.state.workspaces = [{ id: "ws-1" }];
      await assert.rejects(api.listWorkspaces(), CrushApiError);
      fx.state.workspaces = [{ id: "ws-1", path: "x" }];
      fx.state.session = { id: "ses-1", parent_session_id: "" };
      const session = await api.getSession("ws-1", "ses-1");
      assert.ok(Number.isNaN(session.prompt_tokens));
      assert.ok(Number.isNaN(session.completion_tokens));
      fx.state.agent = { model: {} };
      await assert.rejects(api.getAgent("ws-1"), CrushApiError);
      await assert.rejects(api.getSession("ws-1", "missing"), CrushApiError);
    } finally {
      await fx.close();
    }
  });

  it("validates getSession id equals the requested id", async () => {
    const fx = await startFixture();
    try {
      const api = new CrushHttpClient(fx.socketPath);
      fx.state.session = { id: "other", parent_session_id: "", prompt_tokens: 1, completion_tokens: 1 };
      await assert.rejects(api.getSession("ws-1", "ses-1"), /mismatched id/);
    } finally {
      await fx.close();
    }
  });

  it("rejects a non-root create response", async () => {
    const fx = await startFixture();
    try {
      const api = new CrushHttpClient(fx.socketPath);
      fx.state.createdParent = "parent-1";
      await assert.rejects(api.createSession("ws-1", "my title"), /not a root/);
    } finally {
      await fx.close();
    }
  });

  it("covers sendAgentPrompt exact JSON, 202 success, wrong status, and timeouts via fake HTTP", async () => {
    const fx = await startFixture();
    try {
      const api = new CrushHttpClient(fx.socketPath);
      fx.state.agentStatus = 202;
      await api.sendAgentPrompt("ws-1", "ses-new-1", "hello seed");
      assert.equal(fx.state.agentPosts, 1);
      assert.deepEqual(fx.state.lastAgentBody, { session_id: "ses-new-1", prompt: "hello seed" });
      fx.state.agentStatus = 500;
      await assert.rejects(api.sendAgentPrompt("ws-1", "ses-new-1", "again"), CrushApiError);
      assert.deepEqual(fx.state.lastAgentBody, { session_id: "ses-new-1", prompt: "again" });
      fx.state.agentStatus = 202;
      fx.state.delayMs = 300;
      const impatient = new CrushHttpClient(fx.socketPath, 50);
      await assert.rejects(impatient.sendAgentPrompt("ws-1", "ses-new-1", "slow"), /timed out/);
    } finally {
      await fx.close();
    }
  });

  it("fails on missing sockets and bounded timeouts", async () => {
    const missing = new CrushHttpClient(path.join(os.tmpdir(), `crush-missing-${process.pid}.sock`));
    await assert.rejects(missing.getVersion(), Error);
    const fx = await startFixture();
    try {
      fx.state.delayMs = 300;
      const impatient = new CrushHttpClient(fx.socketPath, 50);
      await assert.rejects(impatient.getVersion(), /timed out/);
    } finally {
      await fx.close();
    }
  });
});

after(() => {
  // Fixture sockets live under os.tmpdir(); nothing here touches a user socket.
});
