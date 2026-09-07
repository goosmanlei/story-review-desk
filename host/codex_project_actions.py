"""Explicit per-turn project actions. No shell, arbitrary paths or model calls."""
from __future__ import annotations
from typing import Any
import hashlib
from codex_work_context import ContextError, canonical_json, digest, bounded_text
from instance_aux import InstanceStorageError

PROTOCOL = "REVIEW_CONTROLLED_ACTIONS_V1"
DRAFT_ACTIONS = {"inspect_settings", "save_settings_draft", "preview_settings_draft", "inspect_preparation", "save_preparation_scene", "preview_preparation_revalidation", "apply_preparation_revalidation"}
ACTIONS = DRAFT_ACTIONS | {"publish_settings"}
NAMESPACE = "review_actions"

def valid_turn_execution(turn: dict[str, Any]) -> bool:
    mode = turn.get("mode", "DISCUSS")
    if mode == "DISCUSS":
        return "execution" not in turn
    grant = turn.get("execution")
    return bool(mode == "EXECUTE" and turn.get("assistantContext") and isinstance(grant, dict)
        and set(grant) == {"protocol", "instanceId", "runtimeEpoch", "baseReleaseId", "allowedActions"}
        and grant["protocol"] == PROTOCOL
        and all(isinstance(grant[key], str) and 0 < len(grant[key]) <= 300 for key in ("instanceId", "runtimeEpoch", "baseReleaseId"))
        and isinstance(grant["allowedActions"], list) and 0 < len(grant["allowedActions"]) <= len(ACTIONS)
        and all(isinstance(action, str) and action in ACTIONS for action in grant["allowedActions"])
        and len(set(grant["allowedActions"])) == len(grant["allowedActions"]))

def action_tool_specs(turn: dict[str, Any]) -> list[dict[str, Any]]:
    if turn.get("mode", "DISCUSS") != "EXECUTE":
        return []
    if not valid_turn_execution(turn):
        raise ContextError("EXECUTION_INVALID", "本轮执行授权无效")
    return [{"type": "namespace", "name": NAMESPACE, "description": "只按用户本轮EXECUTE授权调用本项目受控动作。禁止删除、任意路径、外部服务、素材Review和生成。",
        "tools": [{"type": "function", "name": "workspace_action",
        "description": "先inspect读取永久身份和CAS。inspect_settings接受collection/entities|states|representations|relations及id或offset；save_settings_draft接受expectedReleaseId、expectedDraftRevisionId、changes[{collection,id,beforeHash,value}]，仅新增/修改；preview_settings_draft接受draftRevisionId；publish_settings还需要previewHash，必须在本轮实际预览且用户明确允许发布。inspect_preparation接受可选sceneId；save_preparation_scene接受expectedReleaseId、expectedRevisionId、sceneId、fields，只更新作者准备字段。重核preview/apply接受expectedReleaseId/expectedRevisionId/expectedLinksRevisionId/expectedDirectoryRevisionId/candidateRevisionId/candidateContentHash/sceneUpdates/materialUpdates，apply另需本轮previewHash。成功只以receipt.operationId为证，失败或结果未知不自动重复。",
        "inputSchema": {"type": "object", "additionalProperties": False, "required": ["action", "input"],
            "properties": {"action": {"type": "string", "enum": turn["execution"]["allowedActions"]}, "input": {"type": "object", "additionalProperties": True}}}}]}]

class ProjectActions:
    def __init__(self, instance: Any, turn: dict[str, Any], claim: dict[str, Any]):
        if not valid_turn_execution(turn):
            raise ContextError("EXECUTION_INVALID", "本轮执行授权无效")
        self.instance, self.turn, self.claim = instance, turn, claim
        self.replays: dict[str, tuple[str, dict[str, Any]]] = {}
        self.receipts: list[dict[str, Any]] = []
        self.uncertain = False

    def tool_call(self, params: dict[str, Any]) -> dict[str, Any]:
        if self.turn.get("mode", "DISCUSS") != "EXECUTE" or self.instance is None:
            raise ContextError("EXECUTION_REQUIRED", "本轮仅讨论，没有主机执行授权")
        if params.get("namespace") != NAMESPACE or params.get("tool") != "workspace_action":
            raise ContextError("TOOL_NOT_ALLOWED", "不支持该项目操作工具")
        call_id = bounded_text(params.get("callId"), "callId", 200)
        arguments = params.get("arguments")
        if not isinstance(arguments, dict) or set(arguments) != {"action", "input"} or arguments["action"] not in self.turn["execution"]["allowedActions"] or not isinstance(arguments["input"], dict):
            raise ContextError("EXECUTION_DENIED", "操作超出本轮白名单")
        hashed = digest(arguments)
        if call_id in self.replays:
            previous_hash, response = self.replays[call_id]
            if previous_hash != hashed:
                raise ContextError("TOOL_CALL_CONFLICT", "重复操作身份不能更换参数")
            return response
        if self.uncertain:
            raise ContextError("ACTION_RESULT_UNKNOWN", "上一操作结果需要核查，本轮停止继续执行")
        if len(self.replays) >= 32:
            raise ContextError("EXECUTION_LIMIT", "本轮操作达到上限")
        try:
            value = self.instance.project_action({"turnId": self.turn["turnId"], "conversationId": self.turn["conversationId"],
                "requestHash": self.turn["requestHash"], "claim": {key: self.claim[key] for key in ("turnId", "conversationId", "bridgeInstanceId", "slotId", "leaseId", "fencingToken")},
                "callId": call_id, "action": arguments["action"], "arguments": arguments["input"]})
            receipt = value.get("receipt")
            if not isinstance(receipt, dict) or receipt.get("protocol") != PROTOCOL or receipt.get("turnId") != self.turn["turnId"] or receipt.get("instanceId") != self.turn["execution"]["instanceId"] or receipt.get("runtimeEpoch") != self.turn["execution"]["runtimeEpoch"] or receipt.get("status") != "SUCCEEDED" or receipt.get("action") != arguments["action"] or receipt.get("operationId") != "assistant_action_" + hashlib.sha256((self.turn["turnId"] + ":" + call_id).encode("utf-8")).hexdigest() or not isinstance(receipt.get("mutated"), bool) or receipt.get("resultHash") != digest(value.get("result")):
                raise ContextError("EXECUTION_RECEIPT_INVALID", "操作回执未通过精确绑定校验")
            self.receipts.append(receipt)
            response = {"success": True, "contentItems": [{"type": "inputText", "text": canonical_json(value)}]}
        except (InstanceStorageError, TimeoutError) as error:
            self.uncertain = True
            # Unknown transport outcome is never automatically repeated. The same
            # call is cached; inspect the persisted operation ledger to reconcile.
            response = {"success": False, "contentItems": [{"type": "inputText", "text": canonical_json({"error": "ACTION_REQUIRES_VERIFICATION", "message": str(error), "retryAllowed": False})}]}
        self.replays[call_id] = (hashed, response)
        return response
