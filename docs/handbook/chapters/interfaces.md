# 接口与一致性契约

## 接口按能力组织

| 方法与路径（/api/v1 下） | 用途 | 结果 |
| --- | --- | --- |
| GET health、work | 运行身份与跨域工作概览 | 状态与版本 |
| GET objects、objects/:id、contexts/:id | 分页目录、精确修订及上下文 | 对象、关系、basis |
| GET source/:revisionId、media/:sha | 原始资料与登记媒体 | 原字节；媒体支持 Range |
| GET facets、relationships、settings/spatial-baseline | 分类、关系与空间投影 | 有界读取 |
| GET workspaces/integrity | 当前对象、素材归属、制作设置和精确引用核验 | 问题对象及原因 |
| GET workspaces/... | 原版工作区读取投影 | 页面所需的一致上下文 |
| POST transactions | 保存、提交、判断及配置事务 | 操作回执和命令结果 |
| POST workspaces/... | 工作区动作 | 转换为所属对象服务命令 |
| POST jobs | 长任务入队 | operationId，之后查询 |
| GET operations/:id；POST operations/:id/cancel | 查询与取消 | 明确操作状态 |
| GET suggestions/:id；POST suggestions/:id/apply | 预览与应用 AI 建议 | 应用仅保存草稿 |
| GET assistant/conversations、assistant/events；POST assistant/... | 对话、只读上下文与事件 | 对话状态及建议 |
| GET export；POST import、upload | 项目包与媒体传输 | 流式内容或后台回执 |
| GET configurations、maintenance、review-library | 配置、维护与资源目录 | 各自当前状态 |
| GET documentation/catalog、documentation/chapters/:id、documentation/assets/:id | 通用手册 | 软件版本、正文、图表与内容哈希 |

完整接口族索引自动从路由实现提取；细分工作区动作以所属服务和测试为准，不能仅凭 GET 接口名称推测写入规则。

## 一次事务的请求

![读取、CAS、事务提交与幂等重放](../assets/transaction.svg)

修改需要 operationId、expectedVersion 和从 health 取得的 x-review-runtime。operationId 标识一次意图；expectedVersion 针对对象当前计数；运行期用于阻止恢复前页面向新实例状态误写。

```json
{
  "operationId": "example-save-scene-001",
  "actor": {"kind": "HUMAN", "label": "示例作者"},
  "commands": [{
    "type": "save", "id": "scene-example", "kind": "SCENE",
    "expectedVersion": 3, "title": "门外的来客",
    "content": {"text": "门外响起脚步声。"},
    "links": [], "dependencies": []
  }]
}
```

这段是结构示例，不针对任何真实对象，也不应原样提交到创作实例。创建新对象的 expectedVersion 为 0；更新前必须读取实际版本和所属对象完整内容。

## 不同冲突分别处理

| 情况 | 系统行为 | 客户端动作 |
| --- | --- | --- |
| 同 operationId、同请求 | 返回原回执 | 查询或展示原结果 |
| 同 operationId、不同请求 | 拒绝 | 核对原意图，不能覆盖回执 |
| expectedVersion 已变化 | 拒绝整笔事务 | 重新读取并人工协调修改 |
| 运行期已变化 | 拒绝旧页面写入 | 刷新当前实例上下文 |
| 调用结果未知 | 保留原请求和核查依据 | 查询原操作，不自动再次调用 |

多对象事务按稳定顺序加锁，全部版本核对通过才生效。业务失败回滚，同时保留可查询的失败回执。传输失败本身不能证明服务器没有完成操作。

## CLI 与网页如何一致

review CLI 自动绑定实例运行期，调用相同 HTTP 接口。命令文件只是请求输入，不允许直接修改 PostgreSQL 或正式媒体。网页工作区同样经事务规划器落到所属业务服务；模型工具只能读取允许的上下文，建议应用再走正式事务。

常用入口为 `npm run review -- --help`，接口示例的来源版本和参数必须在实际执行前重新核对。

## 待确认空间位置接口

`GET workspaces/spatial-settings/placements` 返回当前依据、NOTE 版本与草稿头、待确认显示项及陈旧或冲突记录。`POST workspaces/spatial-settings/placements` 接收 `{action:"save", drafts:[...]}`；等价事务使用 `workspace.change` 和同名工作区。继续遵循本章的运行期与 operationId 契约。

