"""Exact, purpose-specific reference selection with one serialized-input budget."""

import json
import os
import re
from urllib.request import Request, urlopen

from .framework import stage
from .store import canonical, digest, Conflict
from .structure import revision_record, SELECTION_ID


COMPARISON = re.compile(r"对比|相比|比较|区别|差异|旧稿|旧版|原版")


def _document(store, object_id, revision_id, role, purpose):
    revision = revision_record(store, revision_id)
    if not revision or revision["object_id"] != object_id:
        raise ValueError("参考的准确修订不可用；请保留意见，重新核对版本。")
    payload = revision["payload"]
    if "source_revision" in payload:
        source = store.source(object_id)
        if not source or digest(canonical(source).encode()) != payload["source_revision"]:
            raise Conflict("参考资料已变化，不能用当前资料替换原版本；请保留意见。")
        payload = source
    blocks = payload.get("blocks") or [b for section in payload.get("sections", []) for b in section["blocks"]]
    return {"id": object_id, "revision": revision_id, "title": payload.get("title", object_id),
            "version_type": payload.get("version_type", "故事结构" if object_id == "story-structure" else "分集剧本"),
            "role": role, "purpose": purpose, "blocks": blocks,
            "origin": payload.get("origin", ""), "source_url": payload.get("source_url", "")}


def _excerpt(blocks, draft, anchor=None, radius=450):
    """Offsets always refer to Unicode characters in the exact full document."""
    starts, text = {}, ""
    for block in blocks:
        starts[block["id"]] = len(text)
        text += block["text"] + "\n"
    text = text.rstrip("\n")
    if anchor and anchor.get("block_id") in starts:
        left = starts[anchor["block_id"]] + anchor["start"]
        right = starts[anchor.get("end_block_id", anchor["block_id"])] + anchor["end"]
    else:
        # Explicit quoted phrases are stronger than incidental word overlap.
        terms = re.findall(r'[“「《"]([^”」》"]{2,80})[”」》"]', draft)
        positions = [text.find(term) for term in terms if term in text]
        if positions:
            left = min(positions); right = left + max(len(t) for t in terms)
        elif re.search(r"结尾|末段|最后", draft):
            left = right = len(text)
        elif re.search(r"开头|起句|首段|第一章", draft):
            left = right = 0
        else:
            # A bounded lexical window, rather than an unrelated document opening.
            terms = set(re.findall(r"[\u4e00-\u9fff]{2}", draft))
            best = max(blocks, key=lambda b: sum(t in b["text"] for t in terms), default=None)
            left = right = starts[best["id"]] if best else 0
    if len(text) <= 1200:
        return text, 0, len(text), len(text)
    lo, hi = max(0, left - radius), min(len(text), right + radius)
    # Finish at a sentence boundary where possible. A window is an excerpt,
    # never a falsely complete chapter or a cut version of the selected quote.
    if hi < len(text):
        boundaries = list(re.finditer(r"[。！？\n]", text[right:hi]))
        if boundaries:
            hi = right + boundaries[-1].end()
    if lo:
        boundary = re.search(r"[。！？\n]", text[lo:left])
        if boundary:
            lo += boundary.end()
    return text[lo:hi], lo, hi, len(text)


