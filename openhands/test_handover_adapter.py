"""Unit tests for handover_adapter (unittest, isolated HOME/XDG, no live models).

Run with ``openhands/`` on the import path::

    PYTHONPATH=openhands python openhands/test_handover_adapter.py
"""

import contextlib
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import handover_adapter as ha
from handover_adapter import HandoverAdapter


def make_llm():
    from openhands.sdk.llm import Message, TextContent
    from openhands.sdk.testing import TestLLM

    return TestLLM.from_messages(
        [Message(role="assistant", content=[TextContent(text="done")])]
    )


def make_conversation(adapter, agent, workspace):
    from openhands.sdk import Conversation

    conv = Conversation(
        agent=agent, workspace=workspace, callbacks=[adapter.on_event],
        hook_config=adapter.hook_config, visualizer=None,
    )
    adapter.bind(conv)
    conv._ensure_agent_ready()  # non-model load/resolve only; never .run()
    return conv


def add_usage(conv, prompt, completion, window=0, rid="resp-1"):
    conv.agent.llm.metrics.add_token_usage(
        prompt_tokens=prompt, completion_tokens=completion, cache_read_tokens=0,
        cache_write_tokens=0, context_window=window, response_id=rid,
    )


def agent_message(text="agent turn"):
    from openhands.sdk.event import MessageEvent
    from openhands.sdk.llm import Message, TextContent

    return MessageEvent(source="agent",
                        llm_message=Message(role="assistant", content=[TextContent(text=text)]))


