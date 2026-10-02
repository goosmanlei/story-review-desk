# 按修订轮次审阅素材

每份具体需求只有一个素材版号。版本一包含建立需求、准备方案、首次调用和登记结果；产出后收到明确的修订意见才进入下一版。同轮的多条意见、方案修改、重试和结果登记归同版。一般讨论、评论编辑／关闭／重开、关联补全和调用状态登记不创建素材版。

页面在一个版本下同步展示该轮方案、准确输入、真实候选和原始调用；没有结果就显示“未生成”。内部记录修订、每次调用及文件组成仍然独立保存。素材版不是生成次数，也不改变旧链接、评论原锚点或准确采用。

## 生命周期与并发

既有 `production-import` / `POST /api/production/import` 在同一个事务中登记需求、调用与结果的轮次归属。调用后续状态修订沿用该调用的归属；同一原始调用与原件的关联补全沿用旧轮，不把旧原件放进待生成的新轮。失败批次与 `--validate-only` 回滚轮次及原记录。

创建修订评论沿用 `POST /api/comments`，正文和锚点契约不变，增加以下意图：

```json
{
  "target_object_id": "准确目标对象",
  "target_revision_id": "准确记录修订",
  "anchor": {"type": "global"},
  "body": "具体修订意见",
  "material_context": {"material_id": "需求对象", "number": 1},
  "material_revision": {"material_id": "需求对象", "expected_round": 1}
}
```

`material_context` 说明这条评论是在审阅哪个素材版本，服务端核对目标属于该轮；它使沿用同一底层方案的新旧轮评论保持隔离。`material_revision` 表明要修订素材：已有结果时首条意见创建下一轮；正在准备的轮次继续接收意见。UI 默认勾选“作为素材修订意见”，取消勾选即为一般讨论。历史版本可讨论，但不能以它绕过当前修订轮次校验。

数据库通过 `BEGIN IMMEDIATE` 串行核对当前轮次。两个请求同时以旧轮次提出首条修订，只有一个成功，另一个返回冲突且不留下评论或事件；刷新后按新轮继续提交。相同评论 ID 的相同请求重试不重复建版。编辑／关闭／重开沿用旧接口，不改变轮次。后台工具不传意图时只创建讨论；不传显示上下文时，归到包含准确目标的最新轮。

新增四张索引表：`material_rounds`（需求与轮次）、`material_members`（精确记录归属）、`material_feedback`（启动／参与修订的意见）、`material_comment_scopes`（评论的显示轮次）。它们不替换原对象、修订、依赖、评论和事件表。查询响应增加 `material_versions`；已有实体 `versions` 继续表示实体记录修订。

## 原始参考与模型约定

参考在提示词之前展示。仅有效媒体和明确的前置素材需求参与编号；剧情依据、实体说明不会冒充已提交媒体。按原列表顺序保留输入，并在每种媒体内依次命名“图片1”“音频1”“视频1”。原件组成、用途、裁切和片段均使用准确记录，不能用当前方案补写历史调用。

`production-generation-package` 返回 `label`、`input_index` 和 `input_contract`，并核对准确采纳、参考原件和选段。新执行调用必须匹配准备包；未知媒体指代契约返回 UNKNOWN 并拒绝登记有参考的新执行调用。完成既有真实调用仍沿用它已经执行的输入，不套用新规则改写历史。

- OpenArt 的 `gpt-image-2-5-sunburst` image2image 表单使用有序 `visualReferences`，最多 16 张图片。提示词用“图片1／图片2”说明各图用途；这是清楚的自然语言指代，不是凭空增加 API 魔法参数。2026-10-02 的模型表单 GET 已核对；实例保存原始表单证据。
- Seedance 2.0 采用按类型上传顺序的 `@图片N`、`@音频N`、`@视频N`。依据 [官方提示词指南](https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh)。本检查核对指代与输入对应；执行工具仍须核对该平台的尺寸、时长、数量和额度约束。
- 本实例 Seed Audio 客户端支持最多三条准确音频，并使用 `@音频N` 指代。数量依据 [官方模型说明](https://docs.volcengine.com/docs/DoubaoVoice/model-list?lang=en)，实际请求字段及片段约束以执行客户端为准。没有调用模型来验证声音质量。

参数标题为“参数 · 模型名”，未知模型如实显示。旧 `@review/call/model` 与 `@review/generation/model` 字段仍作为标题内可定位锚点保留。

## 评论与预览

右上图标是可点击、可键盘操作的按钮，打开共用评论面板，列出该块及所选素材轮次的所有现存评论，包括已关闭意见。文字跨块锚点按交集匹配；图像按组成和原件匹配整图／区域；音视频按组成、原件和片段交集匹配。按评论 ID 去重，其他块和轮次排除。没有意见时明确显示空列表。

图像卡统一为 300 像素高的预览框，同布局宽度一致。实际图幅按比例缩放；圈选 SVG 仅覆盖图幅，留白不能圈选。放大及参考弹窗逐层关闭，Esc 返回上一层并恢复触发控件焦点，保留页面位置和草稿。切轮保存各轮未提交编辑状态及本机草稿，不把旧锚点挪给新轮。

音频卡和参考预览不提供“下载原文件”入口；波形、静音、播放和选段评论保留。原件仍在受管媒体目录中，后台获取、导出和恢复不变。

## 历史迁移与恢复

旧修订不能自动当作素材轮次。先读取全部需求、调用、文件、评论与修改记录，人工审阅对应表，明确证据缺口，再执行：

```bash
PYTHONPATH=. python3 -m review_desk --instance ISOLATED_INSTANCE material-round-migrate REVIEWED_MAP.json --validate-only
PYTHONPATH=. python3 -m review_desk --instance ISOLATED_INSTANCE material-round-migrate REVIEWED_MAP.json
```

对应表格式为 `material-round-migration-v1`，包含 `expected_fingerprint`、非空 `members`（`material_id/number/revision_id/evidence`）；有历史素材评论时另提供准确 `comment_scopes`。指纹覆盖原对象、修订、依赖、评论、事件及轮次表。正式数据变化即拒绝；不删除原行，不覆盖已建立轮次。事务失败不留部分写入，同一对应表重跑为无操作。

Schema 4 导出保存四张轮次索引、原件校验、历史调用、评论锚点／事件及准确采用；恢复仍接受 Schema 1–3。Schema 4 必须包含完整轮次表，恢复失败回滚全部目的数据库写入。正式资源应用前重新备份最新库，在新副本演练；不能把启动快照覆盖到活库。

## 验证入口

`tests/test_material_versions.py` 覆盖生命周期、沿用方案评论隔离、并发首条意见、过期拒绝、批次回滚、迁移重跑和恢复回滚。`tests/test_input_contracts.py` 验证多图、混合媒体、真实顺序和错误指代。`tests/material_review.test.cjs` 验证块范围、跨块锚点和类型编号。

```bash
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost python3 -m unittest discover -s tests -v
node --test tests/*.test.cjs
PYTHONPATH=.:tests python3 tests/material_ui_server.py --port FREE_PORT
```

浏览器夹具包含横、竖、方图、两轮方案／原始调用、关闭与开放意见、音频片段、多图和混合方案及嵌套弹窗；只写临时数据库，不生成媒体。共用采编／结构和剧本回归另见 [评论验收说明](comment-checklist.md)。具体正式应用、实例迁移决策与浏览器证据由故事实例记录。
