# 原素材的生产兼容确认

领域说明或适用场次更新后，系统仍保留完整新 Hash 和失效历史。若变化不影响原产物，可经本地受控维护确认兼容；不需要复制旧字节成新版本，也不伪造生成或审阅。

## 支持的边界

- 叙事说明：只改实体 description，且项目指引中的用户明确确认绑定新旧记录 Hash，证明年龄、外观、声线和原制作验收未改。不能把所有说明变更一律当作安全。
- 范围追加：原 scope、修订和证据逐项保留，仅追加新场及其依据；表现、维度、验收、关系和引用策略不变。原素材继续用于旧范围，不代表新增场景已采用。
- 指定版本必须在变化前已正式放行并为当前版本；原版本、SHA、定义、Prompt、实际输入和正式审阅不变。所有受影响父输入都须逐版本纳入确认。
- 原导入素材仅确认既有通过与契约，不声称实际模型调用已观察。现代原生素材额外验证原授权、Run、候选登记和输入链。

未列候选、旧版、退回、禁用、权利阻断和真实制作变化不解除。新的制作设计仍绑定最新完整需求 Hash；原计划、配方、ReviewEvent、Run 和媒体保持原样。恢复后的历史兼容事实可以保留，但不延续旧运行期的执行权限。

## 本地维护流程

使用 `scripts/instance-domain-production-compatibility.mjs`，请求字段由 `domain-production-compatibility-service.mjs` 的 `validateRequest` 定义。清单明确绑定改前发布、当前发布与运行期、领域图谱修订/SHA、有限版本、需求以及指引中的确认原句；不接受客户端自行提交的兼容证明。

```bash
npm run instance:domain-compatibility -- preview --instance /absolute/instance --file /absolute/request.json
npm run instance:domain-compatibility -- apply --instance /absolute/instance --file /absolute/request.json --preview-hash EXACT_PREVIEW_SHA
```

先审阅预览中的每个目标、实际媒体 SHA、原执行闭包及局部投影结果，再提交同一精确清单与预览 SHA。预览后任何事件、来源、媒体或运行期变化都会要求重新核验。多个未解释的域变化须逐次调查，不能跳过历史发生项。

提交在一个事务中追加兼容记录与发布回执。重复同一操作只回读回执；不创建新审阅、模型调用或生成权限。请求结果未知时先按 operationId 查询已有回执，不自动重试。Web 页面与公开只读镜像没有此维护写入口。

核心源码验收命令：`npm run test:domain-compatibility`（安装包不附带测试目录）。还须独立完成类型/构建、隔离实例与实际部署回读，测试通过不等于正式实例已生效。