def _append_document(context, document, draft, limit, anchor=None, allowance=1200):
    blocks = document["blocks"]
    doc = {k: v for k, v in document.items() if k != "blocks" and v != ""}
    excerpt, start, end, total = _excerpt(blocks, draft, anchor)
    doc.update(text="", start=start, end=start, total_chars=total, truncated=True)
    context["source_documents"].append(doc)
    if len(canonical(context)) > limit:
        context["source_documents"].pop()
        return False
    # Full quote and anchor are already preserved in the required portion. Shrink
    # optional neighboring text, including its JSON escaping, to the real budget.
    quote_length = len(anchor.get("quote", "")) if anchor else 0
    selected_start = sum(len(b["text"]) + 1 for b in blocks[:next((i for i, b in enumerate(blocks) if anchor and b["id"] == anchor.get("block_id")), 0)]) + (anchor["start"] if anchor else 0) - start
    def portion(size):
        if anchor and size < quote_length:
            return "", start, start
        offset = max(0, min(selected_start - (size - quote_length) // 2, len(excerpt) - size)) if anchor else 0
        return excerpt[offset:offset + size], start + offset, start + offset + size
    high = min(len(excerpt), max(allowance, quote_length))
    low = 0
    while low < high:
        size = (low + high + 1) // 2
        value, lo, hi = portion(size)
        doc.update(text=value, start=lo, end=hi, truncated=lo > 0 or hi < total)
        if len(canonical(context)) <= limit:
            low = size
        else:
            high = size - 1
    value, lo, hi = portion(low)
    # Optional excerpt shrinkage may cut a neighboring sentence; make that visible.
    doc.update(text=value, start=lo, end=hi, truncated=lo > 0 or hi < total)
    return True


def _comparisons(store, draft, target_id):
    """Resolve explicitly named texts; shared story titles never pick a version."""
    if not COMPARISON.search(draft):
        return []
    matches = []
    for obj in store.objects():
        if obj["id"] == target_id or obj["kind"] != "SOURCE":
            continue
        source = store.source(obj["id"])
        title = source["title"]
        version_name = re.split(r"[:：]", title)[0]
        aliases = [obj["id"], title]
        if len(version_name) >= 4:
            aliases.append(version_name)
            if version_name.startswith("故事精修"):
                aliases.append(version_name.removeprefix("故事"))
        if any(alias in draft for alias in aliases):
            matches.append(_document(store, obj["id"], obj["current_revision"], "comparison", "意见明确提及的比较文本；仅说明差异，不定义当前对象事实。"))
    # Structure history is selected by its explicit revision/version, never head.
    for row in store.db.execute("SELECT id,version FROM revisions WHERE object_id='story-structure' ORDER BY version"):
        if row["id"] in draft or re.search(rf"故事结构(?:第{row['version']}稿|修订{row['version']}(?!\d))", draft):
            matches.append(_document(store, "story-structure", row["id"], "comparison", "意见明确提及的结构版本；仅供比较，不替换当前依据。"))
    return matches


def build_context(store, source_id, anchor, draft, target_object_id=None, target_revision_id=None):
    draft = str(draft or "").strip()
    if not 1 <= len(draft) <= 2000:
        raise ValueError("comment draft must be 1-2000 characters")
    object_id = target_object_id or source_id
    obj = next((o for o in store.objects() if o["id"] == object_id), None)
    if not obj:
        raise ValueError("unknown source")
    revision_id = target_revision_id if target_revision_id is not None else obj["current_revision"]
    try:
        target = store.validate_target(object_id, revision_id, anchor)
    except ValueError as error:
        if obj["kind"] == "SOURCE" and target_revision_id is not None and str(error) == "unknown object or mismatched revision":
            raise ValueError("资料版本已变化或不可用；请保留当前意见，刷新后重新圈选。") from error
        raise
    payload = json.loads(target["revision"]["payload"])
    if obj["kind"] == "SOURCE":
        task_stage = "STORY_COMPILATION"
        task_label = "资料审阅 · 表达当前意见"
    elif object_id == "story-structure":
        task_stage = "STORY_OUTLINE"
        task_label = "故事结构审阅 · 表达当前意见"
    else:
        from .screenplay import EPISODE_FORMAT
        if obj["kind"] != "EPISODE" or payload.get("format") != EPISODE_FORMAT:
            raise ValueError("unsupported polish target")
        task_stage = "SCRIPT_DRAFT"
        task_label = "剧本审阅 · 表达当前意见"
    project, system = store.configuration("PROJECT"), store.configuration("SYSTEM")
    limit = system["body"]["ai_context_max_chars"]
    context = {"review_task": task_label, "creative_stage": stage(task_stage),
               "target_object_id": object_id, "target_revision_id": revision_id,
               "anchor": {k: v for k, v in anchor.items() if k != "quote"},
               "selected_quote": anchor.get("quote", ""), "comment_draft": draft,
               "project_configuration_version": project["version"], "system_configuration_version": system["version"],
               "source_documents": [], "notices": []}
    if object_id == "story-structure":
        selection = revision_record(store, payload["direction_selection_revision"])
        if not selection or selection["object_id"] != SELECTION_ID:
            raise ValueError("结构锁定的方向选择修订不可用；请保留意见并核对依据。")
        ref = selection["payload"]
        context["basis"] = {"direction_selection_revision": selection["id"],
                            "direction": {"object_id": ref["source_id"], "revision_id": ref["source_revision"]}}
        dependencies = [(ref["source_id"], ref["source_revision"], "该结构准确选用的方向；只解释改编关系，不覆盖结构自己的内容。")]
    elif obj["kind"] == "EPISODE":
        context["basis"] = payload["basis"]
        context["screenplay_id"] = payload["screenplay_id"]
        context["episode_number"] = payload["number"]
        dependencies = [(ref["object_id"], ref["revision_id"], "该剧本锁定的" + label + "；只解释改编依据，差异以此剧本为准。")
                        for label, ref in (("小说", payload["basis"]["story"]), ("结构", payload["basis"]["structure"]))]
    else:
        dependencies = []
    visual = next((v for v in target["visuals"] if v.get("id", v.get("file")) == anchor.get("visual_id")), None)
    if visual:
        context["visual"] = visual
        context["region_points"] = anchor.get("points")
    required = len(canonical(context))
    if required > limit:
        raise ValueError(f"完整圈选、意见与准确身份需要 {required} 字符，超过参考总上限 {limit}；请缩小圈选或调高上限。未截断圈选，也未调用 AI。")
    current = _document(store, object_id, revision_id, "target", "被评论的准确版本；原文与圈选附近内容是本次意见依据。")
    # Required identity is not sacrificed to very long source metadata.
    if not _append_document(context, current, draft, limit, anchor if anchor.get("type", "text") == "text" else None):
        raise ValueError("准确目标及来源信息无法容纳在参考总上限内；请调高上限。未调用 AI。")
    for oid, rid, purpose in dependencies:
        needs_basis_text = bool(re.search(r"改编|依据|小说|结构|方向|原稿|原作", draft))
        if not needs_basis_text:
            purpose += " 当前意见不涉及这份依据正文，只保留准确版本。"
        doc = _document(store, oid, rid, "basis", purpose)
        if not _append_document(context, doc, draft, limit, allowance=500 if needs_basis_text else 0):
            context["notices"].append("预算不足，改编依据正文未加入；准确依赖仍保留，不推断其内容。")
            break
        if not needs_basis_text:
            context["source_documents"][-1]["identity_only"] = True
    comparisons = _comparisons(store, draft, object_id)
    if COMPARISON.search(draft) and not comparisons:
        context["notices"].append("未定位独立比较文本；请在意见中写明资料标题或准确版本，不能用最新稿猜测。")
    for doc in comparisons:
        if (doc["id"], doc["revision"]) == (object_id, revision_id):
            continue
        if not _append_document(context, doc, draft, limit, allowance=1000):
            context["notices"].append("预算不足，指定比较文本未加入；请调高上限后核对。")
            break
    # Global production facts are irrelevant to ordinary source/old-draft polish.
    fields = [key for word, key in (("故事背景", "story_background"), ("创作背景", "creative_background"),
              ("受众", "audience"), ("风格", "style"), ("载体", "target_medium")) if word in draft]
    if fields or "项目阶段" in draft:
        background = {key: project["body"][key] for key in fields}
        if "项目阶段" in draft:
            background["project_stage"] = stage(project["body"]["current_stage"])
        background["boundary"] = "当前项目背景，仅用于理解意见；不能替代被评论版本或比较稿的事实。"
        context["project_background"] = background
        if len(canonical(context)) > limit:
            del context["project_background"]
            context["notices"].append("预算不足，当前项目背景未加入；优先保留准确原文与意见。")
    if len(canonical(context)) > limit:
        # Notices are meaningful input too. Do not send an over-limit context.
        raise ValueError("必要参考及超限说明无法容纳在参考总上限内；请调高上限。未调用 AI。")
    serialized = canonical(context)
    return {"context": context, "context_sha256": digest(serialized.encode()),
            "budget": {"limit": limit, "used": len(serialized), "unit": "Unicode characters in serialized context"},
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
    from .external_budget import reserve
    reserve()
    request = Request("https://api.openai.com/v1/responses", data=json.dumps(payload, ensure_ascii=False).encode(),
                      headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    suggestion = "".join(part.get("text", "") for item in result.get("output", [])
                         for part in item.get("content", []) if part.get("type") == "output_text").strip()
    if not suggestion:
        raise ValueError("AI 润色未返回文本")
    return {"suggestion": suggestion, "saved": False, "context_sha256": preview["context_sha256"]}
