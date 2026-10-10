# 生产制作数据与审阅契约

系统承担展示、审阅、评论和数据管理；故事特有编制、真实模型调用和作品制作在实例工具中完成。生产制作保留视听制作、实体管理、素材管理三个入口。

## 当前内容与准确历史

实体、独立状态、关系、输入锁、视听集场镜及素材需求只有一份当前正文，稳定对象编号不变。制作域 `revision_id` 是该正文的稳定地址；更新同时核对 `expected_version` 和 `expected_content:{edit_token,content_sha256}`，冲突拒绝并保留工作草稿。修改镜头不推进父场、父集版本。故事资料、结构、小说、剧本和方法仍保留原有不可变版本。

一次生成在请求发出前保存准确方案快照，真实原件返回后形成一个候选。候选使用自身 Prompt、参数、有序输入、原件哈希与范围、必要故事和方法依据；当前稿变化不改变已提交请求。完整模型、回调、复用、迁移与 Schema 13 恢复见 [当前制作与候选](material-versions.md)。

## 数据契约

所有生产载荷采用 `format: production-<类型>-v1`。通用字段为 `title`、`blocks:[{id,text}]`；可审阅的说明必须有稳定正文块。下表列出各类型的业务字段；对象 ID、kind 和 expected_version 在导入记录外层。

| 类型 | 字段及约束 |
| --- | --- |
| input-lock | `screenplay` 精确引用、`episodes` 全部分集引用、历史确认事实（如已有）、`specification`。不得凭是否存在剧本自动填接受。 |
| entity | `entity_type:character/space/prop/song`、`subtype`、`aliases`、`facts`、`choices`、`unknowns`、`sources`。同一类型中的别名冲突必须显式解决。仅提及对象仍可登记，无自动制作要求。 |
| state | `state_model:complete-v1`、`entity`、`dimensions`、`reference_media:image/audio/none`、`sources`、`facts`、`choices`、`unknowns`。完整快照可跨场复用，不把局部伤势或普通动作独立当作状态。 |
| av-episode / av-scene | `reading_contract:audiovisual-three-part-v1`、`input_lock`、`sources`；集另有 `story_episode,number,scenes`，场有 `shots`。准确子项锁与范围须一致，集场说明存于当前工作稿。 |
| av-shot | `reading_contract:audiovisual-three-part-v1`、`input_lock,sources,purpose,key_states,products,duration_frames,fps,entities,states`。镜内状态及产物绑定已有准确需求，详见 [视听制作](production-breakdown.md)。 |
| requirement | `scope`、`slot`、`required`、`purpose`、`media_type`、`usage:generation_input/post_audio/editorial`、`entities`、`states`、`specification`，可选 `generation` 逐素材生成方案。缺项以槽位为单位显示。 |
| asset | `media_type`、`subjects`（可空，支持项目级声音）、`states`、`components`、`production` 实际制作引用、`lineage`。组件包含 `id,role,file,sha256,bytes,mime` 和实际宽高／时长等。必须有原件；工程素材可登记工程文件为原件。可选 `candidate_requirements` 绑定准确需求，但不表示已按该方案执行或采用。 |
| call | `method`、`status:planned/submitted/completed/failed/unknown`、`tool`、`model`、`prompt`、`parameters`、`inputs`、`outputs`、`receipt`、`usage`、`lineage`。completed 必须有实际结果；网络结果不明保留 unknown，不自动重复扣费。 |
| relation | `relation_type:adoption`、`scope`、`slot`、`asset`、`component_id`、`usage`、`crop` 或 `range`、`reason`。一个 scope＋slot 对应一个稳定采用对象，更新必须带 expected_version。 |


精确引用统一为 `{object_id,revision_id}`。故事来源可追加 scene_id、block_ids 和 quote，须属于该准确故事版本。制作引用使用当前稳定地址；生成实际输入另固定候选、文件组成、哈希及必要裁切或时间范围。缺失、错配、循环和并发冲突使整批回滚，不能按名称或最新文件补齐。

生产载荷通过 `production-import` 或同名 HTTP 接口写入。`--validate-only` 执行同一校验后回滚；批内后续记录可用 `revision_id:"@对象ID"` 引用前序结果。撤回不适用需求时原地更新 status、required 和 withdrawal_reason，保留候选及意见；不复用原编号或合并不同剧情状态。

## 原件、范围和就绪

`production-file` 登记原件，组件含 file、sha256、bytes、mime 及实际像素或时长。图像、音频、视频及工程保持真实类型；ffprobe 或格式头核验失败时不能宣称规格通过。工程 ZIP 不冒充生成视频，上传及外部制作不虚构模型请求。

