# 数据实体与关系

## 永久对象与不可变修订

![对象、修订和关系的核心 ER 图](../assets/data-core.svg)

objects 保存 id、领域、类型、标题、版本计数、状态、草稿头和采用头。revisions 保存不可变正文、内容 SHA、作者和修订号。两者通过对象身份与修订身份的组合约束对应，采用头不能指向另一个对象的修订。

version 用于并发核对；revisionId 标识一份确切内容；SHA 标识内容字节或规范化内容摘要。三个字段解决不同问题。显示场号或文件名不能替代其中任何一个。

## 故事与设定的组织关系

| 关系 | 存储 | 意义 |
| --- | --- | --- |
| 集包含场，且有顺序 | episode_scenes | 组织顺序与永久身份分开 |
| 实体之间的关系 | entity_relations | 两端为永久对象，关系本身也可修订 |
| 当前归属 | memberships | 为当前目录和组合提供查询 |
| 某个修订的归属 | revision_memberships | 保留历史版本当时的成员与顺序 |
| 原始资料 | source_documents | 原修订、原 SHA、MIME、字节和逻辑别名 |

对象自己的丰富结构放入 JSONB，例如正文块、镜头描述、时间线。归属、身份和跨对象版本引用由关系表保存并校验，不能全部塞进一个无法约束的整剧 JSON。

原始 SOURCE 正文不能覆盖；保存来源说明的新稿仍指向同一份原始资料。需要新原文时另行登记。来源存在多个版本时明确选择原修订，不按逻辑文件名猜测。

## 素材与实际制作输入

![需求、素材族、素材版本与媒体关系](../assets/data-media.svg)

一个素材族可以包含多个 ASSET，采用指针选择其中一个版本。asset_media 把具体修订绑定到 media 的媒体身份、版本和 SHA，角色可以是输出、预览、来源或附件。

media 区分 PRESENT、MISSING 和 RETIRED。相同 SHA 可去重保存字节，但业务版本和用途不因此合并。rights 保存当前权利事实，rights_events 追加权利变化的历史证据。

## 精确依赖与审阅证据

![修订、依赖、判断与制作证据](../assets/data-evidence.svg)

dependencies 绑定消费方修订、依赖修订和用途：SOURCE、CONTENT、DEFINITION、DESIGN、ACTUAL_INPUT。invalidations 记录变化影响哪个消费修订。reviews 把判断绑定到对象及修订，provenance 保存原始身份、历史证明及制作审阅依据。

操作队列、建议、运行心跳分别存在 operations、suggestions、runtime_status。它们不是新的创作正文。操作队列不进入普通项目包；来源和必要历史则随包保留。

## 历史不会被显示编号重写

一个历史镜头如果基于旧稿的某一场，它继续引用原场身份和原修订。当前稿恰好出现相同显示场号，也不会自动成为这个镜头的新依据。实例册用精确依赖与普通关联两类线条帮助辨认这种区别。

