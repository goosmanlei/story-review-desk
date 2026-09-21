# 故事结构阅读与审阅接口

故事结构在 `story.outline` 工作区阅读。设计依据为 [`design/story-structure/dist/index.html`](../design/story-structure/dist/index.html) 与[设计说明](../design/story-structure/README.md)。设计稿中的人物、图像和 24 分钟节奏都是示例，不会自动导入故事实例。

## 方向与稿件版本

1. 故事采编和故事结构在同一“故事创作”页面的子页标签间切换。故事结构未选方向时，初始页直接列出 `expansion-directions` 候选的摘要，提供“回看全文”和“选用这个方向”；选择操作属于故事结构子页。浏览器调用 `POST /api/story-structure/select-direction`，请求 `{"source_id":"...","expected_version":0}`。`expected_version` 是当前选择对象版本；重新选择须传最新版本。响应包含精确的选择修订。`GET /api/story-structure` 返回选择记录、来源资料、全部结构修订、当前修订、方向变更提示和确认记录。
2. Codex 读取 `structure-get`、`structure-review`，依据选定方向起草一份**完整**结构稿。方向未选定时不应为真实故事导入稿件。将图片或 SVG 图示放入故事实例的 `export/assets/`，在 JSON 中引用文件名。所有修订引用的资产都保留，导出清单逐一哈希。
3. Codex 用 `structure-import file.json --expected-version N` 导入。初稿 `N=0`、`parent_revision=null`；调整稿 `N` 为当前结构对象版本、`parent_revision` 必须等于当前结构修订。调整稿须完整列出六章，不能只传 diff。方向选择修订必须是当前选择；方向变化后不能静默沿用旧选择。导入结果给出新结构修订 ID。
4. 评论始终留在原修订。调整稿的 `responses` 单独写意见处理说明，关联原稿评论 ID；不会自动关闭意见。用户可切换版本审阅、点击处理说明定位原意见。新稿的评论从空白开始，历史待决数单列。
5. 用户在页面勾选、填写确认人后，才可确认**当前**结构修订。`POST /api/story-structure/confirm` 记录 `revision_id,reviewer,note?`、所选方向修订和当时待决评论。`script-input`/`GET /api/story-structure/script-input` 返回准确确认稿、对应图文、方向来源与待决项。确认后再导入实质新稿或改选方向时 `requires_re_review=true`；剧本工作流应停止沿用旧确认作为当前约束。

## CLI

从系统仓库执行，`/path/to/story-repo` 替换为实例根目录：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo structure-get
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo structure-review
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo structure-import /path/to/complete-structure.json --expected-version 0
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo script-input
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
```

`structure-review` 返回每条意见的正文、对象与精确修订、文字引用或图像/图示资产与归一化坐标、完整原稿、当时的方向选择与来源资料、项目创作背景及锚点状态。图片二进制位于实例 `export/assets/<file>`，Codex 需要视觉细节时应同时读取原资产。`GET /api/story-structure/review-context` 提供同一数据。

## 完整稿件 JSON

```json
{
  "title": "结构稿标题",
  "direction_selection_revision": "structure-get.selection.id",
  "parent_revision": null,
  "illustrative": false,
  "sections": [
    {"id":"theme","title":"方向与主题","blocks":[{"id":"theme-1","text":"完整正文……"}],"visuals":[]},
    {"id":"characters","title":"人物塑造","blocks":[{"id":"characters-1","text":"完整正文……"}],"visuals":[]},
    {"id":"relationships","title":"人物关系","blocks":[{"id":"relationships-1","text":"完整正文……"}],"visuals":[{"id":"relation-graph","kind":"diagram","file":"relation-v1.svg","title":"人物关系图","alt":"图中信息的文字替代","description":"图意与对应正文"}]},
    {"id":"spaces","title":"空间关系","blocks":[{"id":"spaces-1","text":"完整正文……"}],"visuals":[]},
    {"id":"storylines","title":"故事线","blocks":[{"id":"storylines-1","text":"完整正文……"}],"visuals":[]},
    {"id":"timeline","title":"时间线","blocks":[{"id":"timeline-1","text":"完整正文……"}],"visuals":[]}
  ],
  "responses": []
}
```

六章按上列顺序齐全。每章 `blocks` 为非空数组；同稿内 `block.id` 唯一。每个图像/图示有稳定 `id`、文件名、图题、替代文字和说明。`kind` 为 `image` 或 `diagram`。新稿如图意改变，应引用新资产文件，旧资产保留供原稿评论定位。段落文本、图示与说明由创作者保证语义一致；接口核对结构完整、对象修订、资产存在及引用完整性，不会自动推断图意。

调整稿示例只需变动顶层版本字段，仍须提交完整六章；意见说明形如 `"responses":[{"comment_id":"原稿评论 ID","explanation":"怎样理解及调整，并指出影响的正文和图示"}]`。说明位于正文之外。

## 共用评论

故事采编与故事结构使用同一 `comments` 表、`comment_events` 表、`POST /api/comments`、`PATCH /api/comments/{id}` 和侧边评论面板。编辑、关闭、重新打开、草稿、本机定位和 AI 润色行为一致。结构稿评论提交 `{target_object_id:"story-structure",target_revision_id:"修订 ID",anchor,body,id?}`；资料评论继续提交 `{source_id,anchor,body,id?}`。

- 文字：`anchor={"type":"text","block_id":"...","end_block_id":"...","start":0,"end":5,"quote":"准确引用"}`。跨段按章内及跨章顺序引用，每段之间用 `\n`。服务端对原修订全文、范围、引用逐一核验。旧资料文字锚点不带 `type` 仍可读取。
- 整体：`{"type":"global"}`，仅结构稿使用。
- 整图：`{"type":"visual","visual_id":"图 ID","asset_file":"文件名"}`。
- 圈图：`{"type":"region","visual_id":"图 ID","asset_file":"文件名","points":[{"x":0.1,"y":0.2},...]}`。`x/y` 相对原图边界归一化到 0–1，至少三点且有面积。页面随图像缩放绘制原多边形；拖动短直线自动转为矩形。图片与图示均可用，采编资料图片也使用这一格式。

`GET /api/comments` 可按 `source_id` 或 `target_object_id` + `target_revision_id` 过滤，并返回 `anchor_state`。引用内容丢失或不匹配时显示“原引用已失效”，不会把旧评论移到新稿。`POST /api/comments/polish-context` 先生成可核对参考并返回 SHA-256；`POST /api/comments/polish` 要求相同 `expected_context_sha256`。结构稿请求附 `target_object_id,target_revision_id`，参考含方向、结构原稿、图资产和圈选点。建议只进入草稿，需人工保存。

## 持久化与恢复

结构选择、完整修订、意见回应、确认记录都在对象/修订/依赖账本；图文评论和事件继续沿用共用账本。`export` 的 `objects.json`、`comments.json`、`manifest.json` 与 `assets/` 保存全部引用关系和素材 SHA-256。把实例仓库公开同步前须审阅评论和素材内容。干净恢复要求空库并验证清单及锚点。设计稿不会成为实例业务数据；正式故事方向和结构确认须由用户在真实实例中操作。
