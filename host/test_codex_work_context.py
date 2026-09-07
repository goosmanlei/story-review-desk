#!/usr/bin/env python3
"""Offline tests for frozen work context, original-image reads, and turn control."""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import codex_conversation_bridge as bridge
from codex_work_context import ContextError, WorkContext, canonical_json, digest, MAX_TEXT_CHARS
from codex_work_preflight import FIXTURE_PNG, write_fixture


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".work-context-test-", dir=Path(__file__).parent)
        self.root = Path(self.temporary.name)
        self.turn, self.catalog = write_fixture(self.root, initial=True)
        self.context = WorkContext(self.root, self.root / "store", self.turn)

    def tearDown(self):
        self.temporary.cleanup()

    def test_initial_context_and_citations_are_exact(self):
        prompt = self.context.initial_prompt([])
        self.assertIn(self.catalog["resources"][0]["text"], prompt)
        binding = self.context.result_binding([{"path": "resource:fixture:image", "note": "资料"}], [{"targetId": "fixture-draft", "text": "新草稿"}])
        self.assertEqual(binding["evidenceIds"], ["fixture:image"])
        self.assertEqual(binding["observedImageIds"], [])
        with self.assertRaises(ContextError):
            self.context.result_binding([{ "path": "resource:unread", "note": "不应允许"}], [])
        with self.assertRaises(ContextError):
            self.context.result_binding([], [{"targetId": "another-target", "text": "不应允许"}])

    def test_search_does_not_count_as_reading(self):
        matches = self.context.search("图片测试")["matches"]
        self.assertEqual(set(matches[0]), {"id", "title", "kind", "role", "sha256", "characterCount"})
        self.assertNotIn(self.catalog["resources"][0]["text"], canonical_json(matches))
        self.assertEqual(self.context.read_ids, set())
        with self.assertRaises(ContextError):
            self.context.result_binding([{ "path": "resource:fixture:image", "note": "尚未读过"}], [])

    def test_history_requires_an_explicit_resource_reference(self):
        resource = {**self.catalog["resources"][0], "id": "fixture:history", "role": "HISTORICAL"}
        self.context.resources[resource["id"]] = resource
        matches = self.context.search("图片测试")["matches"]
        self.assertNotIn("fixture:history", [item["id"] for item in matches])
        self.context.read_resources(["fixture:history"])
        self.assertEqual(self.context.read_ids, {"fixture:history"})

    def test_initial_context_accepts_48_but_tool_batch_stays_8(self):
        packet_path = self.root / "store" / "contexts" / (self.turn["assistantContext"]["packetId"] + ".json")
        packet = json.loads(packet_path.read_text())
        catalog = {**self.catalog, "resources": [{**self.catalog["resources"][0], "id": f"fixture:item-{index}"} for index in range(48)]}
        packet["body"]["catalogHash"] = digest(catalog)
        packet["body"]["initialResourceIds"] = [item["id"] for item in catalog["resources"]]
        packet["packetHash"] = digest(packet["body"])
        packet["packetId"] = "ctx_" + packet["packetHash"]
        (self.root / "store" / "catalogs" / (digest(catalog) + ".json")).write_text(canonical_json(catalog))
        (self.root / "store" / "contexts" / (packet["packetId"] + ".json")).write_text(canonical_json(packet))
        turn = {**self.turn, "assistantContext": {key: packet[key] for key in ("packetId", "packetHash")}}
        context = WorkContext(self.root, self.root / "store", turn)
        context.initial_prompt([])
        self.assertEqual(len(context.read_ids), 48)
        response = context.tool_call({"callId": "too-many-resources", "namespace": "review_context", "tool": "read_resources", "arguments": {"resourceIds": packet["body"]["initialResourceIds"][:9]}})
        self.assertFalse(response["success"])

    def test_combined_text_and_image_read_limit_is_100(self):
        for index in range(101):
            self.context.resources[f"fixture:item-{index}"] = {**self.catalog["resources"][0], "id": f"fixture:item-{index}"}
        ids = [f"fixture:item-{index}" for index in range(100)]
        self.context.read_resources(ids[:48])
        self.context.read_resources(ids[48:96])
        self.context.read_resources(ids[96:])
        self.assertEqual(len(self.context.read_ids), 100)
        for tool, arguments in [("read_resources", {"resourceIds": [ids[0], "fixture:item-100"]}), ("view_image", {"resourceId": "fixture:image"})]:
            response = self.context.tool_call({"callId": "limit-" + tool, "namespace": "review_context", "tool": tool, "arguments": arguments})
            self.assertFalse(response["success"])
            self.assertEqual(json.loads(response["contentItems"][0]["text"])["error"], "RESOURCE_BUDGET_EXCEEDED")
            self.assertEqual(len(self.context.read_ids), 100)
        self.assertEqual(self.context.image_ids, set())
        self.context.view_image(ids[0])
        self.assertEqual(len(self.context.read_ids), 100)
        self.assertEqual(self.context.image_ids, {ids[0]})

    def test_catalog_and_packet_tampering_fail(self):
        packet_path = self.root / "store" / "contexts" / (self.turn["assistantContext"]["packetId"] + ".json")
        packet = json.loads(packet_path.read_text())
        packet["body"]["focusKey"] = "attacker-focus"
        packet_path.write_text(canonical_json(packet))
        with self.assertRaisesRegex(ContextError, "哈希"):
            WorkContext(self.root, self.root / "store", self.turn)

    def test_project_scope_comes_from_host_configuration(self):
        turn, _ = write_fixture(self.root, project_id="SECOND")
        with self.assertRaises(ContextError):
            WorkContext(self.root, self.root / "store", turn)
        context = WorkContext(self.root, self.root / "store", turn, project_id="SECOND")
        self.assertEqual(context.body["scopeKey"], "local:SECOND")

    def test_original_image_bytes_and_hash_are_bound(self):
        response = self.context.view_image("fixture:image")
        self.assertTrue(response["success"])
        self.assertTrue(response["contentItems"][1]["imageUrl"].startswith("data:image/png;base64,"))
        self.assertEqual(self.context.image_ids, {"fixture:image"})
        (self.root / "production/generated/fixture.png").write_bytes(FIXTURE_PNG + b"changed")
        with self.assertRaisesRegex(ContextError, "SHA-256"):
            self.context.view_image("fixture:image")

    def test_image_path_escape_and_symlink_fail(self):
        self.context.resources["fixture:image"]["media"]["path"] = "production/generated/../../secret.png"
        with self.assertRaises(ContextError):
            self.context.view_image("fixture:image")
        self.context.resources["fixture:image"]["media"]["path"] = "production/generated/link.png"
        (self.root / "production/generated/link.png").symlink_to(self.root / "production/generated/fixture.png")
        with self.assertRaises(ContextError):
            self.context.view_image("fixture:image")

    def test_tool_calls_are_idempotent_and_restricted(self):
        call = {"callId": "fixture-call-1", "namespace": "review_context", "tool": "read_resources", "arguments": {"resourceIds": ["fixture:image"]}}
        first = self.context.tool_call(call)
        self.assertEqual(self.context.tool_call(call), first)
        self.assertEqual(self.context.tool_calls, 1)
        with self.assertRaises(ContextError):
            self.context.tool_call({**call, "arguments": {"resourceIds": ["unknown"]}})
        with self.assertRaises(ContextError):
            self.context.tool_call({**call, "callId": "fixture-call-2", "tool": "exec"})

    def test_text_budget_never_silently_truncates(self):
        self.context.resources["fixture:image"]["text"] = "x" * (MAX_TEXT_CHARS + 1)
        with self.assertRaisesRegex(ContextError, "上限"):
            self.context.read_resources(["fixture:image"])
        self.assertEqual(self.context.read_ids, set())


    def test_lazy_source_search_is_not_a_read_and_exact_body_is_counted(self):
        text="冻结来源🙂"
        raw=text.encode("utf-8")
        resource={**self.catalog["resources"][0],"id":"source:test:chunk:00000","kind":"SOURCE_DOCUMENT_CHUNK","text":"目录","versionId":"revision:test"}
        resource.pop("media",None)
        resource["sourceBinding"]={"schemaVersion":"1.0","releaseId":"release:test","documentId":"document:test","revisionId":"revision:test","sha256":hashlib.sha256(raw).hexdigest(),"byteSize":len(raw),"byteStart":0,"byteEnd":len(raw)}
        self.context.resources[resource["id"]]=resource
        reads=[]
        def source_chunk(catalog_hash,resource_id):
            reads.append(resource_id)
            return {"resourceId":resource_id,"sourceText":text,"sourceTextSha256":hashlib.sha256(raw).hexdigest(),"sourceSha256":resource["sourceBinding"]["sha256"],"revisionId":"revision:test","byteStart":0,"byteEnd":len(raw),"byteSize":len(raw)}
        self.context.instance=SimpleNamespace(source_chunk=source_chunk,search_sources=lambda *args:{"matches":[{"id":resource["id"],"score":1}]})
        matches=self.context.search("冻结来源")
        self.assertTrue(matches["matches"])
        self.assertEqual(self.context.read_ids,set())
        self.assertEqual(reads,[])
        result=self.context.read_resources([resource["id"]])
        self.assertEqual(result["resources"][0]["sourceText"],text)
        self.assertEqual(self.context.text_chars,len(resource["text"])+len(text))
        self.context.read_resources([resource["id"]])
        self.assertEqual(reads,[resource["id"]])

    def test_search_cursor_is_bound_to_catalog_and_query(self):
        for index in range(3):
            self.context.resources["fixture:cursor-"+str(index)]={**self.catalog["resources"][0],"id":"fixture:cursor-"+str(index)}
        first=self.context.search("图片测试",1)
        self.assertTrue(first["nextCursor"])
        second=self.context.search("图片测试",1,first["nextCursor"])
        self.assertNotEqual(first["matches"][0]["id"],second["matches"][0]["id"])
        with self.assertRaises(ContextError):
            self.context.search("another query",1,first["nextCursor"])


class TurnTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".work-turn-test-", dir=Path(__file__).parent)
        self.root = Path(self.temporary.name)
        self.turn, self.catalog = write_fixture(self.root, initial=True)
        self.worker = bridge.BridgeWorker(project_root=self.root, store_root=self.root / "store", private_state_root=self.root / "private", codex_binary=None, auth_file=None, sdk="mock-sdk", runtime="mock-runtime", model=None, poll_seconds=0.1, timeout_seconds=30, mock_response="模拟：{message}")
        self.paths = self.worker.paths
        self.conversation = {"schemaVersion": "1.0", "projectId": self.turn["projectId"], "conversationId": self.turn["conversationId"], "snapshotId": self.turn["snapshotId"], "initialHeadHash": self.turn["previousTurnHeadHash"], "initialRequestHash": self.turn["requestHash"], "createdAt": self.turn["queuedAt"], "assistantProtocol": "1.0"}
        bridge.atomic_write_json(self.paths["conversations"] / f"{self.turn['conversationId']}.json", self.conversation)
        bridge.atomic_write_json(self.paths["turns"] / f"{self.turn['turnId']}.json", self.turn)

    async def asyncTearDown(self):
        self.temporary.cleanup()

    async def test_work_turn_result_hash_and_progress(self):
        await self.worker.process_turn_path(self.paths["turns"] / f"{self.turn['turnId']}.json")
        result = bridge.read_json_file(self.paths["results"] / f"{self.turn['turnId']}.json")
        self.assertEqual(result["state"], "SUCCEEDED")
        bridge.validate_public_result(result, self.turn)
        self.assertEqual(result["workContext"]["packetHash"], self.turn["assistantContext"]["packetHash"])
        self.assertNotIn("sdkThreadId", result)
        progress = bridge.read_json_file(self.paths["root"] / "progress" / f"{self.turn['turnId']}.json")
        self.assertEqual(progress["phase"], "RESPONDING")
        self.assertGreaterEqual(progress["sequence"], 2)
        mutated = {**result, "workContext": {**result["workContext"], "stale": True}}
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_public_result(mutated)

    async def test_queued_cancel_does_not_create_runtime_segment(self):
        bridge.atomic_write_json(self.paths["root"] / "cancel" / f"{self.turn['turnId']}.json", {"schemaVersion": "1.0", "turnId": self.turn["turnId"], "conversationId": self.turn["conversationId"], "requestHash": self.turn["requestHash"]})
        await self.worker.process_turn_path(self.paths["turns"] / f"{self.turn['turnId']}.json")
        result = bridge.read_json_file(self.paths["results"] / f"{self.turn['turnId']}.json")
        self.assertEqual(result["state"], "CANCELLED")
        self.assertFalse((self.root / "private/work-segments").exists())

    async def test_changed_snapshot_starts_fresh_segment_in_same_conversation(self):
        first_path = self.paths["turns"] / f"{self.turn['turnId']}.json"
        await self.worker.process_turn_path(first_path)
        first = bridge.read_json_file(self.paths["results"] / first_path.name)
        packet_path = self.paths["root"] / "contexts" / (self.turn["assistantContext"]["packetId"] + ".json")
        body = json.loads(packet_path.read_text())["body"]
        catalog = {**self.catalog, "snapshotId": "next-snapshot"}
        catalog_hash = digest(catalog)
        bridge.atomic_write_json(self.paths["root"] / "catalogs" / f"{catalog_hash}.json", catalog)
        body.update(snapshotId="next-snapshot", catalogHash=catalog_hash)
        packet_hash = digest(body)
        packet = {"packetId": "ctx_" + packet_hash, "packetHash": packet_hash, "body": body}
        bridge.atomic_write_json(self.paths["root"] / "contexts" / (packet["packetId"] + ".json"), packet)
        second_turn = {**self.turn, "turnId": "turn_" + "7" * 32, "sequence": 2, "snapshotId": "next-snapshot", "previousTurnHeadHash": first["turnHeadHash"], "assistantContext": {key: packet[key] for key in ("packetId", "packetHash")}}
        second_path = self.paths["turns"] / f"{second_turn['turnId']}.json"
        bridge.atomic_write_json(second_path, second_turn)
        await self.worker.process_turn_path(second_path)
        second = bridge.read_json_file(self.paths["results"] / second_path.name)
        self.assertEqual(second["state"], "SUCCEEDED")
        self.assertEqual(len(list((self.root / "private/work-segments").glob("*.json"))), 2)
        self.assertFalse(second["workContext"]["stale"])

    async def test_active_cancel_waits_for_interrupt_completion(self):
        done = asyncio.get_running_loop().create_future()
        calls = []

        class Handle:
            async def run(self):
                return await asyncio.shield(done)
            async def interrupt(self):
                calls.append("interrupt")
                done.set_result(SimpleNamespace(status="interrupted", final_response=""))
                return {}

        bridge.atomic_write_json(self.paths["root"] / "cancel" / f"{self.turn['turnId']}.json", {"schemaVersion": "1.0", "turnId": self.turn["turnId"], "conversationId": self.turn["conversationId"], "requestHash": self.turn["requestHash"]})
        with self.assertRaises(bridge.BridgeError) as caught:
            await self.worker.run_work_handle(Handle(), self.turn)
        self.assertEqual(caught.exception.code, "WORK_TURN_CANCELLED")
        self.assertEqual(calls, ["interrupt"])
        self.assertFalse(self.worker.runtime_poisoned)


if __name__ == "__main__":
    unittest.main()
