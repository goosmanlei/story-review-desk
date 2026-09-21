"""Build an inspectable, bounded AI context before any remote request."""

import json
import os
from urllib.request import Request, urlopen

from .framework import stage
from .store import canonical, digest


def build_context(store, source_id, anchor, draft, target_object_id=None, target_revision_id=None):
    draft = str(draft or "").strip()
    if not 1 <= len(draft) <= 2000:
        raise ValueError("comment draft must be 1-2000 characters")
    if target_object_id == "story-structure":
        target = store.validate_target(target_object_id, target_revision_id, anchor)
        from .structure import revision_record
        revision = revision_record(store, target_revision_id)
        selection = revision_record(store, revision["payload"]["direction_selection_revision"])
        source = store.source(selection["payload"]["source_id"])
        project = store.configuration("PROJECT")
        system = store.configuration("SYSTEM")
        current_stage = stage(project["body"]["current_stage"])
        blocks = target["blocks"]
        index = next((i for i, block in enumerate(blocks) if block["id"] == anchor.get("block_id")), 0)
        visual = next((v for v in target["visuals"] if v["id"] == anchor.get("visual_id")), None)
        source_text = "\n".join(b["text"] for b in source["blocks"])
        context = {"creative_stage": current_stage, "project_configuration_version": project["version"],
                   "story_background": project["body"]["story_background"], "creative_background": project["body"]["creative_background"],
                   "target_medium": project["body"]["target_medium"], "audience": project["body"]["audience"], "style": project["body"]["style"],
                   "selected_source_id": source["id"], "selected_quote": anchor.get("quote", ""),
                   "neighbor_blocks": blocks[max(0, index - 1):index + 3],
                   "source_documents": [{"id": source["id"], "title": source["title"], "version_type": source["version_type"], "origin": source["origin"], "source_url": source["source_url"], "revision": selection["payload"]["source_revision"], "text": source_text[:system["body"]["ai_context_max_chars"]], "truncated": len(source_text) > system["body"]["ai_context_max_chars"]}],
                   "structure_revision": target_revision_id, "structure_title": revision["payload"]["title"],
                   "visual": visual, "region_points": anchor.get("points"), "comment_draft": draft}
        return {"context": context, "context_sha256": digest(canonical(context).encode()),
                "model": system["body"]["ai_polish_model"], "reasoning_effort": system["body"]["ai_polish_effort"],
                "api_key_env_name": system["body"]["ai_polish_api_key_env"], "saved": False}
    source_object = next((item for item in store.objects() if item["id"] == source_id), None)
    if not source_object:
        raise ValueError("unknown source")
    target = store.validate_target(source_id, source_object["current_revision"], anchor)
    source = target["source"]
    project = store.configuration("PROJECT")
    system = store.configuration("SYSTEM")
    current_stage = stage(project["body"]["current_stage"])
    documents = []
    budget = system["body"]["ai_context_max_chars"]
    for item in [source] + [s for s in store.sources() if s["id"] != source_id]:
        entire = "\n".join(block["text"] for block in item["blocks"])
        # The selected document has priority; other versions share the remainder.
        allowance = min(len(entire), budget if item["id"] == source_id else max(0, budget // max(2, len(store.sources()))))
        excerpt = entire[:allowance]
        budget -= len(excerpt)
        documents.append({"id": item["id"], "title": item["title"], "version_type": item["version_type"],
                          "origin": item["origin"], "source_url": item["source_url"],
                          "revision": digest(canonical(item).encode()), "text": excerpt,
                          "truncated": len(excerpt) < len(entire)})
    blocks = source["blocks"]
    index = next((i for i, block in enumerate(blocks) if block["id"] == anchor.get("block_id")), 0)
    neighbors = blocks[max(0, index - 1):min(len(blocks), index + 3)]
    context = {"creative_stage": current_stage, "project_configuration_version": project["version"],
               "story_background": project["body"]["story_background"],
               "creative_background": project["body"]["creative_background"],
               "target_medium": project["body"]["target_medium"], "audience": project["body"]["audience"],
               "style": project["body"]["style"], "selected_source_id": source_id,
               "selected_quote": anchor.get("quote", ""), "neighbor_blocks": neighbors,
               "visual": next((v for v in target["visuals"] if v.get("id", v.get("file")) == anchor.get("visual_id")), None),
               "region_points": anchor.get("points"),
               "source_documents": documents, "comment_draft": draft}
    return {"context": context, "context_sha256": digest(canonical(context).encode()),
            "model": system["body"]["ai_polish_model"], "reasoning_effort": system["body"]["ai_polish_effort"],
            "api_key_env_name": system["body"]["ai_polish_api_key_env"], "saved": False}


def suggest(preview):
    env_name = preview["api_key_env_name"]
    key = os.environ.get(env_name)
    if not key:
        raise RuntimeError(f"AI 润色未配置：服务容器需设置 {env_name}")
    effort = preview["reasoning_effort"]
    payload = {"model": preview["model"], "store": False, "max_output_tokens": 300 if effort in ("off", "none") else 2048,
               "instructions": "你是中文故事创作资料审阅意见的措辞助手。背景、阶段、原文上下文和不同版本资料只供理解原意见；输出必须严格限于改写用户评论草稿，不得新增事实、推断、注释建议、研究任务或创作要求。不要改变原意。UNKNOWN 不得补成结论。只输出一段建议正文，不加标题。",
               "input": canonical(preview["context"])}
    if effort != "off":
        payload["reasoning"] = {"effort": effort}
    request = Request("https://api.openai.com/v1/responses", data=json.dumps(payload, ensure_ascii=False).encode(),
                      headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    suggestion = "".join(part.get("text", "") for item in result.get("output", [])
                         for part in item.get("content", []) if part.get("type") == "output_text").strip()
    if not suggestion:
        raise ValueError("AI 润色未返回文本")
    return {"suggestion": suggestion, "saved": False, "context_sha256": preview["context_sha256"]}
