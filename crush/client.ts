import http from "node:http";
import path from "node:path";

// Unix-socket HTTP client for the Crush v1 API. socketPath only; no network
// URL and no arbitrary transport. Every request is bounded by a timeout.
export const REQUEST_TIMEOUT_MS = 5000;

export class CrushApiError extends Error {
  constructor(message: string) {
    super(`crush client: ${message}`);
    this.name = "CrushApiError";
  }
}

export interface WorkspaceInfo {
  readonly id: string;
  readonly path: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly parent_session_id: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
}

export interface AgentInfo {
  readonly model: { readonly id: string; readonly context_window?: number };
  readonly model_cfg?: { readonly provider: string; readonly model: string };
  readonly is_ready?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface CrushApi {
  getVersion(): Promise<{ readonly version: string }>;
  listWorkspaces(): Promise<readonly WorkspaceInfo[]>;
  getSession(workspaceId: string, sessionId: string): Promise<SessionInfo>;
  getAgent(workspaceId: string): Promise<AgentInfo>;
  createSession(workspaceId: string, title: string): Promise<{ readonly id: string }>;
  /** Production-only: admits the successor prompt detached (expects 202). Never call in tests. */
  sendAgentPrompt(workspaceId: string, sessionId: string, prompt: string): Promise<void>;
}

export class CrushHttpClient implements CrushApi {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs: number = REQUEST_TIMEOUT_MS) {
    if (typeof socketPath !== "string" || socketPath.length === 0 || !path.isAbsolute(socketPath)) {
      throw new CrushApiError("socket path must be an absolute path");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CrushApiError("timeout must be a positive integer of milliseconds");
    }
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  private requestRaw(method: string, reqPath: string, body?: unknown): Promise<{ status: number; text: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: reqPath,
          method,
          headers: {
            ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new CrushApiError(`request ${method} ${reqPath} timed out after ${this.timeoutMs}ms`)));
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private async requestJson(method: string, reqPath: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const { status, text } = await this.requestRaw(method, reqPath, body);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CrushApiError(`request ${method} ${reqPath} returned status ${status} with a non-JSON body`);
    }
    return { status, json };
  }

  private static requireOk(method: string, reqPath: string, status: number, expected: number | readonly number[]): void {
    const accepted = Array.isArray(expected) ? expected : [expected];
    if (!accepted.includes(status)) {
      throw new CrushApiError(`request ${method} ${reqPath} returned status ${status}, expected ${accepted.join(" or ")}`);
    }
  }

  async getVersion(): Promise<{ readonly version: string }> {
    const { status, json } = await this.requestJson("GET", "/v1/version");
    CrushHttpClient.requireOk("GET", "/v1/version", status, 200);
    if (!isRecord(json) || typeof json.version !== "string" || json.version.length === 0) {
      throw new CrushApiError("GET /v1/version returned an unexpected shape");
    }
    return { version: json.version };
  }

  async listWorkspaces(): Promise<readonly WorkspaceInfo[]> {
    const { status, json } = await this.requestJson("GET", "/v1/workspaces");
    CrushHttpClient.requireOk("GET", "/v1/workspaces", status, 200);
    if (!Array.isArray(json)) throw new CrushApiError("GET /v1/workspaces returned an unexpected shape");
    return json.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.path !== "string") {
        throw new CrushApiError("GET /v1/workspaces returned an unexpected shape");
      }
      return { id: entry.id, path: entry.path };
    });
  }

  async getSession(workspaceId: string, sessionId: string): Promise<SessionInfo> {
    const reqPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
    const { status, json } = await this.requestJson("GET", reqPath);
    CrushHttpClient.requireOk("GET", reqPath, status, 200);
    if (!isRecord(json) || typeof json.id !== "string" || typeof json.parent_session_id !== "string") {
      throw new CrushApiError(`GET ${reqPath} returned an unexpected shape`);
    }
    if (json.id !== sessionId) {
      throw new CrushApiError(`GET ${reqPath} returned mismatched id ${JSON.stringify(json.id)}`);
    }
    return {
      id: json.id,
      parent_session_id: json.parent_session_id,
      prompt_tokens: typeof json.prompt_tokens === "number" ? json.prompt_tokens : NaN,
      completion_tokens: typeof json.completion_tokens === "number" ? json.completion_tokens : NaN,
    };
  }

  async getAgent(workspaceId: string): Promise<AgentInfo> {
    const reqPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent`;
    const { status, json } = await this.requestJson("GET", reqPath);
    CrushHttpClient.requireOk("GET", reqPath, status, 200);
    if (!isRecord(json) || !isRecord(json.model) || typeof json.model.id !== "string") {
      throw new CrushApiError(`GET ${reqPath} returned an unexpected shape`);
    }
    return {
      model: {
        id: json.model.id,
        ...(typeof json.model.context_window === "number" ? { context_window: json.model.context_window } : {}),
      },
      ...(isRecord(json.model_cfg) && typeof json.model_cfg.provider === "string" && typeof json.model_cfg.model === "string"
        ? { model_cfg: { provider: json.model_cfg.provider, model: json.model_cfg.model } }
        : {}),
      ...(typeof json.is_ready === "boolean" ? { is_ready: json.is_ready } : {}),
    };
  }

  async createSession(workspaceId: string, title: string): Promise<{ readonly id: string }> {
    const reqPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`;
    const { status, json } = await this.requestJson("POST", reqPath, { title });
    CrushHttpClient.requireOk("POST", reqPath, status, [200, 201]);
    if (!isRecord(json) || typeof json.id !== "string" || json.id.length === 0 || typeof json.parent_session_id !== "string") {
      throw new CrushApiError(`POST ${reqPath} returned an unexpected shape`);
    }
    if (json.parent_session_id !== "") {
      throw new CrushApiError(`POST ${reqPath} created session is not a root (parent_session_id is not empty)`);
    }
    return { id: json.id };
  }

  async sendAgentPrompt(workspaceId: string, sessionId: string, prompt: string): Promise<void> {
    const reqPath = `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent`;
    const { status } = await this.requestRaw("POST", reqPath, { session_id: sessionId, prompt });
    CrushHttpClient.requireOk("POST", reqPath, status, 202);
  }
}
