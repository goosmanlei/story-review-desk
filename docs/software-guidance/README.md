# 故事审阅台

独立的本地创作工作台：每个项目绑定一部故事，通过故事创作、故事设定、素材管理与全剧制作连接创作者和 AI 工具。“当前工作”与“系统管理”读取同一套业务进展，不另存第二份完成状态。

本仓库只维护通用软件，不含示例故事、媒体、数据库或凭证。新任务读取 [AGENTS](AGENTS.md) 和 [STATE](STATE.md)，再按需查看文档。

## 创建与运行

需要 Node.js 22.13+ 和 Docker。项目必须显式选择独立实例；不读取父目录故事作为后备。

    npm ci
    node scripts/instance-project-create.mjs --project ../my-story --title 我的故事
    cd ../my-story
    node review-software/scripts/instance-start.mjs --instance ./instance --offline --port 3000

首次创建使用独立 PostgreSQL 数据卷和私有网络。访问 http://localhost:3000，确认系统规则并导入资料。故事设定可由绑定本项目的 Codex 根据资料抽取；实体和素材先保存草稿，再预览、确认发布。初始化不采用剧本、放行素材或调用模型。

本地 Codex 使用既有登录与项目绑定，讨论和受控执行分开；其他 AI API 在系统配置中填写 API_KEY 的环境变量名，密钥值只放宿主环境。未配置密钥不妨碍非模型功能。

## 数据与交付

数据库是业务权威。复制项目目录不等于数据库备份；完整备份、便携导入与独立恢复见 [系统管理](docs/system-management.md)。恢复不覆盖原实例，不恢复凭证或活跃执行资格。

软件默认构建空实例 Node 运行壳；Sites 必须显式提供核验过的只读导出，仅供功能 review。软件源码提交与项目内容提交分开，项目用精确 core-lock 固定软件版本。

按任务阅读：[实例隔离](docs/instance-isolation.md)、[系统配置](docs/system-configuration.md)、[故事设定](docs/story-settings.md)、[素材关系](docs/material-relationship-architecture.md)。
