# Story Review Desk

独立、可复用的本机故事资料审阅台。系统代码只在本仓库；实例配置、资料、素材与评论存放在故事仓库。V1 服务端为 Python 标准库 HTTP + SQLite，不需要安装依赖，默认仅监听 `127.0.0.1`。

## 启动一个故事实例

实例根目录需要 `config/instance.json` 和 `export/`。首次从公开导出恢复：

```bash
cd /path/to/story-review-desk-python
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo restore
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo serve --port 8765
```

已有 `.runtime/review.sqlite3` 时不要重复恢复，直接启动。浏览器访问 `http://127.0.0.1:8765/`。本机运行目录 `.runtime/` 不入库；此服务不提供网络鉴权，因此不要改绑公网地址。

可选的“AI 润色修改意见”使用本机环境变量 `OPENAI_API_KEY`，默认模型 `gpt-4.1-mini`（可用 `REVIEW_POLISH_MODEL` 更换）。仅把圈选文字和当前评论草稿发送至 OpenAI Responses API，`store=false`；不会发送完整资料或自动保存建议。未配置密钥时明确报错。凭据不得写进故事仓库。

## 数据访问与公开同步

导入资料：准备 JSON 数组，每项至少含 `id,title,version_type,origin,source_url,collected_at,notes,blocks,assets`。每个 `block` 有稳定 `id` 和完整 `text`；同 ID 文本不可原地改写，修订请用新 ID/新资料版本。`assets` 项至少有相对 `file`、`title` 和 `source_url`，文件必须放在实例的 `export/assets/`。示例为 [故事实例](https://github.com/goosmanlei/SnakeSlayingRecord)。

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo import-sources /path/to/new-sources.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo comments
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
```

`comments` 输出评论、原文圈选 `anchor.quote`、资料标题/链接以及所在正文块；Codex 可直接读 JSON，或 `GET /api/comments/context`。`GET /api/sources`、`GET /api/comments?source_id=...` 供浏览器和工具读取。提交评论 `POST /api/comments`：`{source_id,anchor,body,id?}`；`anchor` 包含 `block_id,end_block_id,start,end,quote`，位置按 Unicode 字符计数，跨段 quote 以换行连接，服务端核对与不可变原文一致。修改 `PATCH /api/comments/{id}`：`{action:"EDIT"|"CLOSE"|"REOPEN",expected_version,body?}`，并发版本错误返回 409。评论有审计事件；重试相同创建 ID/内容幂等。

导出写入实例 `export/materials.json`、`comments.json`、`manifest.json`，清单对每个文件和被引用素材存 SHA-256。故事仓库公开同步操作：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo export
cd /path/to/story-repo
git add config/instance.json export/materials.json export/comments.json export/manifest.json export/assets
git commit -m "Sync story review data"
git push origin main
```

同步前审阅全部评论：公开仓库意味着评论正文永久公开。凭据、数据库、浏览器草稿和日志只留本机。恢复只允许空实例，先验证清单、素材 SHA、评论锚点与引用，失败不写入目标。未来创作稿纳入实例业务表时，同一导出/清单/公开同步协议必须扩展覆盖它，不能只存运行数据库。

## 旧版交互核对

旧审阅台仅作为产品交互参考，未复制其代码、表或故事数据。核对结果见 [docs/comment-checklist.md](docs/comment-checklist.md)。

运行自动测试：`PYTHONPATH=. python3 -m unittest discover -s tests -v`。
