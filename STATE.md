# 软件状态

当前实现为 React / Next.js Node standalone、模块化 Node 服务、一个后台工作器与 PostgreSQL 对象存储。没有内置故事、媒体、数据库或创作授权。

- 构建版本：部署启动时固定完整 Git 提交；受管源码 .review-managed.json、core-lock.json 与运行包 release.json 分别绑定同一提交。
- 运行绑定：显式项目 instance/instance.json；本机路径、凭据引用、服务回执位于 instance/runtime。
- 业务包：版本 2，模块分块 NDJSON、原始资料和 SHA 媒体；从正式 API 导入导出，流式处理，无整包 16 GiB 限制。
- 当前数据库 Schema：1。部署拒绝身份或不兼容 Schema，不自动接管其他数据库。
- 本地或 VPS 上线事实由目标实例的部署回执、实际 API 和工作器证明；源码存在不代表任何目标已上线。
