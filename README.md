# Story Review Desk

独立、可复用的故事创作审阅台。展示、审阅、评论与数据管理的通用系统代码在本仓库；每个故事仓库保存实例配置、业务数据、素材，以及该故事特有的后台创作工具。创作过程不属于审阅台系统功能。服务端为 Python 标准库 HTTP + SQLite。本分支提供制作思路、故事采编、故事结构、分集剧本、制作设定、素材管理和全剧制作入口；部署与作品接受以各实例的明确记录为准，见 [架构说明](docs/architecture.md)与[制作设计及契约](docs/production.md)。

首页为“制作思路”，默认“故事创作”，另可切换“生产制作”；旧 `workspace=current` 链接兼容进入新页。方法内容由故事实例的 `content/production-approach.json` 提供，通用系统只做阅读展示，不维护工作统计或执行进度。存储格式、清理清单和验收入口见[制作思路说明](docs/production-approach.md)。

## 启动一个故事实例

正式本机入口为故事仓库中的 Docker Compose：本仓库维护 Python 与 Nginx 两个系统镜像及通用代理规则，故事仓库只保存实例 Compose 配置；Nginx 长期运行于 `127.0.0.1:3000`，反代容器内 Python 服务。实例根目录需要 `config/instance.json` 和 `export/`；有方法文档时一并保留 Git 中的 `content/`。首次从公开导出恢复：

```bash
cd /path/to/story-review-desk-python
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo restore
cd /path/to/story-repo
docker compose up -d --build
```

已有 `.runtime/review.sqlite3` 时不要重复恢复。浏览器访问 `http://127.0.0.1:3000/`。`docker compose ps` 查看长期运行和健康状态；`docker compose restart` 重启，数据库通过实例目录绑定卷持久化。本机运行目录 `.runtime/` 不入库；此服务不提供网络鉴权，Nginx 仅绑定本机环回地址，不要改绑公网。若克隆的系统仓库不在故事仓库同级 `../story-review-desk`，构建时设置 `REVIEW_DESK_BUILD_CONTEXT=/实际系统仓库路径`。

Python 服务对套接字读写设置两秒空闲超时，浏览器只预连而不发送请求时不会无限占住服务。数据库操作仍在同一服务线程执行；该超时不限制业务计算总时长。本机 HTTP 回归包含空连接存在时另一请求仍能完成的检查。

