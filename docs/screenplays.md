# 分集影视剧本

故事创作的第三个页签为“剧本创作”，与采编、结构共用顶部页签；剧本页的标题和简短说明位于其下。页内依次横排可选版本和分集：版本只显示版号，按 API 原顺序排列，缺少有效直达参数时选择最新可用版本；分集卡显示集号、全剧连续场号范围、标题及评论数。下方常驻本集概览，左侧按原顺序列场次、单场预计时长及评论数，右侧只读所选场的完整动作与对白；原场名、地点、时间和预计时长显示在正文上方。选集即默认打开该集第一场，不出现空白正文。目录和正文从当前分集精确修订的 scenes、block_ids、blocks 生成，不另存场次，也不限制集数、场数。场号优先从 `s001` 一类场 ID 读取；其他 ID 按版本内场次顺序生成显示号，链接始终使用原 ID。版本、分集、场次分别使用地址中的 script、episode、scene 参数，可直达、刷新和前进后退；无效场 ID 回到本集首场，无效版本或分集回到可用版本与首集。横向目录自动将选中项带入可视范围。没有剧本时展示空状态。时长为制作估算，不能当成片实测。

本集简短摘要是可选的阅读辅助资料，放在实例根目录的 `content/screenplay-summaries.json`，格式为 `{"schema_version":1,"episodes":[{"object_id":"分集对象 ID","revision_id":"分集精确修订 ID","summary":"摘要"}]}`。`GET /api/screenplay-summaries` 只读返回这份资料；缺失时返回空数组，格式错误时返回 503。摘要必须依据对应修订正文撰写，按对象和修订同时匹配，新增版本没有摘要也可正常阅读。它不写入剧本对象、评论账本或审阅状态，也不改变原有剧本导入契约。当前 Schema 4 导出负责数据库与素材；部署或迁移完整实例时应同时保留项目跟踪的 `content/` 文件，摘要不在数据库导出包中。

菜单沿用原版本显示名；剧本页的版本栏仅显示“版本”加序号，例如“剧本一《把灯带回家》”显示为“版本一”。无法从标题解析序号时按 API 原顺序编号。这只是展示名称调整，不修改已发布对象、正文、修订、评论或链接。

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

整版及每集记录 STORY_BASIS、STRUCTURE_BASIS 精确依赖，整版另记录 EPISODE 依赖。当前 Schema 4 导出的 `objects.json` 包含所有这些正文、修订和依赖；`comments.json` 保留评论与事件。空库恢复后可原样阅读与定位；不得用旧导出覆盖正在使用的正式库。

## 评论与 AI 参考

复用现有评论接口，提交 target_object_id（分集对象）、target_revision_id（该集修订）、anchor、body。场 ID 只控制阅读视图，不改变评论归属；本集所有评论在任一场均可查看，正文高亮只落在当前场。集卡显示该精确修订下的评论总数，场卡显示引用覆盖本场的评论数，均包含已关闭评论；跨场引用可计入多个场次，但只计入所属分集一次。评论面板的待处理数量仍按未关闭评论计算。跨场评论显示完整引用，可分别定位引用开头和结尾。Unicode 偏移、跨段引用、编辑、关闭、重开和历史均沿用采编能力。未保存草稿按分集修订与精确锚点保留，切换集场及刷新后可恢复；AI 润色仍使用原分集精确修订。

AI 润色使用当前分集的准确修订与完整圈选，改编小说、结构的锁定身份始终保留；意见涉及改编依据时才读取其必要正文，不用新结构替换旧剧本依据。当前任务显示“剧本审阅”，项目阶段只在意见需要时作背景。正文节选有字符位置和 `truncated` 标记，不表示完整阅读全篇；完整参考共用一个字符总预算，必要内容超限时明确拒绝。未配置密钥仍明确报错，建议只能由用户采用后另行保存。

## 验证

自动测试与隔离浏览器入口见[评论核对](comment-checklist.md)。实例交付时另核对最新源版本、评论处理、全篇覆盖、片长估算、实际正文、空库恢复及正式资料保留。并行修改导航或首页时，在合并候选中复验三页切换、首页/导航、评论及润色参考；共享正式库和服务发布串行进行。

## 与制作设定、素材设计的接缝

本模块的实际形态是 STORY 版本引用多个 EPISODE 精确修订，每个 EPISODE 的 payload.scenes 内嵌场次，尚未创建独立 SCENE 对象。生产模块必须保存整版修订、分集对象及修订、集内 scene_id，不能只凭场号或显示标题关联。不同集允许各自使用相同的场号；完整引用才能消除歧义。源小说与结构从 basis 及依赖读取，不另建来源事实。

本剧本模块提供 `/api/screenplays`、`/api/screenplays/review-context` 和已有评论／导出接口；制作设定、素材和镜头记录由已实现的生产模块通过 `/api/production` 及其子接口管理，现行接口与数据契约见[制作模块说明](production.md)。剧本发布本身不表示已经确认生产输入、生成素材或完成镜头。版本 ID 一经发布不改正文，调整场次或分集需发布新版本；旧版评论和生产依赖继续指向旧修订，生产对象换版须由对应模块显式处理。
