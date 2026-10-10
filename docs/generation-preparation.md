# 生成准备、准确输入与评论

用户直接阅读作品、看听原件并评论；AI 在授权内原地修订当前制作内容，保留实际整改说明。故事版本保持。没有逐对象审批要求，无人评论不能推断为质量认可。

## 方案与输入

ENTITY（实体）、STATE（完整状态）、REQUIREMENT（素材需求）、RELATION（关系与准确选择）、CALL（真实调用）和 ASSET（原件）沿原身份存取。RV／REPRESENTATION 与 DC／JUDGMENT 已退出活跃模型，不能导入或恢复。实体卡读取仍用 `production-entity-review ID`，可指定准确实体修订；返回内容、状态、方案、候选、来源与评论，不再返回审批状态。

每份预期素材使用稳定 REQUIREMENT，唯一当前方案保存在 `generation`，字段仍为方法、模型、参数、完整 Prompt、有序输入与输出规格。需求说明依赖，实际参考必须固定候选、组成、哈希和必要范围；不能默认取最新文件。

`production_description` 明确填写时优先；否则读取完整状态的非空维度或既有 description 块。标题、用途、剧情引文不能冒充制作描述。普通未知不自动阻断；确实影响制作的缺项由 `production_blockers` 表明。整体参考与局部参考各守其职责，描述完整不替代原件存在与实际看听。

当前上游修改后，生成准备重新核对当前内容和准确原件。缺失、撤回、错配、哈希不符、无效范围、循环或参数错误继续拒绝。已经提交的调用始终读取提交快照，不受当前上游变化影响。

## 准备与真实调用

`production-generation-ready ID` 与 `/api/production/generation-ready?requirement_id=ID` 检查准确方案、方法、输入锁、文件、范围、谱系、参数和执行渠道契约。`production-generation-package ID --output DIR` 写入空目录并携带准确原件；它只准备，不调用模型。

准备包包含当时当前方案、方法、完整 Prompt、参数和准确有序参考。对外调用之前通过 `/api/production/submit` 核对包摘要和并发标记并持久化快照；成功后才发请求。相同操作重放只查询原调用。回调沿 `/api/production/result` 归回原提交；候选由真实原件形成。完整协议见 [当前制作与候选](material-versions.md)。

任务授权、付费额度和正式发布权限由实际委托决定，方案无需内容审批不产生额外执行权限。

## 视频渠道、模式与输入角色

普通参考借鉴构图与身份；固定首帧或首尾帧要求渠道将图片用作端点。Prompt 写“以此图开始”不能改变上传角色。新视频方案使用 `generation.execution` 声明 `channel`、`mode` 与 `start_constraint`，每个直接输入使用 `role`。例如：

```json
{"execution":{"channel":"pippit-tool-cli","mode":"reference","start_constraint":"reference"},"parameters":{"duration":20,"resolution":"720p","aspect_ratio":"16:9","task_type":"reference"},"inputs":[{"reference":{"object_id":"exact-image","revision_id":"exact-revision"},"component_id":"original","role":"reference_image","use":"起始构图"}]}
```

`reference` 使用 `reference_image/reference_audio/reference_video`；`first_last_frame` 按顺序使用 `first_frame/last_frame`；`edit/extend` 的源视频为 `source_video`。`start_constraint` 分别为 `reference`（借鉴起始构图）、`fixed`（固定起点）或 `none`（未设计起点）。未知渠道、型号或模式保持待核实，不能因 Prompt、输入数量或能力开关单独正确就标为已验证。

`video_capabilities.json` 保存脱敏的只读渠道观察、CLI 版本和观察时间，`video_modes.py` 校验组合。当前 pippit-tool-cli 的 Seedance 首尾帧入口要求两张有序图片；2.5 配置还要求 adaptive 且禁止独立音频。2.0 Fast 未提供完整模式组合，不能继承 2.5 的限制或通过结论。单首帧路径尚无已核实入口。普通参考显式设置 `task_type=reference`，不同时设置 `generate_type=1`。配置变更需重新观察并更新契约；本地检查不证明账号权限、额度、服务接受请求或媒体效果。

计划检查可以在未选原件时核对模式、参数、角色与编号。就绪还要求准确候选、组成、哈希、范围和谱系全部通过。实际调用保留同一渠道、模式、参数、输入顺序和角色。当前方案随时可原地修改；已提交请求及旧 CALL 不改写。

## 意见与整改回查

文字块、图像区域、音视频时间和生成方案评论绑定准确对象、修订与锚点。右侧独立浮窗保持正文宽度、阅读位置和草稿；意见正文直接可读。关闭／重开仅整理意见，不影响对象可用性。

AI 用既有 `comment-handling-v1` 回应，保存原评论、实际说明及必要改后片段。制作意见保存当时原摘录；后来再次修改时明确当时回应与当前正文不同。缺失目标不跳到最新候选，不按相似文字定位。

Schema 13 保存原评论、事件、回应局部片段、真实调用、候选快照、原件与最小退役映射；旧审批和制作全文链不能通过导入或恢复复活。

当前方案、候选、音频播放器与共同素材卡的具体契约见 [素材卡与关系](materials-and-relationships.md) 和 [镜头制作](production-breakdown.md)。
