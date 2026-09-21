# Story Review Desk

独立、可复用的故事创作审阅台。系统代码与后续系统迭代只在本仓库；每个故事仓库保存实例配置、业务数据与素材。V1 服务端为 Python 标准库 HTTP + SQLite。整体系统框架从第一版确立，当前只开放故事采编与系统配置，其他创作环节逐步迭代，见 [架构说明](docs/architecture.md)。

## 启动一个故事实例

正式本机入口为故事仓库中的 Docker Compose：Nginx 长期运行于 `127.0.0.1:3000`，反代容器内 Python 服务。实例根目录需要 `config/instance.json` 和 `export/`。首次从公开导出恢复：

```bash
cd /path/to/story-review-desk-python
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo restore
cd /path/to/story-repo
docker compose up -d --build
```

已有 `.runtime/review.sqlite3` 时不要重复恢复。浏览器访问 `http://127.0.0.1:3000/`。`docker compose ps` 查看长期运行和健康状态；`docker compose restart` 重启，数据库通过实例目录绑定卷持久化。本机运行目录 `.runtime/` 不入库；此服务不提供网络鉴权，Nginx 仅绑定本机环回地址，不要改绑公网。若克隆的系统仓库不在故事仓库同级 `../story-review-desk`，构建时设置 `REVIEW_DESK_BUILD_CONTEXT=/实际系统仓库路径`。

可选的“AI 润色修改意见”使用本机环境变量 `OPENAI_API_KEY`（启动 Compose 的 shell 中提供）；模型由“系统管理 → 系统配置”设置。先在页面查看将发送的故事背景、创作背景、创作阶段、原文上下文、各版本资料和草稿，确认后再调用 OpenAI Responses API，`store=false`。建议不会自动保存。未配置密钥时明确报错。凭据不得写进故事仓库。

## 数据访问与公开同步

导入资料：准备 JSON 数组，每项至少含 `id,title,version_type,origin,source_url,collected_at,notes,blocks,assets`。每个 `block` 有稳定 `id` 和完整 `text`；同 ID 文本不可原地改写，修订请用新 ID/新资料版本。`assets` 项至少有相对 `file`、`title` 和 `source_url`，文件必须放在实例的 `export/assets/`。示例为 [故事实例](https://github.com/goosmanlei/SnakeSlayingRecord)。

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo import-sources /path/to/new-sources.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo comments
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo config-get
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo objects
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
```

`comments` 输出评论、原文圈选 `anchor.quote`、资料标题/链接以及所在正文块；Codex 可直接读 JSON，或 `GET /api/comments/context`。`GET /api/sources`、`GET /api/comments?source_id=...`、`GET /api/framework`、`GET /api/configurations` 供浏览器和工具读取。提交评论 `POST /api/comments`：`{source_id,anchor,body,id?}`；`anchor` 包含 `block_id,end_block_id,start,end,quote`，位置按 Unicode 字符计数，跨段 quote 以换行连接，服务端核对与不可变原文一致。修改 `PATCH /api/comments/{id}`：`{action:"EDIT"|"CLOSE"|"REOPEN",expected_version,body?}`，并发版本错误返回 409。评论有审计事件；重试相同创建 ID/内容幂等。配置可在页面或 `PATCH /api/configurations/SYSTEM|PROJECT` 保存：`{expected_version,updates:{...}}`；CLI 使用 `config-set SCOPE updates.json --expected-version N`。

导出写入实例 `export/materials.json`、`comments.json`、`objects.json`、`configurations.json`、`manifest.json`，清单对每个文件和被引用素材存 SHA-256。故事仓库公开同步操作：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
cd /path/to/story-repo
git add config/instance.json compose.yaml nginx export
git commit -m "Sync story review data"
git push origin main
```

同步前审阅全部评论：公开仓库意味着评论正文公开。凭据、数据库、浏览器草稿和日志只留本机。恢复只允许空实例，先验证清单、素材 SHA、评论锚点、对象修订、精确依赖与配置，失败不写入目标。未来创作稿使用对象账本时会被同一导出协议覆盖。

## 旧版交互核对

旧审阅台仅作为产品交互参考，未复制其代码、表或故事数据。核对结果见 [docs/comment-checklist.md](docs/comment-checklist.md)。

运行自动测试：`PYTHONPATH=. python3 -m unittest discover -s tests -v`。
