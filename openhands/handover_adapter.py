"""Auto-context-handover adapter: standard SDK composition, no mini harness.

Setup (a few lines; ``openhands/`` on ``sys.path`` for the import)::

    adapter = HandoverAdapter()  # keep a strong reference for the session
    agent = adapter.equip(agent)  # uninitialized copy + 2 tools + intro
    conv = Conversation(agent=agent, workspace=..., callbacks=[adapter.on_event],
                        hook_config=adapter.hook_config)
    adapter.bind(conv)  # once, before the first send/run

The tool registry is weak. Retain the adapter for the conversation's lifetime;
the supplied ``adapter.on_event`` callback normally does this. A bare
``HandoverAdapter().equip(...)`` one-liner is unsupported.

Advisory notices are UserPromptSubmit additionalContext only. The callback
samples only ``conversation.agent.llm.metrics.token_usages[-1]``; the hook
subprocess only reads the nonce snapshot and fails open on any error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import secrets
import shlex
import sys
import weakref
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

HANDOVER_SECTIONS = """Write the handover with these sections:
1. Original instructions, role, and constraints (verbatim where it matters): role; active user scope and critical rules/prohibitions verbatim, or verified reload instructions (file/skill); permissions/tool restrictions, config scope, delegation/question/commit limits.
2. Completed work and decisions: changed files; explicit user decisions vs implicitly accepted proposals vs agent-adopted choices; separate direct verification (command/result) from others' reports (source), live observations, and unverified work.
3. In-progress work and exact current state: exact stopping point, unresolved risks, continuation/compaction status; flag history gaps.
4. Key snippets (short, copyable): only essential snippets.
5. Negative knowledge: explicit dead ends, failed approaches, what NOT to try again.
6. Prioritized next steps for the successor session: steps the successor can execute directly; reaching the context limit is not a roadblock and never a reason to ask the user; escalate only a user-owned decision that is independent of the context limit. Keep open questions explicitly; do not drop them.

State instruction deviations, triggered stop conditions, failed or erroring calls, and unverified claims plainly; never mark work PASS or complete while a deviation or triggered stop is unresolved; the summary must not claim more than the body.

Do not describe your own agent type, model (including override), or chain; the plugin records authoritative provenance and the parent uses the plugin record even if this handover says otherwise.

