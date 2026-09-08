# 任务与证据协议

协议由 `review-software/scripts/instance-orchestration.mjs` 及当前发行包实现维护；先读该版本的命令帮助，不猜测缺失字段。所有控制输入、事件和结果是版本化 JSON，正文通过标准输入或 `--input` 文件传递。

## 任务发布

`submit` 的内容包含：

- `kind`：`CREATIVE` 或 `DEVELOP`，生产结果触发相应 QA。
- `title`、`goal`、`scope`：可判断完成的目标与明确任务边界。
- `acceptance`：`[{id,text}]`，稳定验收项 ID 供 QA 逐项引用。
- `inputs`：`[{ref,sha256}]`，`ref` 包含永久对象或文件身份及精确修订；不使用“最新版本”代替绑定。
- 可选 `dependencies`、`resources`、`priority`：先行任务 ID、完整互斥资源及用户优先级。v1 由 Main 定义依赖，Schedule 只跟踪和调度；用户任务不能自行指定派生 `parentId`，QA/返修子任务由状态机创建。
- 开发任务的 `execution`：明确 `cwd`、`repository`、`baseCommit`；这些绑定来自当前任务与项目，不由通用 Skill 写死。

授权来自当前项目激活记录的 `authorization`，包含可追溯的 `source`、`scope` 和 `automaticCompletion`。任务不得借继承扩大模式授权，补充任务沿用原任务链边界。验收或输入不清楚时先查实例事实，仅将需要用户判断的部分交 Main。

## 报告与终态

使用运行器提供的 Worker 结果接口，带当前任务与尝试身份。最终结构化结果包含全部字段：

```json
{
  "status": "SUBMITTED",
  "summary": "本次实际完成的工作和仍未确认的事项",
  "artifacts": [{"ref": "永久对象或文件身份及精确修订", "sha256": "64位小写十六进制SHA"}],
  "deliveryEvidence": [],
  "checks": [{"criterionId": "验收项ID", "status": "PASS", "comment": "观察事实", "evidenceRefs": ["精确证据引用"]}],
  "artifactHash": null,
  "code": null
}
```

生产阶段使用 `SUBMITTED` 或 `BLOCKED`；QA 使用 `PASS`、`FAIL` 或 `BLOCKED`，原样回传任务的 `artifactHash`，`checks` 覆盖每个 `acceptance.id`。验收项的状态为 `PASS`、`FAIL` 或 `BLOCKED`。

交付阶段使用 `DELIVERED` 或 `BLOCKED`，保留已通过版本的 `artifacts` 与 `artifactHash`。`deliveryEvidence` 在所有阶段都是必填数组，生产和 QA 可以为空，`DELIVERED` 必须非空；每项为 `{ref,sha256}`，分别定位实际交付回执及其精确 SHA-256，不能用改动 `artifacts` 来附加回执。没有 `artifactHash` 或 `code` 时相应字段使用 `null`，不能省略字段。

实际模型及推理强度由运行器记录。额外证据放在可定位的引用中，不能发明 schema 外字段；当前版本的结构化输出约束为最终权威。

QA 对全部验收项给出结论和证据。总结果 `PASS` 需要所有必要条件通过；明确不符合判 `FAIL`；缺输入、工具、观察或外部执行事实判 `BLOCKED`。报告不得以作者自评取代观察，不能把请求成功提交说成产物完成。

调度状态依次区分依赖等待、队列、执行、候选提交、质检、返修、交付和完成。原任务、返修任务、QA 和正式放行各有独立身份，但质量轮数属于同一任务链。第三轮失败后的继续或加轮必须绑定具体用户决策。

`decision` 包含已有开放请求的 `decisionId`、`action` 和用户回答摘要 `comment`；可用动作包括 `resume`、`cancel`、`retry`、`scale`。加轮使用 `additionalRounds`，并发调整使用 `concurrency`。取消使用该决策路径，不存在独立的 task cancel/update 接口。`scale` 的四类键与任务类别一致，每类是非负整数。

`decision` 的 `scale` 动作仅用于 `CONCURRENCY` 请求；其他阻塞可用独立 `scale` 命令调整并发，但不能因此消耗尚未解决的业务决策。调度器调用阻塞须响应它自身的 `SCHEDULER_BLOCKED` 请求，`resume` 或 `retry` 才恢复，普通模式重启不代表额度错误已解决。

未知执行的 `retry` 或 `cancel` 必须提供 `reconciliation:{status:"CONFIRMED_NOT_RUNNING",runId,threadId,turnId,evidenceRef}`，匹配已保存的原运行、线程和回合及实际核查证据；原记录未创建线程或回合时只省略对应字段。它在核查前继续占用资源和并发资格。实例恢复后的旧任务先重新明确激活授权，再响应 `EPOCH_REAUTHORIZE`，提供 `reconciliation:{status:"INPUTS_REVALIDATED",evidenceRef}` 核验精确输入；这不替代对旧执行未知结果的单独核查。

`RESULT_UNKNOWN` 记录原请求 ID 及未知范围，核对实际状态后再决定恢复。额度、限流和认证错误仅记录脱敏摘要。能力凭据、API 密钥和完整私有会话不能放入任务正文、Git、公开导出或 Skill。
