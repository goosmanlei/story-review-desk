"""Zero-billing app-server contract check for domain tools and image payloads."""
from __future__ import annotations

import asyncio
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import struct
import zlib
from typing import Any

from codex_runtime_adapter import CodexRuntimeAdapter
from codex_work_context import WorkContext, canonical_json, digest, tool_specs

def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


FIXTURE_PNG = (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
               + _png_chunk(b"IDAT", zlib.compress((b"\x00" + b"\x22\x66\xbb" * 32) * 32))
               + _png_chunk(b"IEND", b""))


def write_fixture(root: Path, *, project_id: str = "REVIEW_FIXTURE", initial: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
    store = root / "store"
    for directory in (store / "contexts", store / "catalogs", root / "production" / "generated"):
        directory.mkdir(parents=True, exist_ok=True)
    (root / "production" / "generated" / "fixture.png").write_bytes(FIXTURE_PNG)
    text = "Fixture context: the image is a 32-pixel square test artifact. This text is current evidence."
    resource = {"id": "fixture:image", "title": "图片测试资料", "kind": "material", "versionId": "fixture-v1", "sha256": hashlib.sha256(text.encode()).hexdigest(), "text": text, "href": "/?fixture=1", "role": "CURRENT", "relations": [], "media": {"kind": "image", "path": "production/generated/fixture.png", "sha256": hashlib.sha256(FIXTURE_PNG).hexdigest(), "mimeType": "image/png"}}
    catalog = {"schemaVersion": "1.0", "projectId": project_id, "scopeKey": "local:" + project_id, "snapshotId": "fixture-snapshot", "resources": [resource]}
    catalog_hash = digest(catalog)
    (store / "catalogs" / f"{catalog_hash}.json").write_text(canonical_json(catalog))
    body = {"schemaVersion": "1.0", "projectId": project_id, "scopeKey": "local:" + project_id, "snapshotId": "fixture-snapshot", "focus": {"kind": "material", "subjectId": "fixture:image"}, "focusKey": "fixture-focus", "dependencyHash": digest(resource), "catalogHash": catalog_hash, "initialResourceIds": [resource["id"]] if initial else [], "draftTargets": [{"id": "fixture-draft", "label": "测试草稿", "fieldId": "comment", "subjectId": "fixture:image", "versionId": "fixture-v1", "value": "", "baseHash": hashlib.sha256(b"").hexdigest()}], "missing": []}
    packet_hash = digest(body)
    packet = {"packetId": "ctx_" + packet_hash, "packetHash": packet_hash, "body": body}
    (store / "contexts" / (packet["packetId"] + ".json")).write_text(canonical_json(packet))
    turn = {"schemaVersion": "1.0", "schedulerProtocol": "REVIEW_CODEX_SCHEDULER_V1", "turnId": "turn_" + "9" * 32, "conversationId": "codx_" + "8" * 32, "projectId": project_id, "snapshotId": "fixture-snapshot", "sequence": 1, "previousTurnHeadHash": "a" * 64, "capabilityProfile": "READ_ONLY_ADVICE", "userMessage": "检查测试图，并给出建议草稿。", "requestHash": "b" * 64, "idempotencyKeyHash": "c" * 64, "queuedAt": "2026-01-01T00:00:00Z", "assistantContext": {key: packet[key] for key in ("packetId", "packetHash")}}
    return turn, catalog


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.hold_next = False
        self.held_request = threading.Event()
        self.release_request = threading.Event()


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:
        size = int(self.headers.get("Content-Length", "-1"))
        if self.path != "/v1/responses" or not 0 <= size <= 8 * 1024 * 1024:
            self.send_error(400)
            return
        body = json.loads(self.rfile.read(size))
        with self.server.lock:
            self.server.requests.append(body)
            index = len(self.server.requests)
        if self.server.hold_next:
            self.server.held_request.set()
            self.server.release_request.wait(timeout=8)
        steps = [
            ("search_project", {"query": "图片测试", "limit": 3}),
            ("read_resources", {"resourceIds": ["fixture:image"]}),
            ("view_image", {"resourceId": "fixture:image"}),
        ]
        response_id = f"resp_work_preflight_{index}"
        if index <= len(steps):
            name, arguments = steps[index - 1]
            item = {"type": "function_call", "id": f"fc_work_preflight_{index}", "call_id": f"call_work_preflight_{index}", "name": name, "namespace": "review_context", "arguments": canonical_json(arguments), "status": "completed"}
        else:
            answer = {"answer": "work context preflight ok", "evidence": [{"path": "resource:fixture:image", "note": "本轮实际读取的测试图资料"}], "unknowns": [], "suggestions": [{"targetId": "fixture-draft", "text": "测试建议草稿"}]}
            item = {"type": "message", "id": "msg_work_preflight", "role": "assistant", "content": [{"type": "output_text", "text": canonical_json(answer)}]}
        events = [
            {"type": "response.created", "response": {"id": response_id}},
            {"type": "response.output_item.done", "item": item},
            {"type": "response.completed", "response": {"id": response_id, "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}},
        ]
        payload = "".join("data: " + canonical_json(event) + "\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except BrokenPipeError:
            pass
        self.close_connection = True


def provider_tool_names(tools: Any) -> set[str]:
    def runtime_schema(value: Any) -> Any:
        # app-server 0.153.4 normalizes these unsupported JSON-schema keywords.
        # The domain dispatcher independently enforces every bound before I/O.
        if isinstance(value, dict):
            return {key: runtime_schema(item) for key, item in value.items()
                    if key not in {"minimum", "maximum", "maxLength", "maxItems"}}
        if isinstance(value, list):
            return [runtime_schema(item) for item in value]
        return value

    if not isinstance(tools, list):
        return set()
    names: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict):
            raise ValueError("invalid tool")
        if tool.get("type") == "namespace" and tool.get("name") == "review_context":
            expected = {item["name"]: item for item in tool_specs()[0]["tools"]}
            for child in tool.get("tools", []):
                if child.get("type") != "function":
                    raise ValueError("non-function domain tool")
                spec = expected.get(child.get("name"))
                if not spec or child.get("parameters") != runtime_schema(spec["inputSchema"]) or child.get("description") != spec["description"] or child.get("strict") is not False:
                    raise ValueError("domain tool schema mismatch")
                names.append("review_context." + child.get("name", ""))
        else:
            raise ValueError("unexpected generic tool")
    if len(names) != 3 or len(set(names)) != 3:
        raise ValueError("domain tool count mismatch")
    return set(names)


async def run_preflight(worker: Any, bridge: Any) -> dict[str, Any]:
    from openai_codex import CodexConfig

    server = FixtureServer()
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        fixture_parent = bridge.INSTANCE.root / "runtime" if bridge.INSTANCE and worker.project_root == bridge.INSTANCE.root else worker.private_state_root
        with tempfile.TemporaryDirectory(prefix=".work-context-preflight-", dir=fixture_parent) as temporary:
            root = Path(temporary)
            turn, _catalog = write_fixture(root, project_id=worker.project_id)
            context = WorkContext(root, root / "store", turn, project_id=worker.project_id)
            private = bridge.ensure_private_state(root / "private")
            model_catalog = bridge.write_safe_model_catalog(private, worker.model)
            overrides = bridge.CONFIG_OVERRIDES + (f"sqlite_home={json.dumps(str(private['sqlite']))}", f"model_catalog_json={json.dumps(str(model_catalog))}") + bridge.preflight_provider_overrides(server.server_port)
            with bridge.isolated_codex_home(None, private) as isolated_home:
                runtime = CodexRuntimeAdapter(CodexConfig(codex_bin=str(worker.codex_binary), cwd=str(root), env=bridge.sanitized_child_environment(isolated_home), config_overrides=overrides, client_name="review_work_preflight", client_title="Review Work Preflight"))
                try:
                    await asyncio.wait_for(runtime.__aenter__(), 15)
                    await asyncio.wait_for(bridge.inspect_runtime_isolation(runtime, isolated_home, root, worker.model, expected_model_provider=bridge.PREFLIGHT_PROVIDER_ID), 15)

                    async def handler(params: dict[str, Any]) -> dict[str, Any]:
                        return await asyncio.to_thread(context.tool_call, params)

                    runtime.tool_handler = handler
                    thread = await asyncio.wait_for(runtime.thread_start(cwd=str(root), model=worker.model, ephemeral=True, model_provider=bridge.PREFLIGHT_PROVIDER_ID, developer_instructions=bridge.WORK_DEVELOPER_INSTRUCTIONS, dynamic_tools=tool_specs()), 15)
                    handle = await asyncio.wait_for(thread.turn(context.initial_prompt([]), model=worker.model, output_schema=bridge.WORK_OUTPUT_SCHEMA), 15)
                    result = await asyncio.wait_for(handle.run(), 30)
                    answer = json.loads(result.final_response)
                    context.result_binding(answer["evidence"], answer["suggestions"])
                    if answer["answer"] != "work context preflight ok" or context.tool_calls != 3 or context.image_ids != {"fixture:image"}:
                        raise ValueError("tool sequence did not complete")
                    server.hold_next = True
                    cancelled_thread = await asyncio.wait_for(runtime.thread_start(cwd=str(root), model=worker.model, ephemeral=True, model_provider=bridge.PREFLIGHT_PROVIDER_ID, developer_instructions=bridge.WORK_DEVELOPER_INSTRUCTIONS, dynamic_tools=tool_specs()), 15)
                    cancelled_handle = await asyncio.wait_for(cancelled_thread.turn("Local cancellation protocol test", model=worker.model, output_schema=bridge.WORK_OUTPUT_SCHEMA), 15)
                    if not await asyncio.to_thread(server.held_request.wait, 3):
                        raise ValueError("cancellation test did not reach local provider")
                    try:
                        await asyncio.wait_for(cancelled_handle.interrupt(), 5)
                        cancelled_result = await asyncio.wait_for(cancelled_handle.run(), 5)
                        if cancelled_result.status != "interrupted":
                            raise ValueError("runtime interruption was not confirmed")
                    finally:
                        server.release_request.set()
                finally:
                    await asyncio.wait_for(runtime.close(), 5)
            if len(server.requests) != 5:
                raise ValueError("unexpected provider request count")
            expected_names = {"review_context.search_project", "review_context.read_resources", "review_context.view_image"}
            for request in server.requests:
                if request.get("model") != worker.model or provider_tool_names(request.get("tools")) != expected_names:
                    raise ValueError("provider model or tools drifted")
            image_url = "data:image/png;base64," + base64.b64encode(FIXTURE_PNG).decode()
            if image_url not in canonical_json(server.requests[3].get("input")):
                raise ValueError("original image bytes did not reach provider input")
            return {"workContextProtocol": "REVIEW_WORK_CONTEXT_V1", "workContextPreflightVerified": True, "workContextProviderRequestCount": 5, "domainTools": sorted(expected_names), "genericTools": [], "originalImagePayloadVerified": True, "workContextCancelVerified": True}
    except Exception as error:
        raise bridge.BridgeError("WORK_CONTEXT_PREFLIGHT_FAILED", f"工作上下文工具安全预检失败：{type(error).__name__}") from error
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
