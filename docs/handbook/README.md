# 审阅台系统架构手册

阅读入口：系统管理 → 系统架构。此目录是通用文稿的唯一维护来源，故事项目按固定软件版本只读继承。

- chapters：中文 Markdown 正文；按 manifest 的章节顺序组织。
- diagrams.json：声明式文本图源，统一领域配色、节点位置、关系类型和说明；assets 为确定性 SVG。
- manifest.json：阅读目录、最近核验日期、源码依据摘要及实体／接口族覆盖映射。

日常阅读从[系统全景](chapters/overview.md)开始。开发与维护流程见[开发质检](chapters/development.md)。

| 理解系统 | 理解协作 | 开发与维护 |
| --- | --- | --- |
| [系统全景](chapters/overview.md) | [状态与版本](chapters/versions.md) | [开发与质检](chapters/development.md) |
| [运行架构](chapters/runtime.md) | [分层与读取](chapters/layers.md) | [部署与数据维护](chapters/operations.md) |
| [领域职责](chapters/domains.md) | [接口与一致性](chapters/interfaces.md) | [当前项目实例册](chapters/instance.md) |
| [数据实体与关系](chapters/data-model.md) | [人与 AI 协作](chapters/collaboration.md) | [术语与实现索引](chapters/reference.md) |

Markdown 与 SVG 可直接在仓库中阅读；网页另提供搜索、放大、阅读位置保存、当前实例关系和从 Schema 提取的完整字段字典。

系统语义变化时更新相关正文和图表，再核对 sourceDigest；不能只刷新摘要绕过内容复核。普通创作变更由实例册读取当前数据体现，不编写另一份进度表。

构建工具提供 docs:diagrams、docs:check、docs:build，生成资源通过受管阶段使用。图源及 SVG 都纳入版本；网页 HTML、搜索索引和逐表字典属于构建产物。Markdown 使用 markdown-it 编译并关闭原始 HTML，实例数据通过 React 文本节点展示。

正文编辑后的核验方法：逐章检查来源；由 Node 的 SHA-256 对 manifest.sources 列出的 {path,sha256} 数组 JSON 计算 sourceDigest，更新 reviewedAt。docs:check 会拒绝来源、图源、表／类型／接口族覆盖和章节链接漂移；该检查不能判断语义是否正确。
