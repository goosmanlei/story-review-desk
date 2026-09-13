# 过程资源管理

阶段登记、具名交接、保留范围、预算和精确清理统一见[手册：过程资源与宿主配置](handbook/chapters/operations.md#过程资源与宿主配置)。开发执行示例见[开发与质检](handbook/chapters/development.md#受管执行)。

父任务结束依次执行 cleanup:finish、cleanup:check、cleanup:complete；跨主机清理均须验证，未知结果保留恢复依据。封存备份不被系统访问或清理。