每项 draft 提供 `noteId`、`expectedVersion`、`expectedDraftRevisionId`、`title` 和严格的 `content`。内容含永久地点与空间 SOURCE 的 id/revisionId/sha256/expectedVersion、独立的原始来源 `sourceSha256`、精确或 UNKNOWN 的场依据、`PENDING_CONFIRMATION` 状态、`CANVAS_ONLY` 槽位和待核说明。修订内容 SHA 与原始来源字节 SHA 不能互换，审阅元数据由服务放在提案正文之外。

每批 1–100 项，NOTE 与地点不得重复。规划器核对唯一有效采用 SOURCE，并在稳定加锁后重新核对全部依据、NOTE 草稿头与当前提案唯一性；SOURCE 目录变更也参与同一锁。失败整批回滚，成功只追加 NOTE 草稿。编辑不能换绑原依据。旧 NOTE 用 `objects/:id?revisionId=...` 精确回读；结果未知先查 `operations/:id`。

## 素材松散用途接口

`server/materials/usage-scopes.mjs` 是运行时校验入口；前端契约为 `web/presentation/material-usage-scope-model.d.mts`。人物属性沿用 `domain-workspaces?owner=SETTINGS` 返回的 `ownership`，保存 `changes[].value.isExtra` 时核对 `beforeHash` 和 `expectedDraftRevisionId`，仍先 save、preview，再 publish。人物及组合素材职责见[领域划分](domains.md#人物身份与组合素材)。

### 查询

| 路径（前缀 `/api/v1/workspaces/`） | 返回 |
| --- | --- |
| `material-usage-scopes?familyId=<永久族ID>` | `tuples[]`，每项为一条 NOTE；省略 familyId 读取当前用途，最多 5000 条，超限明确报错 |
| `material-usage-scopes?...&historical=1` | 包含已移除 NOTE |
| `material-usage-scopes?...&catalog=1` | 附带 `catalog` |
| `material-usage-scopes/catalog` | 当前实例永久 ID、素材族与集场镜目录、精确关系方向及关系所有者修订 |
| `material-usage-scopes?usageId=<NOTE ID>` | `detail`、该用途独立 `draft`；未登记身份返回 `detail:null`，可用于新建前的 CAS |
| `material-usage-scopes?usageId=<NOTE ID>&revisionId=<精确修订>` | 原始修订、原始关联、`versions` 历史索引、原范围 tuple；保留当前对象版本与历史标志 |
| `material-usage-scopes/migration-preview?familyId=<永久族ID>` | 只读 `PREVIEW_ONLY`：`tuples` 候选、`unknown`、`skipped`；不保存数据 |

素材族的 `assets` 投影还包含 `materialUsageScopes[]`。这些条目不会加入旧 `sceneIds`、`episodeIds`、`shotIds` 数组。目录中的 `relations[]` 每项明确 owner/member 的永久身份、修订、版本与 role；不从多父关系选择唯一上级，也不合成路径组合。

用途 tuple 包含下方正文，以及 `usageId`、`revisionId`、`objectVersion`、`state`、`historical`、`freshness`、`pathResolution`、`issues`、`dependencies:[]`。`freshness:STALE` 保留原记录并说明变化。没有完整路径时 `pathResolution:UNKNOWN`；可保存单范围用途，前端不能借 UNKNOWN 推断上级。完整路径仅表示所选这一条经过验证，其他父关系仍存在。

### 用途正文

```json
{
  "role": "MATERIAL_USAGE_SCOPE_V1",
  "familyId": "material-1",
  "familyRevisionId": "material-revision-1",
  "familyExpectedVersion": 3,
  "scopeType": "SCENE",
  "scopeId": "scene-1",
  "scopeRevisionId": "scene-revision-1",
  "scopeExpectedVersion": 4,
  "purposeNote": "环境气氛参考",
  "path": {
    "nodes": [
      {"objectId":"episode-1","kind":"EPISODE","revisionId":"episode-revision-1","expectedVersion":2},
      {"objectId":"scene-1","kind":"SCENE","revisionId":"scene-revision-1","expectedVersion":4}
    ],
    "relations": [{"ownerId":"episode-1","memberId":"scene-1","role":"SCENE"}]
  },
  "sourceBindings": [
    {"objectId":"requirement-1","revisionId":"requirement-revision-1","expectedVersion":1}
  ]
}
```

`purposeNote`、`path`、`sourceBindings` 可省略。PROJECT 使用 catalog.project.scopeId，即当前 instance 永久 ID；此时禁止 `scopeRevisionId`、`scopeExpectedVersion` 和 path，不伪造 STORY 对象。其余范围严格验证 EPISODE/SCENE/SHOT kind。族和范围须引用当前可用头；来源可以引用明确历史修订，但写入时仍核对该来源对象的所见版本。来源不接受 ASSET。

路径按集→场→镜排序，可以是连续的局部路径，最多 3 个节点。每步 relations 显式给出实际登记方向；例如 SHOT 的 SCENE 关联可指向其父场。验证关系所有者精确修订的 `revision_memberships`，不是显示号、标题、`episode_scenes` 唯一父投影或数组位置。局部路径保留其证据，完整上级仍为 UNKNOWN。

### 保存、预览与应用

所有 HTTP 写入须带 `Content-Type: application/json` 与 `X-Review-Runtime: <当前 runtimeEpoch>`。工作区动作 POST `/api/v1/workspaces/material-usage-scopes`，请求体为下面的 `input`，操作编号放 `Idempotency-Key` 请求头（也可放 input.operationId）。也可通过 POST `/api/v1/transactions` 使用下列完整外壳；此时 HTTP 入口以运行期请求头为准。一次工作区动作独立事务：

```json
{
  "operationId": "operation-save-1",
  "runtimeEpoch": "读取时的运行版本",
  "commands": [{
    "type": "workspace.change",
    "workspace": "material-usage-scopes",
    "input": {
      "action": "save",
      "usageId": "usage-1",
      "expectedDraftRevisionId": null,
      "change": {
        "type": "UPSERT",
        "expectedVersion": 0,
        "expectedRevisionId": null,
        "content": {
          "role":"MATERIAL_USAGE_SCOPE_V1",
          "familyId":"material-1",
          "familyRevisionId":"material-revision-1",
          "familyExpectedVersion":3,
          "scopeType":"PROJECT",
          "scopeId":"当前实例永久ID"
        }
      }
    }
  }]
}
```

transactions 入口返回 `workspace.draftRevisionId`；直接 workspaces 入口将 `workspace` 展开，返回顶层 `draftRevisionId`。save 只保存本 usage 的编辑 NOTE，不改变业务用途。接着提交新的 operationId，input 为：

```json
{"action":"preview","usageId":"usage-1","draftRevisionId":"保存返回的编辑修订"}
```

preview 返回 `workspace.previewHash`、`tuples` 和空的 `invalidations`、`dependencies`。核对后用新 operationId 提交：

```json
{"action":"publish","usageId":"usage-1","draftRevisionId":"同一编辑修订","previewHash":"预览返回的哈希"}
```

publish 只保存业务 NOTE 的 DRAFT 头，返回 `usageId/id`、`revisionId`、`version` 和更新后的编辑 `draftRevisionId`；`formalAdoptionPerformed:false`。更新沿用 usageId，携带自身当前 `expectedVersion`、`expectedRevisionId` 和编辑草稿头；可以改变用途范围和说明，不能换绑素材族，旧范围及来源修订可回读。同族、同范围的不同用途可使用不同 NOTE ID，互不覆盖。

移除同样 save → preview → publish，将 `change.type` 改为 `REMOVE`，content 提供与旧用途相同的 familyId/scopeType/scopeId 和刷新后的对象/路径版本。移除归档该业务草稿并递增版本；不删除 NOTE、旧修订或编辑历史。已归档身份不可复用。

原操作查询使用现有 `/api/v1/operations/<operationId>`；相同请求同号返回原结果，不同内容同号拒绝。编辑 NOTE、业务 NOTE、族、范围、来源和路径所有者均参与版本核对及事务锁；锁后再次验证。旧草稿头、旧预览、引用漂移和并发写冲突拒绝整次事务。

通用 transaction 的 NOTE save 也校验同一契约；仅允许 FAMILY 和本条非 PROJECT 范围链接，禁止 ASSET、额外关联、reviewSpec、媒体、权利字段和非空 dependencies。普通 submit/review/disable 被拒绝；archive 需要 `usageScopeBasis` 和 runtimeEpoch。其他对象不能将用途 NOTE 修订变成正式输入依赖。导入检查历史正文、永久关联、空依赖及草稿状态，不重写历史。

### 只读迁移预览

迁移候选只来自 MATERIAL/REQUIREMENT 当前可用记录上无歧义的永久 FAMILY 与单条 EPISODE/SCENE/SHOT 关系，每个来源保留精确修订。旧显示号、不配对的范围数组（包括嵌套 storyApplicability）、多族、缺少身份与历史不可用来源返回 UNKNOWN/SKIPPED；不按文本生成 PROJECT 用途，不应用迁移。
