# 分集影视剧本

故事创作的第三个页签为“剧本创作”。左侧按剧本版本展开分集，右侧展示完整动作与对白、场号、地点、时间与预计时长。版本、分集参数进入地址，可直接访问和刷新；没有剧本时展示空状态。时长为制作估算，不能当成片实测。

每次发布一份完整版本：版本本身沿用 STORY 对象，各集沿用 EPISODE 对象。导入不要求来源已获接受，不写结构确认，不改变 PROJECT 的 current_stage；正文必须明确待审阅。旧的 `script-input` 仍是“确认结构后交接”的既有接口，不与本导入混用。

## 数据与操作

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story screenplay-import imports/screenplay-01.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/story screenplay-get
PYTHONPATH=. python3 -m review_desk --instance /path/to/story screenplay-review
PYTHONPATH=. python3 -m review_desk --instance /path/to/story export
```

导入文件路径相对于调用命令时的工作目录。`GET /api/screenplays` 返回完整版本与分集修订；`GET /api/screenplays/review-context` 加入分集评论；`POST /api/screenplays` 接受与 CLI 相同的整版 JSON。失败全部回滚，不能留下半部剧本。同一 ID 和内容重复提交幂等；改稿用新的版本 ID 与分集 ID，保留旧版。

顶层必填：`format: screenplay-edition-v1`、`id`、`title`、`notes`、`review_status: pending`、`duration_kind: estimate`、`basis`、`episodes`。`basis.story` 指向已有 SOURCE，`basis.structure` 指向 story-structure，各含 object_id 与 revision_id，必须匹配存在的精确修订。可附可读 title、源内容哈希等说明。

分集按 number 从 1 连续排序；每集包括 id（以版本 ID 加连字符起头）、title、estimated_seconds、blocks、scenes。blocks 含稳定 id 和完整 text；scenes 含 id、heading、location、time、estimated_seconds、block_ids。场次必须按顺序覆盖全部正文一次，整集时长必须等于各场之和。本系统允许不同项目的片长策略；具体 3—5 分钟约束由该故事的验收检查。

整版及每集记录 STORY_BASIS、STRUCTURE_BASIS 精确依赖，整版另记录 EPISODE 依赖。既有 Schema 3 的 objects.json 导出包含所有这些正文、修订和依赖；comments.json 保留评论与事件。空库恢复后可原样阅读与定位；不得用旧导出覆盖正在使用的正式库。

## 评论与 AI 参考

复用现有评论接口，提交 target_object_id（分集对象）、target_revision_id（该集修订）、anchor、body。Unicode 偏移、跨段引用、高亮、编辑、关闭、重开和历史均沿用采编能力。浏览器草稿按版本所属的分集对象、修订、锚点分别存储。

AI 润色参考包含当前集、改编所用小说和结构的精确修订，另列实际项目阶段与剧本创作阶段，不把发布当接受。输入预算在三份文档间分配，截断处有 truncated 标记，当前引用与邻段另行保留；这不是对全篇的隐含完整读取。新结构不会替换旧剧本依据。未配置密钥仍明确报错，建议只能由用户采用，不能自动保存评论。

## 验证

自动测试与隔离浏览器入口见[评论核对](comment-checklist.md)。实例交付时另核对最新源版本、评论处理、全篇覆盖、片长估算、实际正文、空库恢复及正式资料保留。并行修改导航或首页时，在合并候选中复验三页切换、首页/导航、评论及润色参考；共享正式库和服务发布串行进行。

## 与制作设定、素材设计的接缝

本模块的实际形态是 STORY 版本引用多个 EPISODE 精确修订，每个 EPISODE 的 payload.scenes 内嵌场次，尚未创建独立 SCENE 对象。后续生产适配层必须保存整版修订、分集对象及修订、集内 scene_id，不能只凭场号或显示标题关联。不同集允许各自使用相同的场号；完整引用才能消除歧义。源小说与结构从 basis 及依赖读取，不另建来源事实。

当前实际 API 是 `/api/screenplays`、`/api/screenplays/review-context` 和已有评论/导出接口；生产设计中的 baseline、素材、镜头等接口仍属于后续设计，不因本剧本发布而声称已经实现。版本 ID 一经发布不改正文，调整场次或分集需发布新版本；旧版评论和生产依赖继续指向旧修订，生产对象换版须由对应模块显式处理。
