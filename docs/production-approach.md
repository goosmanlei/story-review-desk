# 制作思路：实例方法文档

首页工作区为 `production.approach`，提供“故事创作”“素材生产”两个 Tab。无参数首页默认前者；`?workspace=production.approach&tab=materials` 直接进入后者。Tab 支持刷新、浏览器前进后退及左右方向键、Home/End。旧 `?workspace=current` 只在前端映射到新页，不再登记旧工作区或运行旧统计。

## 内容与系统的分工

系统提供只读加载、文字、目录、顺序流程、响应式表格和链接展示。本故事的方法、具体例子与引用保存在实例根目录的 `content/production-approach.json`，由 Git 管理，不写业务数据库，不生成对象修订、配置事件或进度记录。`GET /api/production-approach` 每次读取该文件；前端在一次页面会话中复用内容，修改文件后刷新页面即可看到更新。

文件可省略：接口返回 `null`，页面说明未提供方法，既有资料和审阅功能继续可用。文件格式错误时该接口返回 503，页面明确显示错误；不会阻止故事、结构、配置或评论加载。客户端只按文本节点渲染内容，链接只接受 HTTPS 或同源 `/?...` 工作区入口，不能注入 HTML 或可执行 URL。

最小格式如下。文档 `schema_version` 只描述阅读文档格式，与数据库或业务导出 Schema 无关。

```json
{
  "schema_version": 1,
  "tabs": [
    {"id": "story", "label": "故事创作", "title": "本故事的创作方法", "lead": "读者导语", "sections": []},
    {"id": "materials", "label": "素材生产", "title": "本故事的素材方案", "lead": "实现边界", "sections": []}
  ]
}
```

每个 `sections` 条目必须有唯一的字母／数字／连字符 `id` 和 `title`，可包含 `paragraphs`（文本数组）、`flow`（`title,text` 数组）、`table`（`columns` 与等长 `rows`）、`note` 和 `links`（`label,href` 数组）。可选的链接 `workspace` 表示仅在该工作区已经实现时显示入口，避免实例文档伪装未开放功能。正文应自行说明作品是否待审阅、哪些生产能力仍为方案，不能从导航开放状态推断作品已经生成或接受。

恢复实例时随代码检出 `config/` 和 `content/`，业务资料仍通过 `export/` 在空库恢复。方法文件不加入业务导出清单，不改变既有 Schema；仅有 `export/` 的备份并不包含这份 Git 文档。完整实例交付须同时保留实例仓库与业务导出。更新方法不需要数据库迁移。

## “当前工作”清理清单

清点基线为系统提交 `0a4e3cdbda844a779e9d1998a335699978733cde`。

| 类别 | 已移除的专用部分 | 保留部分及原因 |
| --- | --- | --- |
| 导航与登记 | `WORKSPACES.current`、旧导航标题／说明、旧页标题、默认首页分支 | 仅保留 URL 别名。其他工作区与阶段登记各有业务用途。 |
| 页面与统计 | `renderCurrent()`、三条工作链、阶段步骤、状态卡和逐资料行动队列；资料数量、OPEN 评论总数、结构稿数等首页汇总 | 故事页资料计数、当前文稿评论计数仍用于阅读／审阅，不依赖旧首页。 |
| DOM 与样式 | `#current-view` 及其 hidden 规则，`.current-heading`、`.current-lanes`／`.current-lane`、`.current-steps`／`.current-step`、`.current-board`、`.current-status`、`.current-queue`、`.current-item` 与窄屏规则 | 共同布局、故事阅读、配置与评论样式保留；修复共用窄屏导航挤压。 |
| 事件与请求 | 旧页渲染调用、卡片与队列的专用按钮事件 | 未发现旧页独占的 HTTP API、轮询、后台作业或事件写入。初始化的 sources/comments/structure/configurations/framework 请求仍服务既有工作区；评论刷新仍属公共评论能力。 |
| 缓存与浏览器状态 | 未发现旧页专用缓存或 localStorage 键，无需清理 | `state.current` 是当前阅读资料；评论草稿 localStorage、章节与阅读位置有独立职责，保留并验收。新页只以 URL 表达所选 Tab。 |
| 配置与持久化 | 未发现旧页独立表、列、持久对象、统计快照或专用配置，无迁移 | `PROJECT.current_stage` 被 `polish.py` 和全站侧栏／配置使用；故事、评论事件、不可变修订、依赖和配置事件全部保留。 |
| 测试与文档 | 架构中的旧首页职责说明已替换；没有旧首页专用测试需要删除 | `test_review.py` 中旧 `enabled_workspaces` 示例验证已废弃配置被拒绝，属于 Schema 兼容测试，不是运行中的首页追踪。 |
| 项目任务 | 无删除或迁移 | `codex.project` 任务账本在实例业务库之外，由项目工具维护，不属于页面数据。 |

没有创建“清空统计”迁移、改写历史评论或改变创作阶段。新页也不维护当前任务、运行统计、任务调度或生产执行引擎。

## 验证入口与后续集成

运行 `PYTHONPATH=. python3 -m unittest discover -s tests -v`。只读文档测试覆盖缺省、更新回读与错误隔离，既有系统测试继续覆盖评论、配置／润色参考及恢复。

浏览器回归使用独立数据与端口：`PYTHONPATH=. python3 tests/selection_server.py --port 8795`，打开 `/selection-tests`。除原 14 项圈选／定位测试外，增加方法页往返的正文位置、评论草稿和 Tab 历史测试。真实故事页面的首页、兼容链接、刷新、窄屏及正式入口须另外人工验收，不能只用夹具结果替代。

与剧本模块并行修改的交汇处是 `framework.py`、`server.py`、`app.js` 和 `index.html`。后集成的一方在独立工作区吸收最新 `main`，保留剧本登记、脚本文件、阅读容器、评论与润色上下文扩展，并联合核验首页、两 Tab、故事／结构／剧本入口及评论。新页不修改 `store.py`、`configuration.py`、`polish.py` 或业务导出协议。
