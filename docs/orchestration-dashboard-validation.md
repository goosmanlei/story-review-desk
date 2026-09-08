# 多 Agent 协作页候选验证

本报告是开发阶段的实际验证记录，不能作为独立 QA 放行或交付回执。基础提交：`3fc0613fd593fb0afabcd8bb3794a1f30178b672`。准确候选提交及 `git show` 字节 SHA-256 由本次受控候选提交回执绑定；完整差异范围为该基础提交至候选提交。

## 实现范围

- 新增系统管理第四页签、独立 GET API、白名单任务与 Worker 投影、已完成记录分页、手动及有界自动刷新。
- 宿主通过现有 locks 挂载输出无凭据心跳；Web 校验实例、运行期与 30 秒时效，避免把模式 ACTIVE 或不同 PID 命名空间当成进程运行证明。
- 更新系统使用说明与技术附录的读取接口目录。协作账本不进入故事进度投影。
- 未修改 `.agents`、任务状态机、调度写协议或并发策略；未升级受管副本或操作故事业务数据。

## 已实际执行

在候选独立工作树执行：

```sh
git diff --check
npm run test:types
node --test tests/orchestration-dashboard.test.mjs tests/orchestration-dashboard-api.test.mjs tests/workspace-projection.test.mjs
npm run test:orchestration
npm run build
```

前两项退出 0。针对性服务/API/审计投影测试共 15 项通过；涵盖真实隔离仓库只读不改变修订、实例切换、23 条历史跨页读取、未知执行占位、QA 失败至返修及交付的真实账本流转、实际模型有记录/未记录、安全字段过滤、Hosted 在实例访问前拒绝、错误不透传及安全心跳边界。

`test:orchestration` 共 79 项：77 通过、0 失败、2 跳过。跳过的是需显式启动的真实 Codex 和 PostgreSQL 集成测试，未新增模型调用或将跳过视为通过。Node 构建退出 0，包含新增 `/api/instance/orchestration` 路由；已有大 chunk 与路由静态分类提示不是部署证明。

## 浏览器阻塞与未观察

实际执行的命令：

```sh
npx playwright test --config tests/core-regressions.ui.config.ts tests/orchestration-dashboard.ui.spec.ts tests/system-management.ui.spec.ts
```

16 项中 15 个浏览器用例在 Chrome 启动阶段失败，未进入页面；1 个无需浏览器的既有纯投影用例通过。观察到 `browserType.launch: Target page, context or browser has been closed`，进程以 `SIGABRT` 退出，关闭过程报告 `kill EPERM`。因此浏览器结果判为环境 BLOCKED，不能据测试代码或构建结果声称页面、键盘、零写请求、自动刷新、可访问关系或 390px 布局通过。

另有端口隔离问题：预览请求 4294，但该端口已被占用，运行器选用了 4295；上述命令的默认地址仍是 4294。由于 Chrome 尚未成功创建页面，没有据此取得任何验收结果。本次预览已通过所属执行会话停止（退出 130），没有停止占用 4294 的其他服务。未绕过进程/浏览器权限或换用其他路径冒充成功。

下一次应由 Main 安排获授权的浏览器环境，先在独立工作树启动并确认一个未占用的显式端口，再设置同一 `REVIEW_UI_BASE_URL` 重跑两个 spec；必须实际观察并补齐各验收项。新增浏览器用例覆盖页签、前进后退、分页、空态、错误态、未知模型、刷新上限、隐藏/卸载停止、Hosted 零请求和窄屏截图，但这些观察目前全部未完成。

## 阶段边界

本次状态为 BLOCKED。未通过独立 QA，未快进核心 main、push、发行或部署。核心集成与远端读回只能在后续独立 QA 通过的精确候选上进行。

阻塞时四池配置为 3/3/3/3；运行/等待依次为创作 0/0、创作质检 0/0、开发 1/0、开发质检 0/0。原因是浏览器环境权限，建议保留现有四池并发，由 Main 解决验证环境后恢复。