逐表字段和约束见[附录](reference.md#generated-index)。

## 声音归属与旧主体兼容

SOUND 不再是当前主体类型。服务端与网页默认配置、当前主体目录和类型筛选排除此类型；保存主体、配置草稿或正式配置时拒绝重新启用。读取旧配置提供有效类型，持久退役仍须携带原配置版本写入。导入会退役可变配置中的旧选项，并以 `retired-entity-configuration` 来源记录保留原配置及摘要。导入不改写旧 SOUND 对象及其修订：未处理来源在声音归属接口的 `legacySources` 中可查，已退役来源仍可按对象及修订读取。

声音通过 NOTE 的 `role: SOUND_OWNERSHIP` 建立可修订归属。它关联声音设定 STATE、表现 REPRESENTATION、需求 REQUIREMENT 或素材族 MATERIAL，不创建替代声音主体，也不改变上述资源的永久身份。新声音不需要 `source`；旧主体迁移必须固定 `source` 的原对象、原修订及 SHA。绑定记录同时写入当前关系、修订关系与精确依赖。

| 字段 | 契约 |
| --- | --- |
| `status` | `ASSIGNED` 或 `PENDING_CONFIRMATION`；输入兼容 `UNKNOWN`，迁移将其规范为 `PENDING_CONFIRMATION`，读取的 `resolution` 为 `UNKNOWN` |
| `usage` | 有证据支持的实际用途，至多 500 字 |
| `source` | 旧声音主体的 `kind: ENTITY`、`objectId`、`revisionId`、`sha256`、`expectedVersion`；新声音省略 |
| `target` | 明确归属时必填，同样携带永久身份、精确修订、SHA 与版本；kind 为 SPACE、STORY、EPISODE、SCENE 或 SHOT |
| `resources` | 每条绑定至多 100 项精确资源引用，kind 为 STATE、REPRESENTATION、REQUIREMENT 或 MATERIAL；新声音至少一项 |
| `pending` | 待确认时必填 `reason`、非空 `missingEvidence` 列表及 `todo`，不得同时提供 target |

SPACE 可以是永久 SPACE 对象，或类型为 LOCATION 的永久 ENTITY。展示场号、空间规格中的字符串编号及标题均不能代替永久身份。服务端核对所选修订属于目标、SHA 一致、对象版本符合预期；不会推断所属场、集或默认全剧归属。

来源的对象、修订与 SHA 不能换绑；绑定的资源身份集合不变，已明确目标不能换成另一永久对象。后续确认或更新依据追加绑定修订，旧绑定修订和已有实际输入仍指向原依据。普通归档不能移除旧声音主体或声音绑定；旧主体必须经完整迁移退出目录。

### 迁移读取与事务

迁移前读取 `GET /api/v1/workspaces/sound-ownership/inventory?sourceId=<永久声音主体ID>`。响应包括源精确引用、当前资源闭包 `resources`、保留对象清单 `retainedObjectIds`、并发核对用 `inventoryHash` 和保真用 `preservationHash`。资源闭包沿已登记的关系和精确依赖查找设定、表现、需求、素材族；其他当前引用、候选素材版本及冻结消费方纳入保真清单，不被重新归属。

每个旧主体单独提交一个事务。以下为结构示例，所有 ID、版本、SHA 和摘要必须替换为本次读取值；不能直接执行示例。`bindings` 中的资源合计必须覆盖完整 `inventory.resources`，同一用途不能唯一确认的部分分成 UNKNOWN 绑定，明确部分使用有证据的目标。

```json
{
  "operationId": "UNIQUE_OPERATION_ID",
  "actor": {"kind": "PROJECT_CODEX", "label": "已授权迁移"},
  "commands": [{
    "type": "workspace.change",
    "workspace": "sound-ownership",
    "input": {
      "action": "migrate",
      "explicit": true,
      "source": {"kind": "ENTITY", "objectId": "SOURCE_ID", "revisionId": "SOURCE_REVISION", "sha256": "SOURCE_SHA256", "expectedVersion": 7},
      "inventoryHash": "INVENTORY_HASH",
      "bindings": [{
        "bindingId": "NEW_PERMANENT_BINDING_ID",
        "status": "UNKNOWN",
        "usage": "原登记声音用途，归属证据待核对",
        "resources": [{"kind": "REQUIREMENT", "objectId": "RESOURCE_ID", "revisionId": "RESOURCE_REVISION", "sha256": "RESOURCE_SHA256", "expectedVersion": 3}],
        "pending": {"reason": "缺少永久目标及来源修订", "missingEvidence": ["永久目标身份", "支持该用途的原修订"], "todo": "核对证据后提交明确归属"}
      }]
    }
  }]
}
```

提交到 `POST /api/v1/transactions`，携带当前 `X-Review-Runtime` 和 JSON Content-Type。也可将 `input` 作为 `POST /api/v1/workspaces/sound-ownership` 的请求体，并提供 operationId。明确项将 status 改为 ASSIGNED，移除 pending，增加 target 精确引用。

迁移在同一事务中锁定源、目标、全部资源和保留对象，重新校验源版本、清单摘要和精确引用，追加 1 至 99 条绑定，最后将旧主体标为 ARCHIVED/historical，版本加一。源修订和草稿头/采用头、资源、候选、素材版本及媒体 SHA、审阅、原始来源和生产依赖均保留。提交前后 `preservationHash` 必须相等，否则整体回滚；成功记录 `sound-ownership-migration` 来源证据。迁移不采用素材、不改变输入锁定、不授权生成。原始 `source.expectedVersion` 保留迁移时版本；退役后的当前源版本由响应 `sourceVersion` 给出。

`inventoryHash` 已变化、资源覆盖不全或 CAS 冲突必须重新读取并人工核对；不得用标题或旧编号补齐。操作结果未知时先查 `GET /api/v1/operations/<operationId>`。同编号同请求回放原结果，同编号不同请求拒绝；明确失败后重新核对的修改请求使用新 operationId。

持久配置退役使用同样的 workspace.change 格式，input 为 `{"action":"retire-configuration","expectedVersion":<system配置当前版本>}`。先通过 `GET /api/v1/configurations` 读取 system 版本，核对其 `retiredEntityTypes` 和 `storedContentHash`。该动作移除退役选项、保留其他配置，并保存原配置来源证明。普通设置保存也不会把旧退役选项带回。

后续新建声音或确认 UNKNOWN 使用 input `action: save`，携带 `bindingId`、`expectedVersion`、`title` 和完整 `content`。新绑定版本为 0；更新绑定需刷新源、目标、资源的对象版本，源的原修订/SHA 保持不变。原绑定和资源修订继续保留。

### 读取、检索与保真核验

- `GET /api/v1/workspaces/sound-ownership` 支持 `ownerId`、`sourceId`、重复的 `resourceId`、`status`、`q`、`limit` 和 `offset`。过滤在限额之前执行，响应的 `hasMore`/`nextOffset` 支持分页；counts 为本页计数。UNKNOWN 可在全量或待确认列表中读取，不混入任何默认目标。
- 绑定响应的 `exactReferences` 核验原修订及 SHA；`currentReferences` 区分原依据是否仍是当前头。旧依据继续可读，当前资源目录不会把旧绑定自动套给新稿。对象上下文保留对应所选修订的 `soundOwnership`。
- 领域工作区与素材目录返回 `soundOwnership`、`legacySoundSources`；需求和素材族提供精确声音绑定及当前空间/剧/集/场/镜身份数组。素材分页可按 `ownerId` 查找，通用对象目录的 owner/entity 筛选也沿已验证的声音关系读取。准备、镜头制作、分集制作和空间工作区附带声音归属；页面须展示这些字段及旧来源入口。
- 归属是用途和发现关系，不能替代素材采用、权利审查、精确输入版本或实际输入锁定。已过时的记录保留 `soundOwnershipStale` 和原精确引用；当前归属数组不复制旧依据。
- 导入逐项校验全部声音绑定修订的对象、SHA、修订关系和精确依赖，不以当前版本号变化否定历史证据，也不重绑当前稿。

执行者每项核验：迁移前记录源版本、资源闭包、保留对象与 preservationHash；按证据建立明确/UNKNOWN 清单；提交后查原操作结果，回读源历史状态和绑定；再次读取 inventory 并比较 preservationHash；按 owner/resource/source 检索，核对 exactReferences；按原修订回读资源、候选和实际输入，确认媒体版本/SHA 与冻结依赖未变。与其他整理任务共享永久对象时，逐项对照其对象及修订，CAS 冲突后重读，避免重复处理。

回归入口为 `tests/sound-ownership.test.mjs` 与 `tests/entity-types.test.mjs`。声音测试使用内存事务协议模拟，覆盖保存、CAS、幂等、回滚、导入兼容和读取投影，不连接实例数据库或生成模型。正式继承验收仍需执行隔离 PostgreSQL 集成、实际项目逐项回读及页面验证。
