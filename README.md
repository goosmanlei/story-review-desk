# Story Review Desk

独立、可复用的故事创作审阅台。展示、审阅、评论与数据管理的通用系统代码在本仓库；每个故事仓库保存实例配置、业务数据、素材，以及该故事特有的后台创作工具。创作过程不属于审阅台系统功能。服务端为 Python 标准库 HTTP + SQLite。本分支提供制作思路、故事采编、故事结构、分集剧本、制作设定与全剧制作入口；部署与作品接受以各实例的明确记录为准，见 [架构说明](docs/architecture.md)与[制作设计及契约](docs/production.md)。

首页为“制作思路”，默认“故事创作”，另可切换“生产制作”；旧 `workspace=current` 链接兼容进入新页。方法内容由故事实例的 `content/production-approach.json` 提供，通用系统只做阅读展示，不维护工作统计或执行进度。存储格式、清理清单和验收入口见[制作思路说明](docs/production-approach.md)。

素材卡按固定方案版本与候选显示一份相应生成内容，保留独立可读的历史方案、真实调用、原件与准确评论；接口、迁移与验证见 [素材版本与候选](docs/material-versions.md)。

## 启动一个故事实例

正式本机入口为故事仓库中的 Docker Compose：本仓库维护 Python 与 Nginx 两个系统镜像及通用代理规则，故事仓库只保存实例 Compose 配置；Nginx 长期运行于 `127.0.0.1:3000`，反代容器内 Python 服务。实例根目录需要 `config/instance.json` 和 `export/`；有方法文档时一并保留 Git 中的 `content/`。首次从公开导出恢复：

```bash
cd /path/to/story-review-desk
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo restore
cd /path/to/story-repo
docker compose up -d --build
```

已有 `.runtime/review.sqlite3` 时不要重复恢复。浏览器访问 `http://127.0.0.1:3000/`。`docker compose ps` 查看长期运行和健康状态；`docker compose restart` 重启，数据库通过实例目录绑定卷持久化。本机运行目录 `.runtime/` 不入库；此服务不提供网络鉴权，Nginx 仅绑定本机环回地址，不要改绑公网。若克隆的系统仓库不在故事仓库同级 `../story-review-desk`，构建时设置 `REVIEW_DESK_BUILD_CONTEXT=/实际系统仓库路径`。

Python 服务对套接字读写设置两秒空闲超时，浏览器只预连而不发送请求时不会无限占住服务。数据库操作仍在同一服务线程执行；该超时不限制业务计算总时长。本机 HTTP 回归包含空连接存在时另一请求仍能完成的检查。

