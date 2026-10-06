# 制作拆解与镜头制作

“制作设定”包括制作拆解、实体管理、素材管理。“全剧制作”默认进入镜头制作，原组合与交付仍在“组合与历史”可读；新的场、集、剧组合编辑页面不在本次实现范围。

制作拆解顶部复用剧本分集卡，显示集编号、标题、真实场范围与评论数；计数按实际展示的场镜修订匹配评论 ID，包含已关闭评论，不混算剧本、素材或评论事件。左侧场／镜两级目录初次全部展开，按准确父级修订排序，点击场定位开头，点击镜头跨场定位。刷新、前后退与弹窗返回保留准确阅读对象和位置。

每镜左侧是目的、画面、空间、动作起止、承接和声音；右侧为 300px 的共用素材小卡栏，按真实媒体及实体／制作位置关系分组，多实体用共有，不能可靠分类用其他，无数据的分区不显示。只列本镜明确关联的唯一素材，管理页三列分页不带入侧栏。此页不再渲染场景／时段、过程说明或归属筛选；既有元数据和说明修订保留，说明上的旧评论仍可准确打开历史原文。

场头和镜头标题旁共用剧情阅读弹窗：读取锁定剧本的完整场正文，仅用准确正文块 ID 高亮，保留不连续依据间的正文。缺失或失效引用明确报出，不回落最新版本。原片段读取与真实生成输入的语义保持不变。

镜头制作沿用集场导航及逐镜行布局，每镜显示所选视频候选的真实生成内容；未生成时显示准确方案。打开素材后可读参数、提示词、准确输入、版本候选与显式采用。内容修订、生成和登记通过后台工具完成。准确版本中的“未生成”表示该版本没有真实原件；素材管理的“有结果”筛选包含历史版本，不代表当前版本已有结果。完整方案也不等于已经可以调用模型。

## 两个视角共用哪些关系

实体及其完整状态回答“制作什么形态”，剧、集、场、镜回答“在哪里出现、准备和使用”。角色、空间、道具、歌曲是内置实体类型；其他类型可用稳定类型 ID、`entity_type_label` 和非空的 `attribute_definitions:{字段名:含义}` 扩展。完整状态的 dimensions 须包含该类型定义的属性。

| 关系 | 数据 | 不推断什么 |
| --- | --- | --- |
| 出现／提及 | 场与镜的 occurrences，或 `RELATION` 的 `occurrence` | 仅提及不产生出镜义务 |
| 需求归属 | `REQUIREMENT.scope` 指向准确状态或制作位置 | 全剧共用不表示全部下级用到 |
| 适用范围 | `RELATION` 的 `applicability`，精确 subject 与 scope | 适用不表示真实输入、认可或采用 |
| 真实输入 | 不可变 CALL.inputs | 不从当前方案或最新候选回填 |
| 准确采用／组合 | adoption 与 ASSEMBLY 的准确候选、组成和范围 | 新增候选不改变历史作品 |

`occurrence` 的 subject 为 ENTITY 或 STATE，mode 为 visual、voice、visual_voice、mention；需准确 sources、reason 及 `basis:source_fact|production_choice`。`applicability` 的 subject 可为 ENTITY、STATE、REQUIREMENT、ASSET、REPRESENTATION，scope 可为准确状态、剧、集、场或镜；原件局部适用还需 component_id 及经过校验的 crop/range。

镜头的直接 parent 固定 PREPARATION 修订；场的 source 固定 EPISODE 修订。新增场记录以 `input_lock` 固定此次制作所依据的整版输入，避免以后切换当前剧本时改变过去的上层来源。旧场镜缺少父级证据时只返回能还原的准确链，不用当前父级补齐。历史素材需求与采用按其绑定的位置修订读取，当前排序或归属变化不重绑旧记录。

向上汇总分别返回直接关联、从子级推导的出现及实际采用。查询索引可重建；不可变修订与准确依赖是证据来源。汇总不向下扩展为所有镜头均出现。

## HTTP 与 CLI

| 读取目的 | HTTP GET | CLI |
| --- | --- | --- |
| 分集及本集场镜 | `/api/production/breakdown?episode=ID&object_id=可选场镜ID&revision_id=可选SHA` | `production-breakdown --episode ID` |
| 选中范围 | `/api/production/context?object_id=ID&revision_id=SHA` | `production-context --object-id ID --revision-id SHA` |
| 素材筛选 | `/api/production/materials?episode=ID&scene=s001&media=image&status=ungenerated&search=文本&offset=0` | `production-materials --episode ID --scene s001 --media image --status ungenerated --search 文本 --offset 0` |
| 完整剧情场与准确高亮 | `/api/production/source?object_id=ID&revision_id=SHA&scene_id=S&block_ids=逗号分隔ID&full_scene=1` | 原 `source_excerpt` 默认仍只读引用片段 |
| 向上汇总 | `/api/production/summary?object_id=ID&revision_id=SHA` | `production-summary --object-id ID --revision-id SHA` |
| 实体／历史目录 | `/api/production/index?view=settings或history&object_id=可选ID` | 按类型的既有 production-list |

