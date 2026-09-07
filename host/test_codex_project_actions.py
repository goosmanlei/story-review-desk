import unittest
import hashlib
from types import SimpleNamespace
from codex_project_actions import ProjectActions, action_tool_specs, valid_turn_execution, PROTOCOL
from codex_work_context import ContextError, digest
from instance_aux import InstanceStorageError

def turn():
    return {"mode": "EXECUTE", "turnId": "turn_test", "conversationId": "codx_test", "requestHash": "a" * 64,
            "assistantContext": {"packetId": "ctx", "packetHash": "b" * 64},
            "execution": {"protocol": PROTOCOL, "instanceId": "instance-test", "runtimeEpoch": "epoch-test",
                "baseReleaseId": "release-test", "allowedActions": ["inspect_settings", "save_settings_draft"]}}

class ProjectActionTest(unittest.TestCase):
    def claim(self):
        return {"turnId": "turn_test", "conversationId": "codx_test", "bridgeInstanceId": "bridge", "slotId": "slot", "leaseId": "lease", "fencingToken": 9}

    def request(self, call_id="call-a", action="inspect_settings"):
        return {"namespace": "review_actions", "tool": "workspace_action", "callId": call_id, "arguments": {"action": action, "input": {}}}

    def test_mode_and_specs(self):
        self.assertTrue(valid_turn_execution({}))
        self.assertEqual(action_tool_specs({}), [])
        for mode in [None, True, "execute", "SHELL"]:
            self.assertFalse(valid_turn_execution({"mode": mode}))
        specs = action_tool_specs(turn())
        self.assertEqual(specs[0]["name"], "review_actions")
        self.assertNotIn("publish_settings", specs[0]["tools"][0]["inputSchema"]["properties"]["action"]["enum"])

    def test_denied_mode_and_arbitrary_tool_never_invoke_transport(self):
        calls = []
        instance = SimpleNamespace(project_action=lambda value: calls.append(value))
        with self.assertRaises(ContextError):
            ProjectActions(instance, {}, self.claim()).tool_call(self.request())
        actions = ProjectActions(instance, turn(), self.claim())
        with self.assertRaises(ContextError):
            actions.tool_call(self.request(action="generate_image"))
        with self.assertRaises(ContextError):
            actions.tool_call({**self.request(), "namespace": "functions", "tool": "exec"})
        self.assertEqual(calls, [])

    def test_actual_receipt_binding_and_idempotency(self):
        calls = []
        def execute(value):
            calls.append(value)
            result = {"revisionId": "revision-result"}
            return {"receipt": {"protocol": PROTOCOL, "turnId": "turn_test", "instanceId": "instance-test",
                    "runtimeEpoch": "epoch-test", "status": "SUCCEEDED", "operationId": "assistant_action_" + hashlib.sha256((value["turnId"] + ":" + value["callId"]).encode()).hexdigest(), "action": value["action"], "mutated": False, "resultHash": digest(result)}, "result": result}
        actions = ProjectActions(SimpleNamespace(project_action=execute), turn(), self.claim())
        first = actions.tool_call(self.request())
        self.assertTrue(first["success"])
        self.assertEqual(actions.tool_call(self.request()), first)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["turnId"], "turn_test")
        self.assertEqual(calls[0]["claim"]["fencingToken"], 9)
        with self.assertRaises(ContextError):
            actions.tool_call(self.request(action="save_settings_draft"))

    def test_unknown_outcome_stops_all_followup_actions(self):
        calls = []
        def fail(value):
            calls.append(value)
            raise InstanceStorageError("transport timed out")
        actions = ProjectActions(SimpleNamespace(project_action=fail), turn(), self.claim())
        result = actions.tool_call(self.request())
        self.assertFalse(result["success"])
        self.assertEqual(actions.tool_call(self.request()), result)
        with self.assertRaisesRegex(ContextError, "停止"):
            actions.tool_call(self.request(call_id="different"))
        self.assertEqual(len(calls), 1)
        self.assertTrue(actions.uncertain)

if __name__ == "__main__":
    unittest.main()
