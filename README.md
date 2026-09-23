# Story Review Desk

独立、可复用的故事创作审阅台。展示、审阅、评论与数据管理的通用系统代码在本仓库；每个故事仓库保存实例配置、业务数据、素材，以及该故事特有的后台创作工具。创作过程不属于审阅台系统功能。服务端为 Python 标准库 HTTP + SQLite。整体框架已开放故事采编、故事结构阅读与系统配置，其他创作环节逐步迭代，见 [架构说明](docs/architecture.md)。

## 启动一个故事实例

正式本机入口为故事仓库中的 Docker Compose：本仓库维护 Python 与 Nginx 两个系统镜像及通用代理规则，故事仓库只保存实例 Compose 配置；Nginx 长期运行于 `127.0.0.1:3000`，反代容器内 Python 服务。实例根目录需要 `config/instance.json` 和 `export/`。首次从公开导出恢复：

```bash
cd /path/to/story-review-desk-python
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo restore
cd /path/to/story-repo
docker compose up -d --build
```

已有 `.runtime/review.sqlite3` 时不要重复恢复。浏览器访问 `http://127.0.0.1:3000/`。`docker compose ps` 查看长期运行和健康状态；`docker compose restart` 重启，数据库通过实例目录绑定卷持久化。本机运行目录 `.runtime/` 不入库；此服务不提供网络鉴权，Nginx 仅绑定本机环回地址，不要改绑公网。若克隆的系统仓库不在故事仓库同级 `../story-review-desk`，构建时设置 `REVIEW_DESK_BUILD_CONTEXT=/实际系统仓库路径`。

可选的“AI 润色修改意见”默认从服务容器的 `OPENAI_API_KEY` 环境变量读取密钥（启动 Compose 的 shell 中提供）。“系统管理 → 系统配置 → 系统与 AI”可编辑模型、该模型支持的推理强度和密钥环境变量名；这里保存的只是名称，不是密钥值。若改用其他名称，须在本机、不入库的 `compose.override.yaml` 中给 `app` 服务添加同名环境变量透传，例如 `environment: [STORY_POLISH_API_KEY]`，并在启动 Compose 的 shell 中提供其值；仅修改页面配置不会自动把宿主机变量传进容器。选项按 [OpenAI 模型文档](https://developers.openai.com/api/docs/models)维护，具体可用性还取决于本机 API 密钥权限。新建或编辑评论时，有输入即可直接点击润色：系统先生成并核验包含故事背景、创作背景、阶段、原文上下文、各版本资料和草稿的参考快照，再调用 Responses API（`store=false`）；也可先单独点击“查看润色参考”。建议不会自动保存。未配置密钥时明确报错。凭据不得写进故事仓库。

## 数据访问与公开同步

导入资料：准备 JSON 数组，每项至少含 `id,title,version_type,origin,source_url,collected_at,notes,blocks,assets`。每个 `block` 有稳定 `id` 和完整 `text`；同 ID 文本不可原地改写，修订请用新 ID/新资料版本。可选 `group:"folk-tales"|"expansion-directions"|"story-refinements"` 与非负整数 `order` 在故事采编左侧生成默认收起的独立二级菜单（对应“民间小故事”“扩写方向”“故事精修”）；分类归故事实例数据，菜单由通用系统实现。`assets` 项至少有相对 `file`、`title` 和 `source_url`，文件必须放在实例的 `export/assets/`。演出可用 `media:{kind:"video"|"audio",file,label,note,url?}` 指向位于同一 `export/assets/` 的本地媒体，纳入导出哈希并可在网页播放/下载；仅作线索的外链仍可用 `media:{kind,url,label,note}`，不能计作已下载的演出。旁证可选 `references:[{label,url}]`，来源链接需 HTTPS。没有听辨的演出，`blocks` 不得伪装为完整整理文本。示例为 [故事实例](https://github.com/goosmanlei/SnakeSlayingRecord)。

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo import-sources /path/to/new-sources.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo remove-sources exact-source-id another-source-id
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo comments
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo config-get
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo objects
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
```

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

## 旧版交互核对

旧审阅台仅作为产品交互参考，未复制其代码、表或故事数据。核对结果见 [docs/comment-checklist.md](docs/comment-checklist.md)。

运行自动测试：`PYTHONPATH=. python3 -m unittest discover -s tests -v`。
