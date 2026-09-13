# 故事审阅台

一个项目绑定一个故事。当前工作、故事创作、故事设定、素材管理、全剧制作、系统管理沿用已有界面与交互；网页、项目 CLI 与助手共用对象服务。

本公开仓库只维护通用软件、Schema、测试和部署工具，不包含故事数据、媒体或凭据。

需要 Node.js 22.13+、npm、Python 3、FFmpeg（含 ffprobe）和 Docker（PostgreSQL 18.6）。macOS 使用 LaunchAgent，Linux 使用 systemd。数据库、Web 和一个后台工作器独立运行；Web 与工作器为原生 Node 进程。

```bash
npm ci
npm run project:create -- ../my-story --title 我的故事
cd ../my-story
npm run deploy                         # 当前核心分支已提交的 HEAD，本地部署
npm run deploy -- --target all --dry-run
```

创建命令使用当前核心仓库创建并部署空白项目；不导入故事、不调用模型。创建后访问项目配置的本地端口。

- [软件工作规则](AGENTS.md)、[发行状态](STATE.md)
- [系统架构手册](docs/handbook/README.md)：系统管理 → 系统架构；图文主册与当前项目只读实例映射。
- [数据与业务接口](docs/architecture.md)
- [部署、状态与恢复](docs/deployment.md)
- [导入导出与配置](docs/project-data.md)
- 项目目录资源审阅：`npm run review -- library status`；命名、文本选择与校验见[项目目录审阅](docs/project-data.md#项目目录审阅)。
- [过程资源管理](docs/process-cleanup.md)

独立开发时经受管执行器运行检查：`npm run process -- run --task development --phase contracts -- npm test`。业务测试使用隔离 PostgreSQL 与模拟模型，不产生实际创作或付费调用。
