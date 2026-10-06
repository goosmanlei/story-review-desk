# 制作拆解与镜头制作

“制作设定”包括制作拆解、实体管理、素材管理。“全剧制作”默认进入镜头制作，原组合与交付仍在“组合与历史”可读；新的场、集、剧组合编辑页面不在本次实现范围。

制作拆解顶部按集切换、左侧列本集场次，右侧按行阅读本场有序镜头设计；每镜左侧是目的、画面、空间、动作起止、承接和声音，右侧是本镜明确关联的素材。剧情原文通过准确来源弹窗查看。剧、集、场归属可筛选，但不把上级归属自动算作每一镜出现或使用，也不在场顶部重复列共用素材。

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
| 分集及本集场镜 | `/api/production/breakdown?episode=ID` | `production-breakdown --episode ID` |
| 选中范围 | `/api/production/context?object_id=ID&revision_id=SHA` | `production-context --object-id ID --revision-id SHA` |
| 素材筛选 | `/api/production/materials?episode=ID&scene=s001&media=image&status=ungenerated&search=文本&offset=0` | `production-materials --episode ID --scene s001 --media image --status ungenerated --search 文本 --offset 0` |
| 向上汇总 | `/api/production/summary?object_id=ID&revision_id=SHA` | `production-summary --object-id ID --revision-id SHA` |
| 实体／历史目录 | `/api/production/index?view=settings或history&object_id=可选ID` | 按类型的既有 production-list |

CLI 均以 `python3 -m review_desk --instance PATH` 为前缀。旧 CLI 素材列表每页 40 项，返回 total、offset、limit，按 offset 递增读取；管理页面使用 `grouped=1` 投影与[共用三列行分页](small-cards.md)，两种接口口径分开。列表按持续存在的需求计数，同一需求的多个版本和候选不重复计数。无已知需求关联的历史原件独立保留。

写入复用 `production-import` 和 `/api/production/import`，expected_version 与 expected_heads 在同一事务校验。批内准确引用可使用 `@前序对象ID`，提交时解析成不可变修订。校验模式执行同样的读取和校验后回滚。文件登记、审阅及采用继续复用现有接口，见 [制作契约](production.md)和[版本与迁移](material-versions.md)。

## 页面读取与验收

目录只读取所选集的场镜，正文请求当前场及各镜准确关联的素材，点击小卡打开完整素材详情；实体与历史入口使用各自目录，不先加载全部制作对象。快速切换以请求序号丢弃迟到结果，防止旧场、镜或候选覆盖新阅读对象。素材卡、播放器、评论面板及来源弹窗共用；返回保留准确阅读对象、滚动位置和草稿。窄屏依次排列导航、镜头正文和本镜素材。

自动测试覆盖父级、归属和汇总边界、准确历史引用、并发迁移与回滚。实际验收还需操作集场镜、三个子页、筛选、候选、原件与来源弹窗、评论、采用和返回，并回归故事采编、结构、剧本及播放器。接口耗时与测试通过不能替代真实页面结论。