Prefer durable docs over repeated background; omit personal trivia; never trim unresolved risks or verification distinctions; mark unknowns rather than inventing history/controls. Keep concise and avoid repetitive prose."""

SEED_FRAMING = (
    "The original task is reference only; completed steps are done and must not be repeated. "
    "Predecessor facts are trusted unless marked unverified; preserve verification distinctions and do not recast predecessor direct evidence as successor direct verification. "
    "Targeted rereads of already-covered material are allowed only to resolve open questions; never repeat completed steps. "
    "Continue from 'Prioritized next steps'."
)

OPENCODE_WARN1 = (
    "Auto-context-handover notice. Context is filling. "
    "Finish the current unit of work, then call the context_handover tool with the full handover text. "
    "Do not start new work after this unit."
)

OPENCODE_WARN2 = (
    "Auto-context-handover warning. Wrap up now: complete only the step in progress, "
    "then call the context_handover tool with the full handover text. Starting new work risks losing state to compaction."
)

OPENCODE_WARN3 = (
    "Auto-context-handover final warning. Stop after this step and call the context_handover tool "
    "with the full handover text. Do not defer the handover past this response."
)


def open_code_stage_text(stage: str) -> str:
    if stage == "warn1":
        return OPENCODE_WARN1
    if stage == "warn2":
        return OPENCODE_WARN2
    return OPENCODE_WARN3


def soft_stage(estimate: int, soft: int) -> str:
    if estimate >= soft * (1 + 0.2):
        return "warn3"
    if estimate >= soft * (1 + 0.1):
        return "warn2"
    if estimate >= soft * (1 + 0):
        return "warn1"
    return "ok"


def format_diag_line(diag: dict[str, Any] | None) -> str:
    def text(value: Any) -> str:
        return value if isinstance(value, str) and value else "unknown"

    def num(value: Any) -> str:
        if isinstance(value, bool):
            return "unknown"
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            return str(math.floor(value))
        return "unknown"

    diag = diag or {}
    return (
        f"Diagnostics: reason={text(diag.get('reason'))}, "
        f"stage={text(diag.get('stage'))}, "
        f"estimated-context-tokens={num(diag.get('estimate'))}, "
        f"soft-limit={num(diag.get('soft'))}"
    )


def seed_too_large(seed_estimate: int, soft_tokens: int) -> bool:
    return seed_estimate > soft_tokens * 0.5


class ThresholdError(ValueError):
    pass


def parse_threshold(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        raise ThresholdError(f"threshold must be a positive integer or percent, got {value!r}")
    if isinstance(value, int):
        if value <= 0:
            raise ThresholdError(f"threshold must be a positive integer or percent, got {value!r}")
        return {"kind": "tokens", "tokens": value}
    if isinstance(value, str):
        text = value.strip()
        # Bare digit strings accepted for env ergonomics (TS parity is percent-only).
        if re.fullmatch(r"[0-9]+", text):
            if len(text) > 15:
                raise ThresholdError(f"threshold integer overflow, got {value!r}")
            number = int(text)
            if number <= 0:
                raise ThresholdError(f"threshold must be a positive integer or percent, got {value!r}")
            return {"kind": "tokens", "tokens": number}
        match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)%", text)  # ASCII digits only
        if not match:
            raise ThresholdError(f"threshold must be a positive integer or percent, got {value!r}")
        ratio = float(match.group(1)) / 100
        if not (math.isfinite(ratio) and 0 < ratio <= 1):
            raise ThresholdError(f"threshold percent must be within (0%, 100%], got {value!r}")
        return {"kind": "percent", "ratio": ratio}
    raise ThresholdError(f"threshold must be a positive integer or percent, got {value!r}")


def resolve_soft_tokens(spec: dict[str, Any], window: int | None) -> int | None:
    if spec["kind"] == "percent":
        if window is None:
            return None
        return math.floor(spec["ratio"] * window)
    if window is None:
        return spec["tokens"]
    return min(spec["tokens"], math.floor(0.7 * window))


STORE_DIRNAME = "auto-context-handover"
DEFAULT_SOFT_TOKENS = 200000
ENV_SOFT_VAR = "AUTO_CONTEXT_HANDOVER_SOFT"


def store_base(home: Path | None = None) -> Path:
    return (home or Path.home()) / ".openhands" / STORE_DIRNAME


def hash_source_id(source_id: str) -> str:
    return hashlib.sha256(source_id.encode("utf-8")).hexdigest()


def handover_path(source_id: str, home: Path | None = None) -> Path:
    return store_base(home) / hash_source_id(source_id) / "handover.json"


def snapshot_path(source_id: str, token: str, home: Path | None = None) -> Path:
    return store_base(home) / hash_source_id(source_id) / f"snapshot-{token}.json"


def _mkdir_new(path: Path) -> None:
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        if not path.is_dir():
            raise
        return  # existing host dir: leave permissions untouched
    os.chmod(path, 0o700)


def _ensure_store_dirs(hashdir: Path) -> None:
    base = store_base()
    for level in (base.parent, base, hashdir):
        _mkdir_new(level)


def _write_new(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
    finally:
        os.close(fd)


def _atomic_replace(path: Path, data: bytes) -> None:
    tmp = path.parent / f".tmp-{secrets.token_hex(8)}"
    _write_new(tmp, data)
    os.replace(tmp, path)


def _validate_record(stored: Any, source_id: str) -> dict[str, Any]:
    if not isinstance(stored, dict):
        raise ValueError(f"stored handover corrupt for session {source_id}")
    if not isinstance(stored.get("handover"), str) or not stored["handover"]:
        raise ValueError(f"stored handover corrupt for session {source_id}")
    if not isinstance(stored.get("summary"), str) or not stored["summary"]:
        raise ValueError(f"stored handover corrupt for session {source_id}")
    if stored.get("source_id") != source_id:
        raise ValueError(f"stored handover source mismatch for session {source_id}")
    diag = stored.get("diagnostics")
    if not isinstance(diag, dict):
        raise ValueError(f"stored handover corrupt for session {source_id}")
    for key in ("estimate", "soft"):
        val = diag.get(key)
        if val != "unknown" and not (
            isinstance(val, int) and not isinstance(val, bool) and val >= 0
        ):
            raise ValueError(f"stored handover corrupt for session {source_id}")
    for key in ("reason", "stage"):
        if not isinstance(diag.get(key), str) or not diag[key]:
            raise ValueError(f"stored handover corrupt for session {source_id}")
    return stored


def publish_handover(source_id: str, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    target = handover_path(source_id)
    _ensure_store_dirs(target.parent)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    tmp = target.parent / f".tmp-{secrets.token_hex(8)}"
    _write_new(tmp, raw)
    try:
        os.link(tmp, target)
        created = True
    except FileExistsError:
        created = False
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return created, _validate_record(json.loads(target.read_bytes().decode("utf-8")), source_id)


INTRO_TEXT = (
    "Auto-context-handover is equipped. Only after a context-limit nudge "
    "(additionalContext notice) or when the user explicitly asks for a handover: "
    "finish the current step, not the entire task, "
    "then call context_handover once with the FULL handover text and a short summary; "
    "the stored handover replaces the final report for this session. "
    "Otherwise give a normal final response and do not call context_handover "
    "just to finish a task. "
    "A successor continues from 'Prioritized next steps' after reading it back with read_handover. "
    "Read-only callers may still call context_handover: it writes plugin storage only. "
    "Never describe your own agent type, model, or chain; leave those fields unknown rather than inferring them."
)

WRITER_DESCRIPTION = (
    "Call this tool only after the plugin nudges you about the context limit, or when the user "
    "explicitly asks for a handover. Do not call it just to finish a task; give a normal final response instead. "
    "Once nudged, call exactly once per session when you are done with the current unit of work, then stop. "
    'Pass the FULL handover text VERBATIM in "handover" (it is stored and replayed word for word, never '
    'summarized or reworded) plus a short status/outcome/next-step summary in "summary". '
    "Do not paste secrets.\n\n" + HANDOVER_SECTIONS
)

READER_DESCRIPTION = (
    "Read the full stored handover text for a session. Takes sessionID. Returns the verbatim handover "
    "plus a diagnostics header line and shared continuation framing."
)

_ADAPTERS: Any = weakref.WeakValueDictionary()
_REGISTERED = False


def _register_tools() -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    from openhands.sdk.tool import register_tool

    register_tool(ContextHandoverTool.name, ContextHandoverTool)
    register_tool(ReadHandoverTool.name, ReadHandoverTool)
    _REGISTERED = True


class HandoverAdapter:
    def __init__(self, soft: Any = None) -> None:
        raw = soft if soft is not None else os.environ.get(ENV_SOFT_VAR, DEFAULT_SOFT_TOKENS)
        try:
            self.soft_spec: dict[str, Any] | None = parse_threshold(raw)
            self.notices_disabled = False
        except ThresholdError:
            self.soft_spec = None
            self.notices_disabled = True
            logger.warning("auto-context-handover: invalid soft %r; notices disabled, tools unaffected", raw)
        self.token = secrets.token_hex(16)
        self._host: Any = None
        self._host_id: int | None = None
        self.source_id: str | None = None
        self._seen_count = 0
        self._diag: dict[str, Any] = {
            "reason": "unknown", "stage": "unknown", "estimate": "unknown", "soft": "unknown",
        }
        # Nudge provenance is latched separately from per-response measurements so
        # hook -> new-model-response -> writer keeps a truthful "nudged" reason
        # while fresh measurements still report "not-nudged" until a hook emits.
        self._nudged = False
        # Monotonic snapshot nonce: memory rev vs disk rev distinguishes fresh
        # memory from a stale disk file after a failed write.
        self._rev = 0
        _ADAPTERS[self.token] = self
        self._hook_config: Any = None

    def equip(self, agent: Any) -> Any:
        if not agent.supports_openhands_tools:
            raise RuntimeError("HandoverAdapter rejects agents whose server owns tools")
        try:
            agent.tools_map
        except RuntimeError:
            pass  # pre-init, as required
        else:
            raise RuntimeError("HandoverAdapter.equip requires an uninitialized agent")
        clash = {t.name for t in agent.tools} & {"context_handover", "read_handover"}
        if clash:
            raise RuntimeError(f"HandoverAdapter.equip refuses conflicting tools: {sorted(clash)}")
        _register_tools()
        from openhands.sdk.tool.spec import Tool

        specs = [
            Tool(name="context_handover", params={"adapter_token": self.token}),
            Tool(name="read_handover", params={"adapter_token": self.token}),
        ]
        existing = getattr(agent, "agent_context", None)
        if existing is None:
            from openhands.sdk.context.agent_context import AgentContext

            context = AgentContext(system_message_suffix=INTRO_TEXT)
        else:
            prior = existing.system_message_suffix or ""
            context = existing.model_copy(update={"system_message_suffix": (prior + "\n\n" if prior else "") + INTRO_TEXT})
        return agent.model_copy(update={"tools": [*agent.tools, *specs], "agent_context": context})

    @property
    def hook_config(self) -> Any:
        if self._hook_config is None:
            from openhands.sdk.hooks import HookConfig, HookDefinition, HookMatcher

            cmd = (
                f"{shlex.quote(sys.executable)} "
                f"{shlex.quote(os.path.abspath(__file__))} "
                f"--hook --token {shlex.quote(self.token)}"
            )
            self._hook_config = HookConfig(
                user_prompt_submit=[HookMatcher(matcher="*", hooks=[HookDefinition(command=cmd)])]
            )
        return self._hook_config

    def bind(self, conversation: Any) -> None:
        if self._host is not None:
            raise RuntimeError("HandoverAdapter.bind() called twice; bind once")
        self._host = conversation
        self._host_id = id(conversation)
        self.source_id = str(conversation.id)
        self._write_snapshot(self._diag)

    def on_event(self, event: Any) -> None:
        try:
            self._observe(event)
        except Exception:
            pass

    def _observe(self, event: Any) -> None:
        from openhands.sdk.event.condenser import Condensation

        host = self._host
        if host is None or self.source_id is None:
            return
        if isinstance(event, Condensation):
            try:
                fresh_len = len(host.agent.llm.metrics.token_usages)
            except Exception:
                fresh_len = self._seen_count
            self._latch_nudge_from_disk()
            self._seen_count = fresh_len
            self._diag = {"reason": "unknown", "stage": "unknown", "estimate": "unknown", "soft": "unknown"}
            if not self._write_snapshot(self._diag):
                self._invalidate_snapshot()
            return
        try:
            usages = host.agent.llm.metrics.token_usages
        except Exception:
            return
        if not usages:
            return
        if len(usages) <= self._seen_count:
            return  # hook callbacks without fresh usage preserve the snapshot
        self._latch_nudge_from_disk()
        self._diag = self._measure(usages[-1])
        if self._write_snapshot(self._diag):
            self._seen_count = len(usages)
        else:
            # Keep memory fresh for the writer; leave _seen_count behind so the
            # same usage retries on the next event. Invalidate stale disk so the
            # hook subprocess does not act on outdated estimates.
            self._invalidate_snapshot()

    def _measure(self, last: Any) -> dict[str, Any]:
        unknown: dict[str, Any] = {"reason": "unknown", "stage": "unknown", "estimate": "unknown", "soft": "unknown"}
        try:
            prompt, completion, window = last.prompt_tokens, last.completion_tokens, last.context_window
        except Exception:
            return unknown
        if (
            isinstance(prompt, bool) or isinstance(completion, bool)
            or not (isinstance(prompt, int) and isinstance(completion, int))
            or prompt < 0 or completion < 0 or prompt + completion <= 0
        ):
            return unknown
        estimate = prompt + completion
        known_window = window if isinstance(window, int) and not isinstance(window, bool) and window > 0 else None
        if self.soft_spec is None:
            return {"reason": "unknown", "stage": "unknown", "estimate": estimate, "soft": "unknown"}
        soft = resolve_soft_tokens(self.soft_spec, known_window)
        if soft is None:
            return {"reason": "unknown", "stage": "unknown", "estimate": estimate, "soft": "unknown"}
        # reason stays not-nudged here; only the hook marks nudged when it emits.
        return {"reason": "not-nudged", "stage": soft_stage(estimate, soft), "estimate": estimate, "soft": soft}

    def _snapshot_file(self) -> Path | None:
        if self.source_id is None:
            return None
        return snapshot_path(self.source_id, self.token)

    def _latch_nudge_from_disk(self) -> None:
        path = self._snapshot_file()
        if path is None or self.source_id is None:
            return
        try:
            shot = json.loads(path.read_bytes().decode("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return
        if not isinstance(shot, dict):
            return
        if shot.get("session_id") != self.source_id or shot.get("adapter_token") != self.token:
            return
        if shot.get("reason") != "nudged":
            return
        disk_rev = shot.get("rev")
        if not isinstance(disk_rev, int) or isinstance(disk_rev, bool):
            return
        if disk_rev != self._rev:
            return
        self._nudged = True

    def _memory_diag(self) -> dict[str, Any]:
        diag = dict(self._diag)
        if self._nudged:
            diag["reason"] = "nudged"
        return diag

    def _write_snapshot(self, diag: dict[str, Any]) -> bool:
        path = self._snapshot_file()
        if path is None or self.source_id is None:
            return False
        self._rev += 1
        reason = "nudged" if self._nudged else diag.get("reason", "unknown")
        try:
            _ensure_store_dirs(path.parent)
            _atomic_replace(path, json.dumps({
                "session_id": self.source_id, "adapter_token": self.token,
                "estimate": diag.get("estimate", "unknown"), "soft": diag.get("soft", "unknown"),
                "stage": diag.get("stage", "unknown"), "reason": reason, "rev": self._rev,
            }, sort_keys=True).encode("utf-8"))
        except Exception as exc:
            logger.warning("auto-context-handover: snapshot write failed for session %s: %s",
                           self.source_id, exc)
            return False
        return True

    def _invalidate_snapshot(self) -> None:
        path = self._snapshot_file()
        if path is None:
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except Exception as exc:
            logger.warning("auto-context-handover: snapshot invalidation failed for session %s: %s",
                           self.source_id, exc)

    def _snapshot_diag(self) -> dict[str, Any]:
        self._latch_nudge_from_disk()
        return self._memory_diag()


def _adapter_from_params(adapter_token: Any) -> "HandoverAdapter":
    adapter = _ADAPTERS.get(adapter_token) if isinstance(adapter_token, str) else None
    if adapter is None:
        raise ValueError("unknown handover adapter; equip() then bind() first")
    return adapter


def _host_ok(adapter: "HandoverAdapter", conversation: Any) -> bool:
    host = adapter._host
    return (
        conversation is not None and host is not None and conversation is host
        and id(conversation) == adapter._host_id and adapter.source_id is not None
        and str(getattr(conversation, "id", None)) == adapter.source_id
    )


def _store_writer(adapter: "HandoverAdapter", handover: str, summary: str) -> str:
    assert adapter.source_id is not None
    payload = {"handover": handover, "summary": summary,
               "source_id": adapter.source_id, "diagnostics": adapter._snapshot_diag()}
    created, stored = publish_handover(adapter.source_id, payload)
    sid = adapter.source_id
    if created:
        return (
            f"Handover stored for session {sid}. End your turn now with a short status reply. "
            f"To continue, open a fresh session and read it back with "
            f"read_handover({{\"sessionID\": {json.dumps(sid)}}})."
        )
    return (
        f"Handover already stored for session {sid}; the first write was kept and nothing was overwritten. "
        f"Existing summary: {stored.get('summary')} "
        f"Read it back with read_handover({{\"sessionID\": {json.dumps(sid)}}})."
    )


def _store_reader(target: str) -> str:
    cleaned = target.strip() if isinstance(target, str) else ""
    if not cleaned:
        raise ValueError("read_handover needs a non-empty sessionID")
    path = handover_path(cleaned)
    try:
        stored = _validate_record(json.loads(path.read_bytes().decode("utf-8")), cleaned)
    except FileNotFoundError:
        return f"No handover stored for session {cleaned}."
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"auto-context-handover: stored handover unreadable for session {cleaned}: {exc}") from exc
    diag = stored["diagnostics"]
    body: str = stored["handover"]
    out = f"Handover from session {cleaned}:\n{format_diag_line(diag)}\n\n{body}\n\n{SEED_FRAMING}"
    soft = diag.get("soft")
    if isinstance(soft, int) and not isinstance(soft, bool) and soft > 0:
        seed_est = (len(body) + 3) // 4
        if seed_too_large(seed_est, soft):
            out += (
                f"\n\nWarning: handover seed estimate ~{seed_est} tokens exceeds 50% "
                f"of soft limit {soft}; do not rewrite the stored text, "
                "compress at the next handover instead."
            )
    return out


def _define_tools() -> tuple[type, type]:
    from collections.abc import Sequence

    from pydantic import Field

    from openhands.sdk.tool.schema import Action, Observation
    from openhands.sdk.tool.tool import ToolAnnotations, ToolDefinition, ToolExecutor

    class ContextHandoverAction(Action):
        handover: str = Field(description="FULL handover text, verbatim")
        summary: str = Field(description="Short status/outcome/next-step summary")

    class HandoverObservation(Observation):
        pass

    class ContextHandoverExecutor(ToolExecutor):
        def __init__(self, adapter: HandoverAdapter) -> None:
            self._adapter = adapter

        def __call__(self, action: ContextHandoverAction, conversation: Any = None) -> HandoverObservation:
            if not _host_ok(self._adapter, conversation):
                return HandoverObservation.from_text(
                    text="Refused: context_handover must be called from its bound host conversation only "
                    "(exact host object identity and source id required).")
            if not isinstance(action.handover, str) or not action.handover:
                return HandoverObservation.from_text(text="Refused: handover must be a non-empty string.")
            if not isinstance(action.summary, str) or not action.summary:
                return HandoverObservation.from_text(text="Refused: summary must be a non-empty string.")
            try:
                result = _store_writer(self._adapter, action.handover, action.summary)
            except Exception as exc:
                return HandoverObservation.from_text(text=f"Handover storage failed: {exc}")
            return HandoverObservation.from_text(text=result)

    class ContextHandoverTool(ToolDefinition[ContextHandoverAction, HandoverObservation]):
        @classmethod
        def create(cls, conv_state: Any = None, adapter_token: Any = None, **params: Any) -> Sequence[Any]:
            if params:
                raise ValueError(f"context_handover takes no extra params, got {sorted(params)}")
            adapter = _adapter_from_params(adapter_token)
            return [cls(description=WRITER_DESCRIPTION, action_type=ContextHandoverAction,
                        observation_type=HandoverObservation, executor=ContextHandoverExecutor(adapter),
                        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                                    idempotentHint=True, openWorldHint=False))]

    class ReadHandoverAction(Action):
        sessionID: str = Field(description="Source session id to read back")

    class ReadHandoverExecutor(ToolExecutor):
        def __init__(self, adapter: HandoverAdapter) -> None:
            self._adapter = adapter

        def __call__(self, action: ReadHandoverAction, conversation: Any = None) -> HandoverObservation:
            if not _host_ok(self._adapter, conversation):
                return HandoverObservation.from_text(
                    text="Refused: read_handover must be called from its bound host conversation.")
            try:
                result = _store_reader(action.sessionID)
            except ValueError as exc:
                return HandoverObservation.from_text(text=str(exc))
            except Exception as exc:
                return HandoverObservation.from_text(text=f"Handover storage failed: {exc}")
            return HandoverObservation.from_text(text=result)

    class ReadHandoverTool(ToolDefinition[ReadHandoverAction, HandoverObservation]):
        @classmethod
        def create(cls, conv_state: Any = None, adapter_token: Any = None, **params: Any) -> Sequence[Any]:
            if params:
                raise ValueError(f"read_handover takes no extra params, got {sorted(params)}")
            adapter = _adapter_from_params(adapter_token)
            return [cls(description=READER_DESCRIPTION, action_type=ReadHandoverAction,
                        observation_type=HandoverObservation, executor=ReadHandoverExecutor(adapter),
                        annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False,
                                                    idempotentHint=True, openWorldHint=False))]

    return ContextHandoverTool, ReadHandoverTool


ContextHandoverTool, ReadHandoverTool = _define_tools()


def hook_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hook", action="store_true")
    parser.add_argument("--token", default="")
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0
    try:
        session_id = event.get("session_id") or ""
        token = args.token
        if not session_id or not token:
            return 0
        snap = snapshot_path(str(session_id), token)
        shot = json.loads(snap.read_bytes().decode("utf-8"))
        if not isinstance(shot, dict) or shot.get("session_id") != session_id:
            return 0
        if shot.get("adapter_token") != token:
            return 0
        estimate, soft = shot.get("estimate"), shot.get("soft")
        if isinstance(estimate, bool) or isinstance(soft, bool):
            return 0
        if not (isinstance(estimate, int) and isinstance(soft, int)) or estimate <= 0 or soft <= 0:
            return 0
        stage = soft_stage(estimate, soft)
        if stage == "ok":
            return 0
        _atomic_replace(snap, json.dumps(
            {**shot, "reason": "nudged", "stage": stage, "estimate": estimate, "soft": soft},
            sort_keys=True).encode("utf-8"))
        sys.stdout.write(json.dumps({"additionalContext": (
            f"{open_code_stage_text(stage)}\n"
            f"{format_diag_line({'reason': 'nudged', 'stage': stage, 'estimate': estimate, 'soft': soft})}\n"
            "Session intro describes the handover tools.")}))
        return 0
    except Exception:
        return 0


if __name__ == "__main__":
    raise SystemExit(hook_main())
