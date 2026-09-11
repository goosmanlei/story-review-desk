export type Summary = {
  id: string;
  module: string;
  kind: string;
  displayId: string;
  title: string;
  version: number;
  state: string;
  draftRevisionId: string | null;
  adoptedRevisionId: string | null;
  position: number;
  historical: boolean;
  stale?: boolean;
};
export type Detail = Summary & {
  revision: {
    id: string;
    number: number;
    content: Record<string, any>;
    sha256: string;
    author: string;
  };
  links: Array<{
    id: string;
    role: string;
    title: string;
    kind: string;
    position: number;
    version: number;
  }>;
  dependencies: Array<{
    objectId: string;
    revisionId: string;
    purpose: string;
    title: string;
  }>;
  media: Array<{
    id: string;
    version_id: string;
    sha256: string;
    mime_type: string;
    availability: string;
    role: string;
  }>;
  reviews: Array<{
    id: string;
    decision: string;
    note: string;
    findings: any[];
    author: string;
    created_at: string;
  }>;
  invalidations: any[];
  versions: Array<{
    id: string;
    number: number;
    sha256: string;
    author: string;
  }>;
  rights: {
    fact: string;
    internalAttestation: boolean;
    evidence?: { note?: string };
  } | null;
};
export type Draft = {
  title: string;
  content: Record<string, any>;
  links?: Array<{ id: string; role: string; position?: number }>;
  dependencies?: Array<{
    revisionId: string;
    purpose: string;
    objectId?: string;
    title?: string;
  }>;
  basedOnVersion: number;
};
export const stateLabels: Record<string, string> = {
  DRAFT: "草稿",
  SUBMITTED: "待审",
  ADOPTED: "已采用",
  CHANGES_REQUESTED: "要求修改",
  DISABLED: "禁止使用",
  ARCHIVED: "历史记录",
};
export const kindLabels: Record<string, string> = {
  SOURCE: "来源资料",
  STORY: "故事结构",
  EPISODE: "分集",
  SCENE: "场正文",
  ENTITY: "主体档案",
  STATE: "状态依据",
  REPRESENTATION: "表现定义",
  RELATION: "实体关系",
  SPACE: "空间",
  REQUIREMENT: "素材需求",
  MATERIAL: "素材族",
  ASSET: "实际版本",
  PROMPT: "提示词",
  CALL: "调用定义",
  EXPECTED_OUTPUT: "待产出",
  PREPARATION: "制作准备",
  COVERAGE: "节拍覆盖",
  SHOT_DESIGN: "镜头设计",
  SHOT: "镜头",
  INPUT_LOCK: "实际输入",
  ASSEMBLY: "场景剪辑",
  DELIVERABLE: "成片",
  COMMENT: "评论",
  JUDGMENT: "判断",
  GUIDANCE: "项目指引",
  NOTE: "候选记录",
};
