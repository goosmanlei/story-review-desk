"""Stable domain and workflow vocabulary for the modular monolith.

The registry describes ownership and navigation, not a claim that every
workspace has been implemented. Future modules add services within this frame.
"""

DOMAINS = {
    "story": {"label": "故事创作", "kinds": ("SOURCE", "STORY", "EPISODE", "SCENE")},
    "settings": {"label": "故事设定", "kinds": ("ENTITY", "STATE", "REPRESENTATION", "RELATION", "SPACE")},
    "materials": {"label": "素材管理", "kinds": ("REQUIREMENT", "MATERIAL", "ASSET", "PROMPT", "CALL")},
    "production": {"label": "全剧制作", "kinds": ("PREPARATION", "SHOT_DESIGN", "SHOT", "INPUT_LOCK", "ASSEMBLY", "DELIVERABLE")},
    "collaboration": {"label": "审阅协作", "kinds": ("COMMENT", "JUDGMENT", "SUGGESTION")},
    "project": {"label": "项目管理", "kinds": ("GUIDANCE", "NOTE")},
}

STAGES = (
    {"id": "STORY_COMPILATION", "label": "故事采编", "domain": "story", "workspace": "story.sources"},
    {"id": "STORY_OUTLINE", "label": "故事梗概", "domain": "story", "workspace": "story.outline"},
    {"id": "SCRIPT_DRAFT", "label": "剧本创作", "domain": "story", "workspace": "story.script"},
    {"id": "STORY_SETTINGS", "label": "故事设定", "domain": "settings", "workspace": "settings.workspace"},
    {"id": "MATERIAL_PREPARATION", "label": "素材准备", "domain": "materials", "workspace": "materials.workspace"},
    {"id": "PRODUCTION", "label": "全剧制作", "domain": "production", "workspace": "production.workspace"},
)

WORKSPACES = (
    {"id": "current", "label": "当前工作", "domain": "project", "implemented": True},
    {"id": "story.sources", "label": "资料采编", "domain": "story", "implemented": True},
    {"id": "story.outline", "label": "故事梗概", "domain": "story", "implemented": False},
    {"id": "story.script", "label": "剧本创作", "domain": "story", "implemented": False},
    {"id": "settings.workspace", "label": "故事设定", "domain": "settings", "implemented": False},
    {"id": "materials.workspace", "label": "素材管理", "domain": "materials", "implemented": False},
    {"id": "production.workspace", "label": "全剧制作", "domain": "production", "implemented": False},
    {"id": "project.configuration", "label": "系统配置", "domain": "project", "implemented": True},
)


def catalog():
    return {"domains": DOMAINS, "stages": STAGES, "workspaces": WORKSPACES}


def stage(stage_id):
    return next((item for item in STAGES if item["id"] == stage_id), None)