可选的“AI 润色修改意见”默认从服务容器的 `OPENAI_API_KEY` 环境变量读取密钥（启动 Compose 的 shell 中提供）。“系统管理 → 系统配置 → 系统与 AI”可编辑模型、该模型支持的推理强度和密钥环境变量名；这里保存的只是名称，不是密钥值。若改用其他名称，须在本机、不入库的 `compose.override.yaml` 中给 `app` 服务添加同名环境变量透传，例如 `environment: [STORY_POLISH_API_KEY]`，并在启动 Compose 的 shell 中提供其值；仅修改页面配置不会自动把宿主机变量传进容器。选项按 [OpenAI 模型文档](https://developers.openai.com/api/docs/models)维护，具体可用性还取决于本机 API 密钥权限。新建或编辑评论时，有输入即可直接点击润色：系统先生成并核验包含故事背景、创作背景、阶段、原文上下文、各版本资料和草稿的参考快照，再调用 Responses API（`store=false`）；也可先单独点击“查看润色参考”。建议不会自动保存。未配置密钥时明确报错。凭据不得写进故事仓库。

站点图标可在同一“系统与 AI”配置页上传、选择、替换或清空；默认使用系统书页图标。图标保存在实例受管目录并随公开导出校验、恢复；格式、API 与迁移规则见[站点图标说明](docs/favicon.md)。

## 数据访问与公开同步

导入资料：准备 JSON 数组，每项至少含 `id,title,version_type,origin,source_url,collected_at,notes,blocks,assets`。每个 `block` 有稳定 `id` 和完整 `text`；同 ID 文本不可原地改写，修订请用新 ID/新资料版本。可选 `group:"folk-tales"|"expansion-directions"|"story-refinements"` 与非负整数 `order` 在故事采编左侧生成默认收起的独立二级菜单（对应“民间小故事”“扩写方向”“故事精修”）；分类归故事实例数据，菜单由通用系统实现。资料条目显示标题和当前修订的评论数，类型、来源等信息在右侧详情中查看。分类区分资料项数和评论总数；计数包含已关闭评论，零评论明确显示。三类创作子页持续选中一级“故事创作”，采编不再提供右上搜索框、资料总数或正文重复审阅按钮；通过浮动“查看评论”和正文高亮打开共用面板。精修菜单标题若已含“故事精修N”，则省略末尾重复的“第N版”；只简化菜单显示。`assets` 项至少有相对 `file`、`title` 和 `source_url`，文件必须放在实例的 `export/assets/`。演出可用 `media:{kind:"video"|"audio",file,label,note,url?}` 指向位于同一 `export/assets/` 的本地媒体，纳入导出哈希并可在网页播放/下载；仅作线索的外链仍可用 `media:{kind,url,label,note}`，不能计作已下载的演出。旁证可选 `references:[{label,url}]`，来源链接需 HTTPS。没有听辨的演出，`blocks` 不得伪装为完整整理文本。示例为 [故事实例](https://github.com/goosmanlei/SnakeSlayingRecord)。

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

制作设定审阅实体、完整状态、来源及关联素材；素材管理预览、比较和审阅实际原件；全剧制作按集／场／镜检查必要输入、显式采用版本和登记时间线。审阅通过不会自动采用，新候选不会覆盖旧采用。文字评论沿用原规则，图像区域和音视频时间段绑定精确修订与文件。完整关系图、用户路径、载荷、HTTP／CLI、迁移及恢复说明见 [docs/production.md](docs/production.md)。

制作设定以实体为入口，平铺角色、场景、道具、歌曲及实体数量。左侧只列实体并标出完整状态数，实体基础信息默认显示在卡片上方，下方平铺完整状态；打开实体默认选中按剧情来源排序的首个完整状态，并标为基础状态。搜索也匹配所属状态及设定；历史状态链接仍打开准确版本，评论继续绑定实际阅读的记录。未关联实体的项目共用设定单列，不计入实体数量。

剧本依据在全剧制作顶部简洁显示版本、确认状态和集数，不放入制作设定列表，也不提供确认说明展开入口。全剧制作默认首集镜头，可按集、场主动检查缺项；检查结果每页最多显示 20 项，进入页面不加载全剧缺项。底层剧本确认记录、精确引用和历史继续保留。

实体卡直接显示当前实体、全部完整状态与关联素材，用户在当前页评论，Codex 按意见修订。没有送审步骤或内容编辑入口。“采纳当前版本”只表达对当时内容的认可，采纳后仍可评论；新内容显示未采纳，旧采纳与意见保留。未映射完整状态的素材明确标为实体参考。界面、并发及 HTTP／CLI 契约见 [实体卡审阅](docs/production.md#实体卡审阅与版本采纳)。

完整状态描述实体此刻同时存在的外观、服装、伤势等，保留一个整体参考槽位，并允许增加细节、角度或声音补充。素材页维护准确状态与文件组成的覆盖关系；缺少整体参考、状态归属错误或转换依据不完整时，不能输出就绪包。旧局部状态和实际制作输入不改写，具体迁移与并发保护见制作契约。

批量准备使用 `production-import data.json --validate-only`，确认数据后去掉该选项提交。`production-file file` 导入受管原件，`production-ready ID` 检查缺项，`production-package ID --output directory` 仅在必要输入齐备时生成包含原件的目录包。页面下载的是同一精确输入清单。图像和音视频规格按实际文件探测；本分支 Docker 镜像安装 FFmpeg，直接用 Python 运行时也需在 PATH 提供 `ffprobe`，不能把未探测文件标为就绪。

已有数据库继续使用对象、修订和依赖表，无破坏式表迁移。导出清单升级为 Schema 3，包含历史生产修订的原件及组成；恢复需新版本系统，并在空实例执行。旧 Schema 1／2 的恢复保持兼容。导出和恢复不包含凭据，也不替代实际打开工程、观看与听辨作品。

`tests/test_complete_states.py` 验证完整形态、状态转换、整体与细节覆盖、就绪阻断和读取依赖并发保护；`tests/test_production.py` 验证原子批量导入、并发、来源、状态并存、一材多用、显式换版、变更复核、谱系、精确媒体评论和恢复；`tests/test_production_api.py` 验证真实 HTTP 上传、Range、来源及冲突响应。真实故事数据和浏览器操作证据归故事实例；测试夹具不计作媒体成果。

## 旧版交互核对

旧审阅台仅作为产品交互参考，未复制其代码、表或故事数据。核对结果见 [docs/comment-checklist.md](docs/comment-checklist.md)。

运行自动测试：`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost PYTHONPATH=. python3 -m unittest discover -s tests -v`；导航及审阅聚合前端测试使用 `node --test tests/*.test.cjs`。本机 HTTP 用例直连环回地址，避免被环境代理转发。
