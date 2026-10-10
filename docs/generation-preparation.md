# 生成准备、准确输入与评论

用户直接阅读作品、看听原件并评论；AI 在本次授权内读取意见和上下文，修订后给出准确版本及改动依据。完整方案无需逐对象审批，也不要求已有评论或先关闭意见。无人评论不能推断为质量认可。

## 方案与输入

ENTITY（实体）、STATE（完整状态）、REQUIREMENT（素材需求）、RELATION（关系与准确选择）、CALL（真实调用）和 ASSET（原件）沿原身份存取。RV／REPRESENTATION 与 DC／JUDGMENT 已退出活跃模型，不能导入或恢复。实体卡读取仍用 `production-entity-review ID`，可指定准确实体修订；返回内容、状态、方案、候选、来源与评论，不再返回审批状态。

每份预期素材使用稳定 REQUIREMENT，生成方案保存在不可变修订的 `generation`。方案含 `format:generation-plan-v1`、`method:generate|reuse`、明确模型、参数、Prompt、输入、输出名称／说明／检查标准及真实 blockers。每个输入固定 `{object_id,revision_id}`，必要时另带候选、`component_id`、`crop` 或 `range`。需求引用说明依赖；真正交给模型的必须落实为准确原件。显式选择沿现有接口完成，不以默认最新候选补齐。

`production_description` 明确填写时优先；否则读取完整状态的非空维度或既有 description 块。标题、用途、剧情引文不能冒充制作描述。普通未知不自动阻断；确实影响制作的缺项由 `production_blockers` 表明。整体参考与局部参考各守其职责，描述完整不替代原件存在与实际看听。

上游出现新版本时，已有方案仍固定原准确引用。只要该输入有效可用，仍可准备；缺失、撤回、错对象修订、哈希不符、缺少组成、无效片段／裁切、循环或参数错误继续拒绝。显式换新输入须重新读取并修订方案和依赖；不产生变更通过决定。已冻结调用保持原输入。

## 准备与真实调用

`production-generation-ready ID` 与 `/api/production/generation-ready?requirement_id=ID` 检查准确方案、方法、输入锁、文件、范围、谱系、参数和执行渠道契约。`production-generation-package ID --output DIR` 写入空目录并携带准确原件；它只准备，不调用模型。

包内保存 `generation_requirement` 对应的准确方案、方法快照、最终 Prompt、参数、输入哈希与范围。新 CALL 提交时再次逐项核对，不能换输入、方法或参数。新调用拒绝 `generation_acceptances` 字段。已发生的 CALL 原文及其审批历史引用保持；退役摘要仅解释失效身份，后续状态登记仍不得改写执行事实。

任务授权、付费额度和正式发布权限由实际委托决定，方案无需内容审批不产生额外执行权限。

## 视频渠道、模式与输入角色

普通参考借鉴构图与身份；固定首帧或首尾帧要求渠道将图片用作端点。Prompt 写“以此图开始”不能改变上传角色。新视频方案使用 `generation.execution` 声明 `channel`、`mode` 与 `start_constraint`，每个直接输入使用 `role`。例如：

```json
{"execution":{"channel":"pippit-tool-cli","mode":"reference","start_constraint":"reference"},"parameters":{"duration":20,"resolution":"720p","aspect_ratio":"16:9","task_type":"reference"},"inputs":[{"reference":{"object_id":"exact-image","revision_id":"exact-revision"},"component_id":"original","role":"reference_image","use":"起始构图"}]}
```

`reference` 使用 `reference_image/reference_audio/reference_video`；`first_last_frame` 按顺序使用 `first_frame/last_frame`；`edit/extend` 的源视频为 `source_video`。`start_constraint` 分别为 `reference`（借鉴起始构图）、`fixed`（固定起点）或 `none`（未设计起点）。未知渠道、型号或模式保持待核实，不能因 Prompt、输入数量或能力开关单独正确就标为已验证。

`video_capabilities.json` 保存脱敏的只读渠道观察、CLI 版本和观察时间，`video_modes.py` 校验组合。当前 pippit-tool-cli 的 Seedance 首尾帧入口要求两张有序图片；2.5 配置还要求 adaptive 且禁止独立音频。2.0 Fast 未提供完整模式组合，不能继承 2.5 的限制或通过结论。单首帧路径尚无已核实入口。普通参考显式设置 `task_type=reference`，不同时设置 `generate_type=1`。配置变更需重新观察并更新契约；本地检查不证明账号权限、额度、服务接受请求或媒体效果。

计划检查可以在未选原件时核对模式、参数、角色与编号。`ready` 还要求准确版本/候选、文件、组成、裁切或时间范围及原有谱系检查全部通过。准备包保留 `execution`、各输入的 `role`、`material_selection`、计划位置、逐媒体编号与原件哈希。新 CALL 必须保留相同渠道、模式、参数、顺序、准确候选、组成、角色和必要范围；选定信息也可沿冻结方案准确追溯。改选保留模式和角色，已提交方案变更进入新制作版本。旧 CALL 不补造模式或改写回执，后续状态登记也不得改变原执行输入。

## 意见与整改回查

文字块、图像区域、音视频时间和生成方案评论绑定准确对象、修订与锚点。右侧独立浮窗保持正文宽度、阅读位置和草稿；意见正文直接可读。关闭／重开仅整理意见，不影响对象可用性。

AI 用既有 `comment-handling-v1` 回应：保存原评论及锚点摘要、实际处理说明、改后准确修订和可定位证据。原意见可打开准确改动再返回原阅读现场。暂不修改时说明原因与剩余问题；缺失旧目标明确提示，不能跳到最新内容。用户反馈、AI 自检和机器检测分开表达。

完整 Schema 12 导出保留评论、来源事件、回应、真实调用、原件、准确选择和最小退役凭据。`review_retirement.py` 对全部旧修订逐条分类、校验摘要并事务迁移；只迁必要意见，不保存旧审批正文或影子审批实体。重复应用不重复评论，旧包不能复活审批类型。

版本、候选、音频播放器与共同素材卡的具体契约见 [素材卡与关系](materials-and-relationships.md) 和 [镜头制作](production-breakdown.md)。