CLI 均以 `python3 -m review_desk --instance PATH` 为前缀。旧 CLI 素材列表每页 40 项，返回 total、offset、limit，按 offset 递增读取；管理页面使用 `grouped=1` 投影与[共用三列行分页](small-cards.md)，两种接口口径分开。列表按持续存在的需求计数，同一需求的多个版本和候选不重复计数。无已知需求关联的历史原件独立保留。

写入复用 `production-import` 和 `/api/production/import`，expected_version 与 expected_heads 在同一事务校验。批内准确引用可使用 `@前序对象ID`，提交时解析成不可变修订。校验模式执行同样的读取和校验后回滚。文件登记、审阅及采用继续复用现有接口，见 [制作契约](production.md)和[版本与迁移](material-versions.md)。

## 页面读取与验收

目录只读取所选集的场镜，正文请求当前场及各镜准确关联的素材，点击小卡打开完整素材详情；实体与历史入口使用各自目录，不先加载全部制作对象。快速切换以请求序号丢弃迟到结果，防止旧场、镜或候选覆盖新阅读对象。素材卡、播放器、评论面板及来源弹窗共用；返回保留准确阅读对象、滚动位置和草稿。窄屏依次排列导航、镜头正文和本镜素材。

自动测试覆盖父级、归属和汇总边界、准确历史引用、并发迁移与回滚。实际验收还需操作集场镜、三个子页、管理页筛选、候选、原件与来源弹窗、评论、采用和返回，并回归故事采编、结构、剧本及播放器。接口耗时与测试通过不能替代真实页面结论。


## 镜头视频版本与准确参考

镜头正文选择的是本镜视频的制作方案版本，普通进入默认最新版本，即使它尚无结果；准确地址中的 `shot_material_id`、`shot_plan`、`shot_candidate` 和手动选择优先。所有版本平铺，Prompt 与模型参数分别展示。旧结果只展示其真实 CALL 输入及提示词，不借新方案补造历史。普通实体／素材大卡仍沿用有真实候选版本优先的浏览默认值。

本页分集评论计数包含本集准确场镜，以及明确关联视频的所有制作版本、候选和定义来源；按评论 ID 去重，含已关闭记录，排除已删除记录、剧本和上游参考素材的评论。读取目录增加 `view=shots`；制作拆解仍沿原范围。右侧只列本镜明确关联的视频，左侧有序输入复用共用小卡。V 表示参考素材版本，C 表示该版候选；`V3 C_`、`V_ C_` 如实显示缺项。它们与本镜视频版本分开。

小卡与 Prompt 的 `@图片1` 等标记按真实身份和有序槽位打开同一大卡，重复标记共用同一槽位。同名不同身份、同素材不同用途不合并。已选输入优先使用准确版本、候选和组成；旧 CALL 只在其准确绑定方案与实际引用、组成、裁切、时间范围逐项一致时读取方案中的版本选择。普通浏览默认值不构成选定事实。

大卡只在从镜头参考入口打开时提供“选为本镜参考”。浏览、关闭与采用操作分开；保存不改变全局采用或素材认可。`POST /api/production/shot-reference` 接收操作 `id`、`requirement_id`、`expected_revision`、`plan_number`、槽位 `index` 与 `input_key`，以及准确上游 `material_id`、`number`、`candidate` 和 `component_id`。`candidate` 是 object_id/revision_id 引用，`input_key` 是服务端返回的原槽位指纹，客户端不能按名称重建引用。

同一事务核对当前镜头需求修订、制作版本、原槽位、候选归属与原件，保留其他槽位及既有裁切／时间范围；冲突返回409，无部分写入。结果返回新 `revision_id`、制作版本 `number`、逐槽状态及 `already_applied`。相同操作 ID/内容重试返回原收据，不重复应用；同 ID 不同内容拒绝。选择元数据 `material_selection` 和 `shot_reference_operation` 随不可变需求修订持久化，现有导出／恢复协议保持，不新增数据库表或业务迁移。

未提交方案修改同一草稿版并更新准确定义来源；首次 submitted/completed/failed/unknown 后锁定。镜头参考入口对锁定版的改选建立新制作版，即使选择相同实际输入；旧调用、原件、候选与评论不变。关闭保存中的弹窗后，迟到成功只刷新仍在原工作区的页面；刷新等弹窗历史条目返回后执行，避免丢掉准确版本地址。评论草稿保持其原不可变文本修订，不转绑新修订。

`generation.readiness`、生成包 HTTP/CLI 与新 CALL 登记统一调用准确槽位校验。缺版本／候选、版本与候选错配、原件缺失、失效引用、组成或裁切／时间范围不合法均拒绝；不从全局采用或最新结果自动补齐。新镜头调用必须携带准确 `generation_requirement`，单独 prepared_plan 不能绕过；已登记调用只允许状态登记而不能改写实际输入。参考完整仅解除参考阻断，准确方案采纳、其他范围、模型输入契约及既有生成条件仍须满足。本能力不提供前台生成提交。