可选的“AI 润色修改意见”默认从服务容器的 `OPENAI_API_KEY` 环境变量读取密钥（启动 Compose 的 shell 中提供）。“系统管理 → 系统配置 → 系统与 AI”可编辑模型、该模型支持的推理强度和密钥环境变量名；这里保存的只是名称，不是密钥值。若改用其他名称，须在本机、不入库的 `compose.override.yaml` 中给 `app` 服务添加同名环境变量透传，例如 `environment: [STORY_POLISH_API_KEY]`，并在启动 Compose 的 shell 中提供其值；仅修改页面配置不会自动把宿主机变量传进容器。选项按 [OpenAI 模型文档](https://developers.openai.com/api/docs/models)维护，具体可用性还取决于本机 API 密钥权限。新建或编辑评论时，有输入即可直接点击润色：系统先生成并核验包含故事背景、创作背景、阶段、原文上下文、各版本资料和草稿的参考快照，再调用 Responses API（`store=false`）；也可先单独点击“查看润色参考”。建议不会自动保存。未配置密钥时明确报错。凭据不得写进故事仓库。

站点图标可在同一“系统与 AI”配置页上传、选择、替换或恢复默认；默认使用系统书页图标。图标保存在实例受管目录并随公开导出校验、恢复；格式、API 与迁移规则见[站点图标说明](docs/favicon.md)。

各子页共用“短标识、页面标题、用途说明”页头，菜单、版本与表单采用浅色纸面和绿色选中状态。系统与 AI 的图标、评论润色分区仍使用同一保存机制；上下文字数限制为 1000—30000，模型与推理强度从服务端目录联动。导航、控件与配置交互的维护入口见[界面约定](docs/interface.md)。

## 数据访问与公开同步

导入资料：准备 JSON 数组，每项至少含 `id,title,version_type,origin,source_url,collected_at,notes,blocks,assets`。每个 `block` 有稳定 `id` 和完整 `text`；同 ID 文本不可原地改写，修订请用新 ID/新资料版本。可选 `group:"folk-tales"|"expansion-directions"|"story-refinements"` 与非负整数 `order` 在故事采编左侧生成默认收起的独立二级菜单（对应“民间小故事”“扩写方向”“故事精修”）；分类归故事实例数据，菜单由通用系统实现。资料条目显示标题和当前修订的评论数，类型、来源等信息在右侧详情中查看。分类区分资料项数和评论总数；计数包含已关闭评论，零评论明确显示。三类创作子页持续选中一级“故事创作”，采编不再提供右上搜索框、资料总数或正文重复审阅按钮；通过浮动“查看评论”和正文高亮打开共用面板。精修菜单标题若已含“故事精修N”，则省略末尾重复的“第N版”；只简化菜单显示。`assets` 项至少有相对 `file`、`title` 和 `source_url`，文件必须放在实例的 `export/assets/`。演出可用 `media:{kind:"video"|"audio",file,label,note,url?}` 指向位于同一 `export/assets/` 的本地媒体，纳入导出哈希并可在网页播放；音频不显示下载入口，受管文件与后台导出保持可用；仅作线索的外链仍可用 `media:{kind,url,label,note}`，不能计作已下载的演出。旁证可选 `references:[{label,url}]`，来源链接需 HTTPS。没有听辨的演出，`blocks` 不得伪装为完整整理文本。示例为 [故事实例](https://github.com/goosmanlei/SnakeSlayingRecord)。

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo import-sources /path/to/new-sources.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo remove-sources exact-source-id another-source-id
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo comments
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo config-get
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo objects
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
```

故事结构阅读页提供版本切换、章节目录、图文圈选和整体意见；每个“第 N 稿”按钮显示精确修订的全部现存评论数（含已关闭，文字、整篇、整图和区域各计一次），评论面板使用浮动按钮统一打开。已选方向后不显示回看／重选方向区，也不提供供剧本创作的版本确认控件。旧数据与底层接口保持兼容。图片和图示按阅读栏等比缩放，保留原始高清文件；窄屏也显示完整图幅，圈选叠层与图片边界一致。故事结构中的图片和图示可点击或按 Enter／空格在当前页面放大，按 Esc 或右上角关闭按钮返回原阅读位置；圈选评论模式不触发放大。

故事精修版本下可展开章节三级菜单：从各正文块首行的“第N章 章名”提取标题，不另存章节数据。选择版本自动展开，再点当前版本可收起且保留正文位置；点击章名跳到章首，当前章随阅读滚动与布局变化高亮。桌面沿用正文与目录各自滚动，窄屏跳转避开固定顶栏。该展示不改变原文块、字符偏移或评论锚点。

评论输入框聚焦时，⌘+Enter 与“提交评论／保存修改”按钮执行相同操作；Esc 与取消按钮执行相同操作，放弃本次未提交内容，已保存评论不变。普通 Enter 换行；中文输入法组合期间不触发快捷操作。输入框外 Esc 仍收起面板并保留草稿。保存期间按钮与快捷键共用限制，不能重复提交。三类页面及未来评论区的统一接入与隔离验收见[评论交互说明](docs/comment-checklist.md#评论输入与快捷键)。

本机草稿存储失败时，评论定位和列表重绘保留当前输入及选区；故事采编、结构稿和剧本切换后，按准确版本恢复本页面内保留的草稿。后来新建的草稿、明确采用的润色建议及取消操作仍优先，已取消或提交的草稿不会被旧失败记录自动恢复。此保护仅限当前页面会话，不能保证刷新或浏览器崩溃后恢复；出现存储失败提示时应复制未提交内容留存。

`comments` 输出评论、对象类型与精确修订、原文圈选 `anchor.quote`、所在正文块；资料评论另含资料标题/链接。Codex 可直接读 JSON，或 `GET /api/comments/context`。`GET /api/sources`、`GET /api/comments?source_id=...`、`GET /api/framework`、`GET /api/configurations` 供浏览器和工具读取。提交资料评论 `POST /api/comments`：`{source_id,anchor,body,id?}`；通用对象评论改用 `{target_object_id,target_revision_id,anchor,body,id?}`。文字锚点包含 `block_id,end_block_id,start,end,quote`，位置按 Unicode 字符计数，跨段 quote 以换行连接，服务端核对与不可变修订一致。图像和图示的整图、归一化多边形区域以及结构整体意见也使用同一接口；完整数据格式、方向选择、结构稿导入、改稿审阅和剧本交接见[故事结构接口说明](docs/story-structure.md)。修改 `PATCH /api/comments/{id}`：`{action:"EDIT"|"CLOSE"|"REOPEN",expected_version,body?}`，并发版本错误返回 409。评论有审计事件；重试相同创建 ID/内容幂等。配置可在页面或 `PATCH /api/configurations/SYSTEM|PROJECT` 保存：`{expected_version,updates:{...}}`；CLI 使用 `config-set SCOPE updates.json --expected-version N`。

导出写入实例 `export/materials.json`、`comments.json`、`objects.json`、`configurations.json`、`manifest.json`，清单对每个文件和被引用素材存 SHA-256。故事仓库公开同步操作：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
cd /path/to/story-repo
git add config/instance.json compose.yaml nginx export
git commit -m "Sync story review data"
git push origin main
```

同步前审阅全部评论：公开仓库意味着评论正文公开。凭据、数据库、浏览器草稿和日志只留本机。恢复只允许空实例，先验证清单、素材 SHA、评论锚点、对象修订、精确依赖与配置，失败不写入目标。故事结构选择、修订、评论、确认和图文资产沿用同一导出协议。

## 精修正文原地发布

作者准备好完整正文后，可使用受控 `replace-source-content` 原地更新无评论、无依赖的故事精修条目；普通资料导入仍保持不可变语义。该接口不依赖写作引擎，不规定如何创作。具体命令与限制见[原地替换说明](docs/source-replacement.md)。逐片段写作、候选重读和私有检查点由故事项目自己的后台工具负责，本系统不提供 `writing` 命令组或过程页面。

## 分集影视剧本

故事创作的“剧本创作”采用“选版本 → 选集 → 选场 → 阅读单场”路径，与采编、结构共用顶部页签。横向版本栏只显示版号；分集目录显示集号、场次范围、标题和评论数。选集即打开首场，下方常驻本集概览；左侧为有序场次、单场预计时长和评论数，右侧直接显示该场完整正文、时空及预计时长。场次由分集修订中的 ID 与正文块生成；可选的 `content/screenplay-summaries.json` 按分集精确修订提供简短摘要，缺失时仍可阅读。评论、圈选与 AI 润色沿用分集修订语义。完整版本通过 `screenplay-import` 或 `POST /api/screenplays` 原子发布；改稿使用新版本 ID，旧集与旧评论保留。数据库导出、恢复沿用现有协议；完整实例迁移还需保留项目跟踪的 `content/`。发布不代表接受故事、结构或剧本，也不推进项目阶段。格式、接口和验收见[剧本说明](docs/screenplays.md)。

## 制作数据与真实媒体

制作设定审阅实体、完整状态、来源及关联素材；素材管理按具体需求组织未生成、真实结果和历史版本，预览、比较和审阅原件；全剧制作按集／场／镜检查必要输入、显式采用版本和登记时间线。审阅通过不会自动采用，新候选不会覆盖旧采用。文字评论沿用原规则，图像区域和音视频时间段绑定精确修订与文件。完整关系图、用户路径、载荷、HTTP／CLI、迁移及恢复说明见 [docs/production.md](docs/production.md)。

制作设定分为制作拆解、实体管理、素材管理。制作拆解顶部按集切换、左侧列本集场次，正文按行展示本场全部镜头，每镜左侧内容、右侧本镜明确关联的素材；不在场顶部重复列共用素材。素材按明确需求、计划参考、实际输入或采用关联到镜头，上级归属不自动表示各镜使用。两管理页正文使用桌面三列共用小卡，底部共用分页，默认每页 10 个三列基准行；窄屏只重排当前页。实体按类型分组，支持集场、搜索和采纳筛选，小卡显示编号、当前完整状态数量和真实有效采纳状态。素材按真实集场分组，支持集场、媒体、生成结果与文本筛选，分别显示唯一素材数和展示项数；版本、候选和文件不增算素材。“有结果”包含历史版本，当前版仍可能未生成。普通点击弹窗审阅；大卡左侧素材列表只切换右侧，保留实体、状态与草稿。默认基础状态及准确历史目标沿用既有契约。完整口径与来源见[管理小卡契约](docs/small-cards.md)，大卡见[素材卡与关系契约](docs/materials-and-relationships.md)，制作归属见[制作拆解与镜头制作](docs/production-breakdown.md)。

剧本依据保留版本、确认状态和集数，不放入制作设定列表。全剧制作默认镜头制作，沿用集场及逐镜布局，在每镜显示所选视频候选的真实生成内容，未生成时显示准确方案。正文默认最新视频制作版；左侧准确参考可从共用大卡明确保存到本镜槽位，浏览不写入，缺项在所有后台生产入口阻断，锁定版改选建新版；完整契约见 [镜头制作](docs/production-breakdown.md#镜头视频版本与准确参考)。原组合与检查仍在“组合与历史”。进入页面不加载全剧缺项。底层剧本确认记录、精确引用和历史继续保留。

正文与逐镜素材弹窗复用完整实体／素材卡、历史版本控件和评论面板；实际可评论区域统一显示轻边线和评论图标。采纳认可当前基础信息、关系、完整状态和已有方案；描述或方案缺项不阻止内容采纳，生成前仍须完善并认可完整方案。采纳后按钮变为取消采纳，评论仍开放。新候选不撤销采纳，方案修改需重新认可。生成前必须检查明确采用的准确原件；不自动调用模型。真实音频使用可选段的波形播放器，缺失项只在具体素材需求中占位。完整契约见 [实体生成准备](docs/generation-preparation.md)。

完整状态描述实体此刻同时存在的外观、服装、伤势等，保留一个整体参考槽位，并允许增加细节、角度或声音补充。准确状态与文件组成的覆盖关系由后台工具维护，页面用于审阅、评论、版本选择及缺项检查；缺少整体参考、状态归属错误或转换依据不完整时，不能输出就绪包。旧局部状态和实际制作输入不改写，具体迁移与并发保护见制作契约。

批量准备使用 `production-import data.json --validate-only`，确认数据后去掉该选项提交。`production-file file` 导入受管原件，`production-ready ID` 检查缺项，`production-package ID --output directory` 在必要输入齐备且完整包的准确依赖与全部原件均有效时生成目录包；已采用的可选原件或历史输入缺失也会阻断导出。页面下载的是同一精确输入清单。图像和音视频规格按实际文件探测；本分支 Docker 镜像安装 FFmpeg，直接用 Python 运行时也需在 PATH 提供 `ffprobe`，不能把未探测文件标为就绪。

已有对象、修订、依赖和旧轮次记录继续保留。方案版本、候选及评论范围使用对应索引；完整素材定义集中保存，历史内容与受管归档按准确引用还原。完成完整定义迁移的实例使用 Schema 7 导出，包含唯一 `material-content.json`、准确版本绑定和归档路径索引；尚未完成该迁移的旧实例继续导出 Schema 5。恢复须使用支持相应格式的系统，并在空实例执行；兼容旧 Schema 1—6，校验历史身份、修订、评论、依赖与原件。完整契约见[素材、完整定义与候选](docs/material-versions.md)。导出和恢复不包含凭据，也不替代实际打开工程、观看与听辨作品。

`tests/test_complete_states.py` 验证完整形态、状态转换、整体与细节覆盖、就绪阻断和读取依赖并发保护；`tests/test_production.py` 验证原子批量导入、并发、来源、状态并存、一材多用、显式换版、变更复核、谱系、精确媒体评论和恢复；`tests/test_production_api.py` 验证真实 HTTP 上传、Range、来源及冲突响应。真实故事数据和浏览器操作证据归故事实例；测试夹具不计作媒体成果。

## 旧版交互核对

旧审阅台仅作为产品交互参考，未复制其代码、表或故事数据。核对结果见 [docs/comment-checklist.md](docs/comment-checklist.md)。

运行自动测试：`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost PYTHONPATH=. python3 -m unittest discover -s tests -v`；导航及审阅聚合前端测试使用 `node --test tests/*.test.cjs`。本机 HTTP 用例直连环回地址，避免被环境代理转发。

制作设定与素材管理共用素材卡；直接关系、历史采纳取消及准确实际生成信息见 [素材卡与关系契约](docs/materials-and-relationships.md)。
## 业务对象与历史读取

业务编号、版本与候选选择，以及关系旧说明清理后的读取与恢复规则见 [编号规则](docs/business-codes.md)、[实体和素材审阅](docs/materials-and-relationships.md)、[素材版本与导出](docs/material-versions.md)。系统管理的编号说明直接读取同一前缀定义。