`state_coverage` 明确素材实际覆盖的独立状态、overall/detail、组件及必要范围；局部裁切不能冒充全貌。一个候选可明确用于多个位置，但不能由共用文件推导用途。采用、选择生成参考、浏览候选与用户质量判断分别成立。

就绪和准备包检查必要输入、候选归属、组成、哈希、裁切／时间、真实规格、故事依据、方法及谱系。参数中的“4K”不代替真实尺寸，页面先前就绪不代替实际提交时重验。读稿、评论和准备包均不产生付费授权。

## 评论和实际整改

当前制作内容评论带 expected_edit_token，保存当时摘录、Unicode 位置和摘要；正文以后修改，不按相似句重新高亮。图像区域、音频时间固定候选、component_id 和 asset_file，时间须满足 `0 <= start < end <= duration`。整体意见使用 global 锚点。

生成字段、facts、choices、unknowns 通过共用文字块提供圈选。实际回应保存必要局部改后摘录；再次改稿会明确当前正文不同于当时处理结果。原作者、时间、原话、评论事件保持。故事评论继续原版本契约，见 [评论回查](comment-review.md)。

旧逐对象 JUDGMENT／REPRESENTATION 审批已退役，不能重新导入。没有意见或缺项为零不等于作品质量获得认可。

## HTTP 与 CLI

CLI 均从系统仓库运行 `python3 -m review_desk --instance /path/to/instance <command>`。导入文件路径相对调用目录解析，媒体包内路径相对包根解析。

| HTTP | CLI | 作用 |
| --- | --- | --- |
| `GET /api/production/entity-review?entity_id=&revision_id=` | `production-entity-review ID [--revision SHA]` | 当前实体／状态／素材、准确评论目标、出场及历史 |
| `GET /api/production?kind=&object_id=&revision_id=` | `production-get [--kind K] [--object ID] [--revision SHA]` | 类型、头修订或确切历史详情与使用反查 |
| `GET /api/production/source?object_id=&revision_id=&scene_id=&block_ids=` | `production-source ID SHA [--scene ID] [--block ID ...]` | 读取精确来源正文；历史来源不得静默换成当前正文。HTTP block_ids 为逗号分隔。 |
| `POST /api/production/import` | `production-import file.json [--validate-only]` | 同一事务验证／批量提交，保留乐观版本 |
| `PUT /api/production/files/<name>` | `production-file file` | 流式导入原件，返回组件描述；不会创建采用 |
| `GET /api/production/files/<name>` | 文件可由导出包读取 | 图像／音视频／工程下载，支持 Range |
| `POST /api/production/adopt` | `production-adopt file.json` | 显式选择确切版本及范围；含 expected_version |
| `POST /api/production/judgment` | `production-judge file.json` | 审阅或变更复核结论；含 expected_version |
| `GET /api/production/impact?revision_id=` | `production-impact SHA` | 递归反查当前受影响范围与已有决定 |
| `GET /api/production/readiness?scope=` | `production-ready ID` | 必要输入缺项、引用有效性和待复核项 |
| `GET /api/production/package?scope=` | `production-package ID --output directory` | HTTP 下载精确元数据清单；CLI 将同一清单及其引用的实际文件复制为完整目录包 |
| 既有评论与导出路由 | 既有 `comments/export/restore` | 共用审阅与空实例恢复 |

成功返回具体对象／修订／版本及引用，读取不存在的对象为 404，格式或文件错误为 400，expected_version 不符为 409。失败响应不能泄露凭据。文件导入与业务记录分为两步，失败的未引用文件不自动删除；生产业务导入成功后，输出完整引用清单便于核对。

当前制作提交、结果和候选复用另使用 `POST /api/production/submit`、`/api/production/result`、`/api/production/reuse-candidate`。接口协议见 [当前制作与候选](material-versions.md)。

## 共同界面与交付

管理页以真实业务编号和名称找到对象。实体卡保留独立状态选择，素材卡切换当前方案和候选；参数、完整 Prompt、参考直接显示。故事入口、镜头入口和素材管理共用大卡、评论与草稿规则。细节见 [管理小卡](small-cards.md)、[素材卡与关系](materials-and-relationships.md)、[视听制作](production-breakdown.md)。

当前模型完整导出为 Schema 13。空实例恢复验证正文、来源、配置、准确依赖、意见摘录、候选快照和全部受管原件；拒绝旧制作模型重放。正式迁移必须先在最新隔离副本演练、核对保护范围，再沿实例共享写入窗口事务应用。测试和源码交付不能代替正式服务、实际浏览器和原件检查；听审与视觉质量仍由具体制作任务判断。
