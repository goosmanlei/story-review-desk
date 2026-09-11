# 部署与恢复

在标准项目运行 npm run deploy，默认本地。--target local、vps-bj、all 选择目标；all 先本地后 VPS。本地失败停止；VPS SSH 连接不通报告 SKIPPED，退出码 2。全部所选目标及清理成功为 0；失败、结果未知或清理不完整为 1。

--help 列出参数。--dry-run 只检查，不构建、不修改实例、不切换服务。--source 可覆盖 instance/runtime/machine.json 的 sourceRepository。启动时固定当前分支完整 HEAD，使用 Git archive 的干净内容构建，不包含未提交文件。执行期间新提交不会改变本次版本，且不自动 commit、pull、merge 或 push。

每次输出 operationId；`npm run deploy -- --status ID` 查询，`npm run deploy -- --resume ID` 按原提交和原输入续作。未知结果必须使用这个入口核查，不能新建操作覆盖。部署锁拒绝重叠发布；程序退出后保留操作及精确恢复证明。不会读取封存故事备份。

本地构建完成后才暂时阻止新写入，等待在途任务结束，然后切换运行包；业务数据库保持原样。已有未知执行结果阻断切换。服务启动核对软件提交、实例、Schema 与后台工作器。运行包和受管软件均按 SHA 检查，未知修改不覆盖。保留当前、上一软件包及数据库恢复点；更旧已知资源按登记清理。

VPS 从同一提交按目标平台构建，导入本次冻结的本地业务包至独立候选数据库，验证后替换演示基线。本机配置示例：

```json
{
  "targets": {
    "vps-bj": {
      "sshHost": "vps-bj",
      "projectRoot": "/srv/story-review/my-story",
      "port": 3000,
      "listenHost": "127.0.0.1",
      "nodeBinary": "/usr/bin/node"
    }
  }
}
```

SSH 使用已有主机密钥与 BatchMode；目标需预装 Node.js 22.13+、npm、Python 3、Docker 和 systemd。部署不会修改 SSH 信任、安装系统依赖或接管旧版非标准项目。反向代理及 TLS 由目标本机配置管理。候选数据库切换前固定恢复点；中断后先核查实际指针，已生效只补核验，未生效按同一业务包恢复演练，不重放模型任务。

机器路径仅服务于部署和进程启动，业务导出不携带它们。Codex 助手可在本机 machine.json 配置 `assistant: {provider:"codex",codexBinary:"/absolute/path/codex",pythonBinary:"/usr/bin/python3"}`，沿用当前宿主登录。production.command 为明确配置的外部受控适配器命令数组；工作器通过 JSON 标准输入传入精确实际输入，输出媒体须位于分配的阶段目录。未配置适配器时不执行模型或媒体任务。