def obs_text(obs):
    return obs.text if hasattr(obs, "text") else str(obs)


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self._stack = contextlib.ExitStack()
        self.addCleanup(self._stack.close)
        outer = tempfile.mkdtemp(prefix="oh-suite-", dir="/tmp/opencode")
        self.addCleanup(shutil.rmtree, outer, True)
        saved = dict(os.environ)

        def restore():
            os.environ.clear()
            os.environ.update(saved)

        self.addCleanup(restore)
        os.environ["TMPDIR"] = outer
        os.environ["HOME"] = self._stack.enter_context(tempfile.TemporaryDirectory(prefix="oh-home-"))
        for key, prefix in (("XDG_CONFIG_HOME", "oh-cfg-"), ("XDG_DATA_HOME", "oh-data-"),
                            ("XDG_CACHE_HOME", "oh-cache-")):
            os.environ[key] = self._stack.enter_context(tempfile.TemporaryDirectory(prefix=prefix))

    def workspace(self):
        return self._stack.enter_context(tempfile.TemporaryDirectory(prefix="oh-ws-"))

    def test_no_shadow_of_installed_sdk(self):
        import openhands.sdk

        self.assertIn("site-packages", openhands.sdk.__file__)

    def test_equip_guards_and_composition(self):
        from openhands.sdk import Agent, Conversation
        from openhands.sdk.context.agent_context import AgentContext

        adapter = HandoverAdapter()
        agent = Agent(llm=make_llm(), tools=[],
                      agent_context=AgentContext(system_message_suffix="EXISTING"))
        equipped = adapter.equip(agent)
        self.assertIsNot(equipped, agent)
        self.assertEqual(list(agent.tools), [])
        self.assertIn("EXISTING", equipped.agent_context.system_message_suffix)
        self.assertIn("context_handover", equipped.agent_context.system_message_suffix)
        self.assertEqual([t.name for t in equipped.tools], ["context_handover", "read_handover"])
        self.assertRaises(RuntimeError, adapter.equip, equipped)  # repeat equip
        conv = make_conversation(adapter, equipped, self.workspace())
        self.assertRaises(RuntimeError, HandoverAdapter().equip, conv.agent)  # initialized
        from openhands.sdk.agent.acp_agent import ACPAgent
        acp = ACPAgent(llm=make_llm(), skills=[], acp_command=["true"])
        self.assertFalse(acp.supports_openhands_tools)
        self.assertRaises(RuntimeError, HandoverAdapter().equip, acp)

    def test_hook_config_user_prompt_only(self):
        cfg = HandoverAdapter().hook_config
        self.assertTrue(cfg.user_prompt_submit)
        for field in ("pre_tool_use", "post_tool_use", "session_start", "session_end", "stop"):
            self.assertEqual(getattr(cfg, field), [])
        self.assertIn("handover_adapter.py", cfg.user_prompt_submit[0].hooks[0].command)

    def test_env_soft_parsing(self):
        self.assertEqual(HandoverAdapter(soft="4096").soft_spec, {"kind": "tokens", "tokens": 4096})
        self.assertEqual(HandoverAdapter(soft="70%").soft_spec, {"kind": "percent", "ratio": 0.7})
        with self.assertLogs("handover_adapter", level="WARNING"):
            disabled = HandoverAdapter(soft="")
        self.assertTrue(disabled.notices_disabled)
        for bad in ("70%%", "0%", "101%", "wide", "0", "-5", "1.5", True, "\uff190%",
                    "9" * 30, "0x10"):
            with self.assertRaises(ha.ThresholdError):
                ha.parse_threshold(bad)
        with mock.patch.dict(os.environ, {"AUTO_CONTEXT_HANDOVER_SOFT": "4096"}):
            self.assertEqual(HandoverAdapter().soft_spec, {"kind": "tokens", "tokens": 4096})
        with mock.patch.dict(os.environ, {"AUTO_CONTEXT_HANDOVER_SOFT": ""}):
            with self.assertLogs("handover_adapter", level="WARNING"):
                env_bad = HandoverAdapter()
        self.assertTrue(env_bad.notices_disabled)

    def test_writer_roundtrip_verbatim_and_modes(self):
        from openhands.sdk import Agent

        adapter = HandoverAdapter()
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        writer = conv.agent._tools["context_handover"]  # noqa: SLF001
        body, summary = "  spaced body\nline2\n\ntrailing\n\n", "\n short summary \n"
        self.assertIn("Handover stored", obs_text(writer(writer.action_type(handover=body, summary=summary), conv)))
        path = ha.handover_path(adapter.source_id)
        stored = json.loads(path.read_text())
        self.assertEqual((stored["handover"], stored["summary"]), (body, summary))
        self.assertEqual(stored["source_id"], adapter.source_id)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(path.parent).st_mode), 0o700)
        out = obs_text(conv.agent._tools["read_handover"](  # noqa: SLF001
            conv.agent._tools["read_handover"].action_type(sessionID=adapter.source_id), conv))  # noqa: SLF001
        self.assertEqual(out.count(body), 1)
        self.assertIn(ha.SEED_FRAMING, out)

    def test_writer_repeat_and_corrupt_existing(self):
        from openhands.sdk import Agent

        adapter = HandoverAdapter()
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        writer = conv.agent._tools["context_handover"]  # noqa: SLF001
        writer(writer.action_type(handover="FIRST", summary="first-sum"), conv)
        before = ha.handover_path(adapter.source_id).read_bytes()
        repeat = obs_text(writer(writer.action_type(handover="SECOND", summary="s2"), conv))
        self.assertIn("already stored", repeat)
        self.assertIn("first-sum", repeat)
        self.assertEqual(ha.handover_path(adapter.source_id).read_bytes(), before)
        adapter2 = HandoverAdapter()
        conv2 = make_conversation(adapter2, adapter2.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        bad = ha.handover_path(adapter2.source_id)
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text('{"handover": 42}')
        w2 = conv2.agent._tools["context_handover"]  # noqa: SLF001
        corrupt = obs_text(w2(w2.action_type(handover="X", summary="Y"), conv2))
        self.assertNotIn("already stored", corrupt)
        self.assertIn("storage failed", corrupt)

    def test_writer_bound_id_refusal_children_and_clones(self):
        from openhands.sdk import Agent, Conversation

        adapter = HandoverAdapter()
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        writer = conv.agent._tools["context_handover"]  # noqa: SLF001
        action = writer.action_type(handover="X", summary="Y")
        child = Conversation(agent=adapter.equip(Agent(llm=make_llm(), tools=[])),
                             workspace=self.workspace(), visualizer=None)
        self.assertIn("Refused", obs_text(writer(action, child)))
        clone = Conversation(agent=adapter.equip(Agent(llm=make_llm(), tools=[])),
                             workspace=self.workspace(), conversation_id=conv.id, visualizer=None)
        self.assertIn("Refused", obs_text(writer(action, clone)))

    def test_reader_missing_corrupt_mismatch_unbound(self):
        from openhands.sdk import Agent, Conversation

        adapter = HandoverAdapter()
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        reader = conv.agent._tools["read_handover"]  # noqa: SLF001
        self.assertIn("No handover stored",
                      obs_text(reader(reader.action_type(sessionID="nope"), conv)))
        bad = ha.handover_path("corrupt-target")
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text("{not json")
        corrupt = obs_text(reader(reader.action_type(sessionID="corrupt-target"), conv))
        self.assertNotIn("No handover stored", corrupt)
        self.assertIn("unreadable", corrupt)
        other = ha.handover_path("mismatch-target")
        other.parent.mkdir(parents=True, exist_ok=True)
        other.write_text(json.dumps({"handover": "H", "summary": "S", "source_id": "elsewhere",
                                     "diagnostics": {"reason": "r", "stage": "s", "estimate": 1, "soft": 2}}))
        self.assertIn("mismatch", obs_text(reader(reader.action_type(sessionID="mismatch-target"), conv)))
        outsider = Conversation(agent=adapter.equip(Agent(llm=make_llm(), tools=[])),
                                workspace=self.workspace(), visualizer=None)
        self.assertIn("Refused", obs_text(reader(reader.action_type(sessionID="x"), outsider)))

    def test_stage_bounds_and_capping(self):
        self.assertEqual(
            [ha.soft_stage(n, 1000) for n in (999, 1000, 1100, 1200)],
            ["ok", "warn1", "warn2", "warn3"])
        tokens = ha.parse_threshold(150000)
        self.assertEqual(ha.resolve_soft_tokens(tokens, 100000), 70000)
        self.assertEqual(ha.resolve_soft_tokens(tokens, None), 150000)
        pct = ha.parse_threshold("70%")
        self.assertEqual(ha.resolve_soft_tokens(pct, 200000), 140000)
        self.assertIsNone(ha.resolve_soft_tokens(pct, None))
        self.assertTrue(ha.seed_too_large(600, 1000))
        self.assertFalse(ha.seed_too_large(500, 1000))

    def test_invalid_config_disables_notices_not_tools(self):
        from openhands.sdk import Agent

        with self.assertLogs("handover_adapter", level="WARNING"):
            adapter = HandoverAdapter(soft="bogus")
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        self.assertIn("context_handover", conv.agent._tools)  # noqa: SLF001
        add_usage(conv, 90000, 90000, window=200000, rid="r1")
        adapter.on_event(agent_message())
        snap = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((snap["stage"], snap["soft"]), ("unknown", "unknown"))

    def test_all_zero_is_unknown(self):
        from openhands.sdk import Agent

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 0, 0, window=200000, rid="r0")
        adapter.on_event(agent_message())
        snap = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((snap["estimate"], snap["stage"]), ("unknown", "unknown"))

    def test_hook_emits_and_marks_snapshot_nudged(self):
        from openhands.sdk import Agent
        from openhands.sdk.hooks import HookManager

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="resp-1")
        adapter.on_event(agent_message())
        last = conv.agent.llm.metrics.token_usages[-1]
        self.assertEqual(last.prompt_tokens + last.completion_tokens, 1100)
        pre = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((pre["reason"], pre["stage"]), ("not-nudged", "warn2"))
        mgr = HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                          session_id=adapter.source_id)
        ok, ctx, _ = mgr.run_user_prompt_submit(message="next work item")
        self.assertTrue(ok)
        self.assertIn(ha.OPENCODE_WARN2, ctx)
        self.assertIn("Diagnostics: reason=nudged, stage=warn2", ctx)
        self.assertIn("Session intro describes", ctx)
        post = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((post["reason"], post["stage"]), ("nudged", "warn2"))
        conv.send_message("follow-up")  # real path; lagged previous response still observed
        _, ctx2, _ = HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                                 session_id=adapter.source_id).run_user_prompt_submit(message="more")
        self.assertIsNotNone(ctx2)

    def test_hook_mismatch_and_corrupt_fail_open(self):
        adapter = HandoverAdapter(soft=1000)
        snap_path = ha.snapshot_path("session-B", adapter.token)
        snap_path.parent.mkdir(parents=True, exist_ok=True)
        snap_path.write_text(json.dumps({"session_id": "session-A", "adapter_token": adapter.token,
                                         "estimate": 5000, "soft": 1000, "stage": "warn3",
                                         "reason": "nudged"}))
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "session-B"}))):
            with mock.patch.object(sys, "stdout", io.StringIO()) as buf:
                self.assertEqual(ha.hook_main(["--hook", "--token", adapter.token]), 0)
                self.assertEqual(buf.getvalue(), "")
        snap_path.write_text("{corrupt")
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "session-B"}))):
            with mock.patch.object(sys, "stdout", io.StringIO()) as buf:
                self.assertEqual(ha.hook_main(["--hook", "--token", adapter.token]), 0)
                self.assertEqual(buf.getvalue(), "")

    def test_storage_before_vs_after_hook(self):
        from openhands.sdk import Agent
        from openhands.sdk.hooks import HookManager

        a = HandoverAdapter(soft=1000)
        ca = make_conversation(a, a.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(ca, 700, 400, window=0, rid="ra")
        a.on_event(agent_message())
        wa = ca.agent._tools["context_handover"]  # noqa: SLF001
        wa(wa.action_type(handover="BEFORE", summary="b"), ca)
        first = json.loads(ha.handover_path(a.source_id).read_text())
        self.assertEqual(first["diagnostics"]["reason"], "not-nudged")
        b = HandoverAdapter(soft=1000)
        cb = make_conversation(b, b.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(cb, 700, 400, window=0, rid="rb")
        b.on_event(agent_message())
        HookManager(config=b.hook_config, working_dir=self.workspace(),
                    session_id=b.source_id).run_user_prompt_submit(message="hi")
        wb = cb.agent._tools["context_handover"]  # noqa: SLF001
        wb(wb.action_type(handover="AFTER", summary="a"), cb)
        second = json.loads(ha.handover_path(b.source_id).read_text())
        self.assertEqual(second["diagnostics"]["reason"], "nudged")

    def test_condensation_invalidates_until_new_response(self):
        from openhands.sdk import Agent
        from openhands.sdk.event import MessageEvent
        from openhands.sdk.event.condenser import Condensation
        from openhands.sdk.hooks import HookManager
        from openhands.sdk.llm import Message, TextContent

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="resp-1")
        adapter.on_event(agent_message())
        before = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual(before["stage"], "warn2")
        adapter.on_event(MessageEvent(source="environment", llm_message=Message(
            role="user", content=[TextContent(text="hook ctx")])) )
        self.assertEqual(json.loads(adapter._snapshot_file().read_text()), before)  # noqa: SLF001
        adapter.on_event(Condensation(forgotten_event_ids=[], llm_response_id="resp-1"))
        cleared = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((cleared["estimate"], cleared["stage"]), ("unknown", "unknown"))
        _, ctx, _ = HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                                session_id=adapter.source_id).run_user_prompt_submit(message="x")
        self.assertIsNone(ctx)
        adapter.on_event(agent_message("stale, no new usage"))
        still = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual(still["stage"], "unknown")
        add_usage(conv, 700, 400, window=0, rid="resp-2")
        adapter.on_event(agent_message("fresh response"))
        revived = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((revived["reason"], revived["stage"]), ("not-nudged", "warn2"))

    def test_two_instance_isolation(self):
        from openhands.sdk import Agent
        from openhands.sdk.hooks import HookManager

        a = HandoverAdapter(soft=1000)
        b = HandoverAdapter(soft=100000)
        ca = make_conversation(a, a.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        cb = make_conversation(b, b.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(ca, 700, 400, window=0, rid="ra")
        a.on_event(agent_message())
        add_usage(cb, 10, 5, window=0, rid="rb")
        b.on_event(agent_message())
        ma = HookManager(config=a.hook_config, working_dir=self.workspace(), session_id=a.source_id)
        mb = HookManager(config=b.hook_config, working_dir=self.workspace(), session_id=b.source_id)
        _, ctxa, _ = ma.run_user_prompt_submit(message="hi")
        _, ctxb, _ = mb.run_user_prompt_submit(message="hi")
        self.assertIsNotNone(ctxa)
        self.assertIsNone(ctxb)
        writer_a = ca.agent._tools["context_handover"]  # noqa: SLF001
        self.assertIn("Refused", obs_text(writer_a(writer_a.action_type(handover="X", summary="Y"), cb)))
        reader_b = cb.agent._tools["read_handover"]  # noqa: SLF001
        writer_a(writer_a.action_type(handover="SHARED", summary="s"), ca)
        out = obs_text(reader_b(reader_b.action_type(sessionID=a.source_id), cb))
        self.assertIn("SHARED", out)  # any bound caller reads any retained target

    def test_reload_resets_snapshot_persists_handover(self):
        from openhands.sdk import Agent, Conversation

        a1 = HandoverAdapter(soft=1000)
        c1 = make_conversation(a1, a1.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        w1 = c1.agent._tools["context_handover"]  # noqa: SLF001
        w1(w1.action_type(handover="PERSIST-ME", summary="s"), c1)
        a2 = HandoverAdapter(soft=1000)
        c2 = Conversation(agent=a2.equip(Agent(llm=make_llm(), tools=[])), workspace=self.workspace(),
                          conversation_id=c1.id, callbacks=[a2.on_event], hook_config=a2.hook_config,
                          visualizer=None)
        a2.bind(c2)
        c2._ensure_agent_ready()
        snap = json.loads(a2._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual(snap["stage"], "unknown")
        reader = c2.agent._tools["read_handover"]  # noqa: SLF001
        out = obs_text(reader(reader.action_type(sessionID=str(c1.id)), c2))
        self.assertIn("PERSIST-ME", out)

    def test_existing_snapshot_diagnostics_recorded(self):
        from openhands.sdk import Agent

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        fresh = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((fresh["session_id"], fresh["stage"]), (adapter.source_id, "unknown"))
        add_usage(conv, 100, 50, window=0, rid="r1")
        adapter.on_event(agent_message())
        snap = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((snap["reason"], snap["stage"], snap["estimate"]), ("not-nudged", "ok", 150))

    def test_reader_seed_warning(self):
        from openhands.sdk import Agent

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="r-big")
        adapter.on_event(agent_message())
        writer = conv.agent._tools["context_handover"]  # noqa: SLF001
        writer(writer.action_type(handover="x" * 3000, summary="big"), conv)
        reader = conv.agent._tools["read_handover"]  # noqa: SLF001
        out = obs_text(reader(reader.action_type(sessionID=adapter.source_id), conv))
        self.assertIn("exceeds 50%", out)
        self.assertIn("compress at the next handover instead", out)
        adapter2 = HandoverAdapter(soft=100000)
        conv2 = make_conversation(adapter2, adapter2.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        w2 = conv2.agent._tools["context_handover"]  # noqa: SLF001
        w2(w2.action_type(handover="tiny", summary="t"), conv2)
        r2 = conv2.agent._tools["read_handover"]  # noqa: SLF001
        self.assertNotIn("exceeds 50%", obs_text(r2(r2.action_type(sessionID=adapter2.source_id), conv2)))

    def test_intro_qualified_nudge_or_explicit_only(self):
        self.assertIn("Only after", ha.INTRO_TEXT)
        self.assertIn("nudge", ha.INTRO_TEXT.lower())
        self.assertIn("explicitly", ha.INTRO_TEXT)
        self.assertIn("normal final response", ha.INTRO_TEXT)
        self.assertIn("do not call context_handover", ha.INTRO_TEXT.lower())

    def test_hook_then_new_response_keeps_nudged_with_fresh_estimate(self):
        from openhands.sdk import Agent
        from openhands.sdk.hooks import HookManager

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="resp-1")
        adapter.on_event(agent_message())
        # Measurement itself must never claim nudged before hook output.
        self.assertEqual(adapter._diag["reason"], "not-nudged")  # noqa: SLF001
        self.assertEqual(adapter._snapshot_diag()["reason"], "not-nudged")  # noqa: SLF001
        mgr = HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                          session_id=adapter.source_id)
        ok, ctx, _ = mgr.run_user_prompt_submit(message="next")
        self.assertTrue(ok)
        self.assertIsNotNone(ctx)
        # New model response arrives after the hook, before the writer.
        add_usage(conv, 800, 400, window=0, rid="resp-2")
        adapter.on_event(agent_message("fresh response"))
        # Measurement stays not-nudged; provenance latch keeps writer truthful.
        self.assertEqual(adapter._diag["reason"], "not-nudged")  # noqa: SLF001
        self.assertTrue(adapter._nudged)  # noqa: SLF001
        diag = adapter._snapshot_diag()  # noqa: SLF001
        self.assertEqual(diag["reason"], "nudged")
        self.assertEqual(diag["estimate"], 1200)
        snap = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((snap["reason"], snap["estimate"]), ("nudged", 1200))
        writer = conv.agent._tools["context_handover"]  # noqa: SLF001
        writer(writer.action_type(handover="H", summary="S"), conv)
        stored = json.loads(ha.handover_path(adapter.source_id).read_text())
        self.assertEqual(stored["diagnostics"]["reason"], "nudged")
        self.assertEqual(stored["diagnostics"]["estimate"], 1200)

    def test_snapshot_write_failure_uses_memory_retries_and_invalidates(self):
        from openhands.sdk import Agent

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="r1")
        with mock.patch.object(ha, "_atomic_replace", side_effect=OSError("disk full")):
            with self.assertLogs("handover_adapter", level="WARNING"):
                adapter.on_event(agent_message())
        # Memory holds freshest measurement despite disk failure.
        self.assertEqual(adapter._diag["estimate"], 1100)  # noqa: SLF001
        diag = adapter._snapshot_diag()  # noqa: SLF001
        self.assertEqual((diag["estimate"], diag["stage"]), (1100, "warn2"))
        # Stale disk invalidated so the hook fails open instead of stale-nudging.
        self.assertFalse(adapter._snapshot_file().exists())  # noqa: SLF001
        # Same usage retries on the next event (seen_count was not advanced).
        adapter.on_event(agent_message("retry"))
        snap = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((snap["estimate"], snap["stage"]), (1100, "warn2"))

    def test_condensation_write_failure_invalidates_stale_snapshot(self):
        from openhands.sdk import Agent
        from openhands.sdk.event.condenser import Condensation
        from openhands.sdk.hooks import HookManager

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="resp-1")
        adapter.on_event(agent_message())
        HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                    session_id=adapter.source_id).run_user_prompt_submit(message="hi")
        self.assertEqual(json.loads(adapter._snapshot_file().read_text())["reason"], "nudged")  # noqa: SLF001
        with mock.patch.object(ha, "_atomic_replace", side_effect=OSError("disk full")):
            with self.assertLogs("handover_adapter", level="WARNING"):
                adapter.on_event(Condensation(forgotten_event_ids=[], llm_response_id="resp-1"))
        # Emission persists; metrics clear but reason stays nudged.
        self.assertEqual(adapter._diag["stage"], "unknown")  # noqa: SLF001
        self.assertTrue(adapter._nudged)  # noqa: SLF001
        diag = adapter._snapshot_diag()  # noqa: SLF001
        self.assertEqual((diag["estimate"], diag["stage"], diag["reason"]),
                         ("unknown", "unknown", "nudged"))
        _, ctx, _ = HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                                session_id=adapter.source_id).run_user_prompt_submit(message="x")
        self.assertIsNone(ctx)

    def test_hook_then_condensation_writer_stays_nudged_with_unknown_metrics(self):
        from openhands.sdk import Agent
        from openhands.sdk.event.condenser import Condensation
        from openhands.sdk.hooks import HookManager

        adapter = HandoverAdapter(soft=1000)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="resp-1")
        adapter.on_event(agent_message())
        HookManager(config=adapter.hook_config, working_dir=self.workspace(),
                    session_id=adapter.source_id).run_user_prompt_submit(message="hi")
        adapter.on_event(Condensation(forgotten_event_ids=[], llm_response_id="resp-1"))
        snap = json.loads(adapter._snapshot_file().read_text())  # noqa: SLF001
        self.assertEqual((snap["reason"], snap["estimate"], snap["stage"]),
                         ("nudged", "unknown", "unknown"))
        diag = adapter._snapshot_diag()  # noqa: SLF001
        self.assertEqual((diag["reason"], diag["estimate"], diag["stage"]),
                         ("nudged", "unknown", "unknown"))
        writer = conv.agent._tools["context_handover"]  # noqa: SLF001
        writer(writer.action_type(handover="H", summary="S"), conv)
        stored = json.loads(ha.handover_path(adapter.source_id).read_text())
        self.assertEqual(stored["diagnostics"]["reason"], "nudged")
        self.assertEqual((stored["diagnostics"]["estimate"], stored["diagnostics"]["stage"]),
                         ("unknown", "unknown"))

    def test_weak_registry_retention_documented(self):
        import weakref

        self.assertIsInstance(ha._ADAPTERS, weakref.WeakValueDictionary)
        self.assertIn("strong reference", ha.__doc__)
        self.assertIn("adapter.on_event", ha.__doc__)

    def test_existing_hooks_merge_preserved(self):
        from openhands.sdk import Agent
        from openhands.sdk.hooks import HookConfig, HookDefinition, HookMatcher, HookManager

        adapter = HandoverAdapter(soft=1000)
        user_cfg = HookConfig(user_prompt_submit=[
            HookMatcher(matcher="*", hooks=[HookDefinition(command="echo '{\"additionalContext\": \"USER-CTX\"}'")])])
        merged = HookConfig.merge([user_cfg, adapter.hook_config])
        self.assertEqual(len(merged.user_prompt_submit), 2)
        conv = make_conversation(adapter, adapter.equip(Agent(llm=make_llm(), tools=[])), self.workspace())
        add_usage(conv, 700, 400, window=0, rid="r9")
        adapter.on_event(agent_message())
        _, ctx, _ = HookManager(config=merged, working_dir=self.workspace(),
                                session_id=adapter.source_id).run_user_prompt_submit(message="hi")
        self.assertIn("USER-CTX", ctx)
        self.assertIn(ha.OPENCODE_WARN2, ctx)


if __name__ == "__main__":
    unittest.main(verbosity=2)
