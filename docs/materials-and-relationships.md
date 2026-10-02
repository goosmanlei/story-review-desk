# 素材卡与实体关系

制作设定用于审阅实体、完整状态和可执行的素材方案；素材管理用于审阅实际文件及其来源。两页使用同一张素材卡。实体修改通过评论交给创作工具完成，页面不增加编辑表单或送审流程。

## 页面与评论

基础信息常驻，“关系”展示全剧直接关系，再选择完整状态。图中主要关系靠近中心并先排列，其他关系向外延伸；所有关系均可滚动查看。端点只说明相关实体，不跳转。连线文字本身使用统一评论提示，选词后直接评论原关系修订，不重复展示一份解释。版本下拉在有历史时就地出现，适用集场在当前页弹窗查看准确正文。实例的 `config/entity-relationship-layout.json` 按实体列出 `primary` 与 `order` 的关系 ID；这是展示配置，不改变关系事实或采纳范围。

状态下以每份具体素材为卡片，固定两列；阅读区不足 720 像素时单列。图像和声音不会改变列数。图像按原比例缩至最高 420 像素，预览与圈选层同尺寸；多张图的组成 ID 即使都叫 original，拖选仍绑定实际点击的图和准确修订。无原件时只为该需求显示相应占位；已有声音直接显示波形播放器，不显示人物封面。

卡片依次显示产出名称、准确候选及版本、实际生成信息、生成方案。模型、参数、提示词和参考输入直接展开。当前方案和原始调用分别呈现，二者不能互相补写。候选不匹配当前方案准确修订时，独立展示它的实际记录，不假称按新方案生成。切换素材历史时保留原卡片及版本下拉；卡片位置仅为浏览上下文，不给旧素材补写当前需求。版本状态由下拉本身表达，不增加历史提示和返回当前按钮。原件、预览、回执等组成可切换；非媒体文件仅显示下载入口，不创建音频播放器。

实际调用的模型、参数和提示词使用共用文字圈选；图像和音视频沿用区域／时间锚点。素材管理汇总该素材历史版本、准确调用和关联方案的评论，定位调用评论后刷新仍保留素材卡上下文。旧素材评论打开原文件及原始生成记录。所有评论仍绑定准确修订。

参考输入在当前页打开准确版本弹窗，可查看原图、声音／视频片段、设定或生成方案，关闭后保留阅读位置与草稿。弹窗不切换审阅对象，不提供采纳或内容修改。执行条件、技术阻断与生成输入检查仍保留在工具契约中，不出现在创作素材卡；采纳时间与重复状态说明也不默认展示。

## 关系契约

沿用 RELATION，增加 `relation_type: entity`，与已有 `adoption` 采用关系分开校验和查询。无新表。示例：

```json
{
  "object_id": "relationship-person-place", "kind": "RELATION", "expected_version": 0,
  "payload": {
    "format": "production-relation-v1", "relation_type": "entity",
    "title": "人物 · 暂住 · 住所",
    "blocks": [{"id": "relationship", "text": "该阶段人物暂住此处。"}],
    "entities": [{"object_id": "person", "revision_id": "准确修订"}, {"object_id": "place", "revision_id": "准确修订"}],
    "label": "暂住", "direction": "forward", "category": "spatial", "basis": "script",
    "sources": [{"object_id": "episode", "revision_id": "准确修订", "scene_id": "s001", "block_ids": ["b001"]}],
    "applies_to": [{"object_id": "episode", "revision_id": "准确修订", "scene_id": "s001", "block_ids": ["b001"]}],
    "status": "active"
  }
}
```

两个端点必须是不同的准确 ENTITY 修订；方向为 `forward` 或 `mutual`。类型为人物 `personal`、空间 `spatial`、归属 `ownership`、使用 `use`、演唱／演出 `performance`。依据区分剧本事实 `script` 与制作选择 `production`；必须保留准确来源。`applies_to` 标明已核实的剧情适用范围，稳定身份关系可为空；不能把一次使用推断成永久持有。撤回用 `status: withdrawn` 新修订，原评论和历史采纳保留。

写入使用既有 `POST /api/production/import` 或 `production-import FILE`，携带 `expected_version` 与 `expected_heads`；可 `--validate-only` 预演。读取沿用 `/api/production?object_id=ID[&revision_id=SHA]`／`production-get ID`，不增加另一套存储。实体审阅响应增加 `relationships`、`related_entities`、`materialContexts`；准确关系修订纳入采纳的 `scope.relationships`。新增、撤回或改变关系后，需要重新认可生成准备；已有采纳仍可显式取消。

## 原始生成记录与兼容

ASSET 的 `production` 是实际 CALL 的准确修订。读取素材时返回 `review_context: {call, requirements, inputs}` 和历史素材版本的 `review_contexts`。实体媒体条目也返回这一上下文。即使 CALL 后来登记完成、当前方案改写，也不替换原输入。

CALL 投影 `@review/call/model`、`@review/call/parameters`、`@review/call/prompt` 为可评论字段。参数文本由服务端产生；参数中与主提示词完全相同的 `prompt` 只展示一次，原数据不改动。既有正文与生成方案评论锚点保留。

生成方案不再要求或展示 `tool`，执行包也不指定工具。执行者核对平台、额度和接口后选择工具，并在真实 CALL 的 `tool` 中记录；提交后的工具仍不可改写。旧方案中的工具字段保留历史，不能作为新的业务审阅前提。

旧 `entity-current-v1` 采纳不转换为生成许可。用户可取消它，即使当前描述／方案未完善：实体响应给出 `can_revoke`、`revoke_target` 和规范决策的 `decision_version`；取消请求必须带准确 `decision_ref`。规范决策追加 revoked 修订，指回旧采纳，旧对象不修改。后续读取优先规范决策，不能使旧采纳复活。内容变化后的新模型采纳也可取消，取消不要求当前方案完整。

## 验证与恢复

`test_material_relationships.py` 验证旧采纳取消、并发拒绝、关系变化后的重新认可、素材采用隔离、原调用评论和导出恢复；`material_review.test.cjs` 验证准确方案与候选匹配、一材多用和调用参数投影。浏览器核对两列、旧取消、展开信息、关系分层与直接评论、参考弹窗和草稿保持、素材版本、波形选段、窄屏及故事／结构／剧本／草稿回归。

Schema 3 导出保留所有关系、决策、调用、文件及评论事件；可选关系展示配置作为 `entity-relationship-layout.json` 进入校验清单，空实例恢复写回 `config/`，含此文件的导出须使用支持它的系统版本；恢复须使用支持本契约的系统。实例的实际批次、浏览器操作和空库恢复证据由故事仓库保存。接口测试或播放器推进不代表创作接受或实际听辨。

## 验证入口

`python3 -m unittest discover -s tests -v` 与 `node --test tests/*.test.cjs` 覆盖准确生成信息、旧版卡片定位、可取消采纳、描述型状态、显式需求清理的评论／历史依赖保护与事务回滚，以及关系显示配置的导出恢复。页面在隔离实例验证关系不跳转、直接圈选评论、素材历史版本往返和参考弹窗关闭后的草稿与阅读位置；这些交互检查不代表媒体创作质量已通过审阅。
