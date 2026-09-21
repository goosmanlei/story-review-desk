"""Versioned public configuration schema; runtime secrets are never records."""

from .framework import STAGES, WORKSPACES

SCHEMA_VERSION = 2

# Curated Responses API choices, not an assertion that the local API key has access.
MODEL_EFFORTS = {
    "gpt-4.1-mini": ("off",),
    "gpt-5.4-mini": ("none", "low", "medium", "high", "xhigh"),
    "gpt-5.6-luna": ("none", "low", "medium", "high", "xhigh", "max"),
    "gpt-5.6-terra": ("none", "low", "medium", "high", "xhigh", "max"),
    "gpt-5.6-sol": ("none", "low", "medium", "high", "xhigh", "max"),
}

FIELDS = {
    "SYSTEM": {
        "ai_polish_model": {"label": "评论润色模型", "type": "model", "default": "gpt-4.1-mini"},
        "ai_polish_effort": {"label": "推理强度", "type": "reasoning_effort", "default": "off"},
        "ai_context_max_chars": {"label": "AI 参考上下文字数上限", "type": "integer", "default": 12000},
        "enabled_workspaces": {"label": "已启用工作区", "type": "workspace_list", "default": [w["id"] for w in WORKSPACES if w["implemented"]]},
    },
    "PROJECT": {
        "current_stage": {"label": "当前创作阶段", "type": "stage", "default": "STORY_COMPILATION"},
        "story_background": {"label": "故事背景", "type": "long_text", "default": "UNKNOWN：尚未登记故事背景说明；应以已收录资料及出处为准。"},
        "creative_background": {"label": "创作背景", "type": "long_text", "default": "UNKNOWN：尚未登记创作目标与约束。"},
        "target_medium": {"label": "目标载体", "type": "text", "default": "UNKNOWN"},
        "audience": {"label": "目标受众", "type": "text", "default": "UNKNOWN"},
        "style": {"label": "风格", "type": "text", "default": "UNKNOWN"},
    },
}


def defaults(scope):
    return {key: value["default"] for key, value in FIELDS[scope].items()}


def validate(scope, body):
    if scope not in FIELDS or not isinstance(body, dict):
        raise ValueError("unknown configuration scope or invalid body")
    unknown = set(body) - set(FIELDS[scope])
    if unknown:
        raise ValueError("unknown configuration fields: " + ", ".join(sorted(unknown)))
    merged = {**defaults(scope), **body}
    for name, spec in FIELDS[scope].items():
        value = merged[name]
        if spec["type"] in ("text", "long_text"):
            if not isinstance(value, str) or len(value) > (8000 if spec["type"] == "long_text" else 200):
                raise ValueError("invalid configuration text: " + name)
        elif spec["type"] == "integer":
            if type(value) is not int or not 1000 <= value <= 30000:
                raise ValueError("invalid AI context limit")
        elif spec["type"] == "stage":
            if value not in {stage["id"] for stage in STAGES}:
                raise ValueError("unknown creative stage")
        elif spec["type"] == "workspace_list":
            known = {w["id"] for w in WORKSPACES if w["implemented"]}
            if not isinstance(value, list) or any(not isinstance(v, str) for v in value) or len(set(value)) != len(value) or any(v not in known for v in value):
                raise ValueError("unknown or duplicate enabled workspace")
            if "project.configuration" not in value:
                raise ValueError("system configuration cannot disable itself")
        elif spec["type"] == "model":
            if value not in MODEL_EFFORTS:
                raise ValueError("unsupported AI polish model")
        elif spec["type"] == "reasoning_effort":
            if value not in MODEL_EFFORTS.get(merged["ai_polish_model"], ()):
                raise ValueError("reasoning effort unsupported by selected model")
    return merged


def migrate(scope, saved_schema_version, body):
    if saved_schema_version > SCHEMA_VERSION:
        raise ValueError("configuration requires newer software")
    if saved_schema_version == 1 and scope == "SYSTEM":
        body = {**body, "ai_polish_effort": "off" if body.get("ai_polish_model", "gpt-4.1-mini") == "gpt-4.1-mini" else "medium"}
    elif saved_schema_version not in (1, SCHEMA_VERSION):
        raise ValueError("no migration for configuration schema")
    return validate(scope, body)


def catalog():
    return {"schema_version": SCHEMA_VERSION, "scopes": FIELDS,
            "model_efforts": MODEL_EFFORTS,
            "local": {"api_key": "OPENAI_API_KEY, never exported", "public_entry": "REVIEW_PUBLIC_ENTRY, never exported"}}
