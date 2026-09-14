---
name: review-tasks
description: 在审阅台故事项目中讨论并批量发布正式系统优化或内容创作任务，按依赖与资源持续派工、跨会话核查续办，以固定表格查询任务审计。未澄清想法不入案。
---

# 正式任务

先读当前项目 README、AGENTS、STATE。账本根必须是当前故事项目，不能改用核心 worktree。使用 `npm run tasks --`；字段契约查 `help`，详细执行与恢复规则查 `review-software/docs/handbook/chapters/operations.md` 的正式任务管理。业务修改继续使用 review CLI 或 `/api/v1`，任务账本不代替业务权威。

## 讨论和发布

默认先与用户讨论目标、范围、交付物、验收、可行性和授权，即使第一次输入已经完整。用户认可讨论结论后正式发布，不再增加一次形式确认；本轮已认可的讨论直接沿用。未澄清完成前不生成任务编号、请求文件、草稿或审计事件，不放入想法池，不跨会话恢复。只剩未成熟想法时丢弃它；正式任务执行中遇到障碍则保留并标记阻塞。

一次输入可以包含多个问题，按独立目标、验收、依赖和改动范围合并或拆成合适数量的正式任务，不固定一次一个。讨论中说明拆分与依赖，保留每项原话、已认可要求和可行性结论；不要把未经讨论的部分混进发布。可行性未知时，可以讨论并认可为有明确产物的调查任务。每项原始要求都应映射到至少一个正式任务，不能因拆分而遗漏。

单项用 `publish {task:...}`；多项用 `publish {tasks:[...]}`，每项设置稳定 key，批内依赖写 `@key`，已有任务依赖写完整展示号或永久 ID。同一批的正式任务原子落账。每项须 `clarified:true` 和 `discussion:{approved:true,summary,feasibility,approvedRequirements:[...]}`。同一 operationId 重放返回原结果，不能改内容重用编号。发布只组织入队；用户已启动持续执行时，调度器在安全阶段纳入新任务。

发布成功后，用 `audit --operation-id 原发布编号 --format markdown` 回读，再自行调用 `commit --file -`，请求为 `{operationId,actor:"PROJECT_CODEX",publishOperationId:"原发布编号"}`。这一步已获授权，不再请示，也不要求任务领取或执行租约。只提交本地受管账本、绑定与必要阅读视图，包含尚未提交的完整前序链；不 push、不启动执行器、不随其他状态变更自动提交。报告发布任务、提交状态、实际 SHA 与账本序号。

使用专用入口保留其他已暂存、未暂存和未跟踪内容；不得以 `git add tasks/` 替代。视图不一致先核查再 `rebuild`。失败或中断保留已发布事实，先用 `commit-status --operation-id 原管理提交编号` 查看 Git 证据，再以相同请求恢复，不重复发布。原提交结果重放不会纳入后来事件；后续正式发布使用新的管理提交编号。未知 Git 锁、未结束合并／变基、受管文件暂存冲突或不能证明恢复范围时保留现场。

SYSTEM 首先改通用《审阅台》核心，再验证当前标准项目继承；CREATIVE 在当前项目业务接口内独立推进。保持本轮精确创作与外部操作授权，不恢复旧授权。默认优先级 2；依赖优先于优先级。已发布且未开始的同类任务可 merge、split；拆解覆盖全部原验收项，保留原案和关系。新目标或新范围先讨论再发布，终态只读。

## 执行和自动派工

用户启动执行后，主 Agent 维护唯一协调运行 `tasks run`，持续挑选未完成且可推进的正式任务。每个阶段 checkpoint、heartbeat；长命令 guard 自动续租。v1 账本须在没有活跃执行者和派工时先 `upgrade --file -`，保留旧事件及编号；旧 CLI 会拒绝 v2，不能降级写入。

项目最多同时占用 3 个不同正式任务。主 Agent 执行的任务、预留派工以及仍有未关闭派工的任务均计入；同一任务的辅助派工不重复增加任务数，但仍逐个占用实际 Agent 槽位。交回、空闲和 Agent 关闭结果未知不释放占用；最后派工关闭后，仍须完成父任务收尾。`TASK_CAPACITY` 表示正式任务上限，`MAIN_CAPACITY`／`AGENT_CAPACITY` 表示实际执行能力不足；旧超限记录只收敛核查和关闭，不继续启动。

每次完成任务收尾并释放空位后，主 Agent 自动重新检查 READY 待办、依赖和此前 deferred 候选，按优先级重新 `schedule` 补入；不等用户再次启动。用户指定某项完成后暂停时，用 `policy --run ID --file -` 保存 `{stopAfterTaskId:"任务编号"}`；该任务进入终态后 `next` / `schedule` 返回 `PAUSED_BY_POLICY`，收敛资源并停止协调运行，等待新指令。仍未满足依赖或资源冲突的任务继续等待。实际能力不足时降低执行并行度并说明原因；关闭未验证时主 Agent 串行，不把逻辑预留或受控测试描述成真实多 Agent 并行。`next` 保留未知资源的串行兼容，不绕过上限。

本 Skill 明确授权按任务需要启动 SubAgent，并自动选择模型与强度；不以 Ultra 为开关。主 Agent 保持用户选择的模型和强度。所有派工由主 Agent 统一发起，子 Agent 不再自行扩队。实际并发槽位以本轮宿主为准，包含其他未关闭 Agent；不可把固定建议数当可用数量。

| 工作 | 默认模型 | 强度 |
| --- | --- | --- |
| 明确查找、机械整理 | gpt-5.6-luna | medium |
| 多文件探索、研究 | gpt-5.6-terra | high |
| 常规实现、测试、修复 | gpt-5.6-sol | xhigh |
| 架构、高风险、争议核验 | gpt-6-astra | max |

正式任务使用项目专属 App Server。先经受管阶段执行 `backend probe --run ID`：按项目身份自动启动缺失服务或复用健康实例，核对 PID/出生时间、二进制 SHA/版本、专属 socket 身份和 RPC 隔离配置。启动锁防重复创建；未知 socket、服务归属或启动结果保留现场并报具体故障。不操作公共 daemon、其他项目或交互会话。机器绑定及服务状态仅存 runtime，不改 Codex 内部数据库，不使用 thread/delete。

Unix socket 采用 WebSocket Upgrade 和消息帧；proxy 只转发字节，不能发送 JSONL。`native probe` 是兼容别名，不接受公共 socket 或 slots 声明。能力记录区分关闭探测、真实执行及并行验证：配置上限、CPU/内存给出项目可用容量上界，减去全部未关闭子派工计算剩余槽位；空线程关闭不证明真实软件并行。未验证关闭时主 Agent 执行。至少两项真实派工的活动采样、已保存成果、验收及关闭通过 `backend verify-execution` 核验后，才报告真实并行已生效。

有可靠关闭能力时，主 Agent 为跨正式任务或同一任务的独立部分准备 `schedule` 候选，声明目标、交付物、逐项验收、资源及选择理由。自动使用表中策略，争议或质量不足时升级；超出宿主可用模型/强度时选择实际支持的配置并解释，不能声称切换已发生。返工使用新的派工和新的 Agent，记录 attemptOf 及新选择理由。

schedule 在一次事务内检查依赖、任务版本、资源和容量，记录派工意图。为选中派工登记独立受管 worktree，再调用 `backend dispatch --run ID --assignment ID --file -`，请求 `{operationId,prompt,workspace,baseCommit}`。后端在同一已核验服务保存创建意图、线程创建回执、精确工作区和 turn 身份，再启动工作。每个执行会话只绑定一项派工；这些是专属服务创建的工作会话，与交互会话原生 spawn 的子 Agent 分别归属，不要求原生父子字段相同。

`backend sync` 查询原轮次；调用回执丢失时按原编号核查，不换号重建或重跑。`backend collect --file -` 的 `{operationId}` 将已回读结构化成果登记为 DELIVERED。主 Agent 核验后 `assignment accept`。模型/强度由同一服务 model/list 实际支持项约束。

## 执行中的用户决策

`tasks run` 每秒检查未解决问题，变化时输出 `DECISIONS_CHANGED` 并在 runtime 保存发现时间与归属。主 Agent 读取这项通知后仍须实际向用户呈现；发现通知不等于提问回执。

新版 `backend ensure/probe` 同时维护项目专属的持久决策接收器；工作线程的创建、轮次与恢复订阅使用该连接，派工 CLI 返回不会断开接收器。接收器独立于协调租约保存问题与通知；没有活跃主会话时只保存待办，不能声称用户已经看见。接收器属于当前项目服务，原进程或版本无法核验时保留现场，不连接公共或其他项目服务。

每次派工后、heartbeat/checkpoint 和恢复前，主 Agent 查询 `decisions list --format markdown` 与 `decisions status`。未绑定消息或连接异常须先核查；不要只看轮次最终 JSON。已授权的普通实现选择由工作 Agent 自主处理；真正需要用户决定时，工作 Agent 在执行中调用注册的 `review_task_decision` 动态工具，提供稳定 key、问题、背景、选项及影响、建议、待决步骤和已完成工作。工具等待原请求的明确答复。宿主内建输入记为 INPUT，业务决定为 BUSINESS，命令、文件及权限审批为 APPROVAL；不支持的协议请求记录诊断并保留原消息，不能自动接受消除阻塞。`approvalPolicy: never` 不提供业务授权。

主 Agent 集中转达尚未呈现的问题，说明正式任务原题、派工和问题编号、选项/建议、影响及暂停的步骤。使用主会话真实提问工具或直接与用户对话；CLI 输出不等于实际提问。实际呈现之后才用 `decisions present --run ID --file -` 保存消息引用及提问内容。相同未解决问题沿用原提问；协调会话更换不会重置呈现记录。需要提醒时明确是原问题，不制造第二个问题。

答复前 `decisions show ID` 读取 `requestFields`，填写当前任务、派工、问题三层版本及不透明 bindingToken。`answer --run ID --file -` 接收这些字段、稳定 operationId、`actor:"USER"`、`explicitUserAnswer:true`、用户原话/消息引用 evidence 和结构化 answer。BUSINESS 使用 `{text}`；INPUT 使用 `{answers:{原问题ID:{answers:[...]}}}`；APPROVAL 使用原请求允许的单次 `{decision:"accept|decline|cancel"}`，权限请求使用 `{decision:"grant|deny"}`。审批前必须用 `show ID --runtime` 核对原始操作和权限并向用户说明；不能把业务选择当成命令授权。秘密输入、会话级授权、持久规则修改及不支持的请求保留诊断，由主会话在相应授权通路处理。

答复先落账，再由持久连接对原协议请求 ID 回传。重复 operationId 只回读，冲突、错误归属或过期版本拒绝。保存但未发送的答复可 `decisions deliver --run ID --decision ID`；已有发送意图则不重发，即使发送结果未知或服务重放原请求。`serverRequest/resolved` 也可能代表清理请求，超时、默认项、轮次完成均不代表用户同意或答复送达。业务动态工具须匹配原条目及完整回传内容才确认；其他类型使用原请求和原操作核查证据收敛。

派工 WAITING_DECISION 与普通 BLOCKED、执行 RUNNING、交回 DELIVERED 及正式 WAITING_REVIEW 分开。未解决问题不允许 collect、assignment result/accept 或 DONE；等待、空闲、断线和送达未知均保留未关闭 Agent、资源和正式任务占用，独立任务仍可按现有容量调度。正式任务可同时包含等待和执行中的不同派工，任务总状态仍为 RUNNING；通过 status/show 的派工附表、backend sync 和 decisions list 查看区别。

恢复先核查旧协调者及原命令，`assignment reconcile` 接续归属，再在受管阶段 `backend recover` 订阅原线程并读取原轮次，不自动启动新轮。旧连接/服务代次的请求不可直接用于新连接；问题和用户答复都保留。原请求失效后，`decisions reconcile` 使用原操作证据确认 DELIVERED，或为原本采用 FOLLOWUP、上一轮成功且未交回/关闭的 INPUT/BUSINESS 派工登记 FOLLOWUP。随后 `decisions followup --run ID --decision ID --file -` 的 `{operationId}` 只携带已保存答复继续同一范围；未知、失败、活动轮次不另起一轮，失效审批不变成新轮次授权。已关闭或不满足 FOLLOWUP 条件的派工先收尾，再由主 Agent 创建新派工；不能复用旧答复为新请求自动授权。

停止时先禁止新派工与新答复，保存检查点，`backend close` 核查原轮次、后台命令和线程卸载，再收敛相关决策为 CANCELLED 并 `assignment close`；不替用户填“同意/拒绝”。原问题、答复及未知送达历史保留。真实用户交互验收必须由主会话完成，按手册“真实决策往返验收”执行；模拟协议或 JSON 回读不替代真实呈现和用户明确答复，尚待用户参与时如实登记。

不可变读资源携带精确版本，可并行；同一文件、重叠目录或业务对象的写占用串行，范围未知按独占处理。逻辑资源使用 `core/...`、`project/...` 或永久对象身份，不使用机器绝对路径。代码派工使用独立受管 worktree；命令用 `guard --assignment ID`。主 Agent 串行整合共享核心、写正式业务数据、提交推送和部署；共享核心命令再加 `--core`。保留业务 CAS 和外部授权核验。

## Goal、交回和关闭

专属 App Server 由核心 `tools/app-service.mjs` 提供，正式任务是调用方；标准创建、安装及升级交付同一实现。运行态仍在 `instance/runtime/task-execution`，升级不重置服务与原操作关联，安装不启动历史执行。

三类恢复入口：服务异常退出且原 run 有效时，经受管阶段 `backend recover --run ID --assignment ID`；协调退出时，主 Agent 核验旧进程已失效，取得新 run，以任务/派工版本、`expectedRunId` 和检查点执行 `assignment reconcile`，再 recover；同实例机器重启时，先核对本机 scope、旧 boot 身份、过期活动记录及工作区，再按协调恢复入口续办。旧进程身份缺失、存活或归属不明时不接管。keeper 遇到 `PROCESS_LOCK_BUSY` 保留协调锁并重新核查，不自行续租；guard 在租约失效时仍拒绝执行，不能删锁或改绑定绕过。

`scope.json` 绑定本机、实例及规范目录；`runs/` 保存原协调运行，`bindings.json` 保存 originRunId、归属/恢复历史及服务、线程、轮次和原操作；`server/generations/` 保存旧服务代次。`decision-channel/calls/` 先存调用意图再存原回执；`backend-results/operations/` 保存按原操作索引的结果。这些内容仅存 runtime，不随普通项目包复制。恢复只能以精确成功回执补齐身份，唯一可见轮次也不是关联证明。已完成回读结果、执行中继续跟踪；CREATING、PENDING、RESULT_UNKNOWN 无法对账时保留原输入与占用，不换号重跑。

交付区分受控服务故障、协调退出和模拟 boot 切换。模拟不等于真实机器重启，源码安装 fixture 不代替实际项目固定版本升级、推送和部署验收；未验证部分如实记录。

专属服务长派工使用 FOLLOWUP，短工作使用普通单轮派工。上一轮已确认成功、尚未交回且未关闭时，`backend continue --file -` 接受 `{operationId,prompt}` 在原会话继续同一范围；保存原轮次历史，结果未知或活动轮次不再启动。新任务和返工使用新派工、新 Agent。专属服务暂不声明自动 Goal 能力；旧原生 Goal 仅在隔离、自动跨轮和父端暂停回读均验证后使用。Goal 完成不等于正式任务 DONE。

派工每个阶段保存 completedSteps、nextSteps、精确输入、成果及原操作编号。外部操作先登记 PENDING，结果保存 SUCCEEDED/FAILED；RESULT_UNKNOWN 先查询原编号，不重复调用，不丢弃原操作。交回结果用 `assignment result`，主 Agent 逐项核验后 `accept`。

Agent 完成、取消或被替换后立即收尾：先保存结果/检查点，再 `backend close`（`native close` 兼容）暂停并回读 Goal、停止活动 turn、核查后台命令、归档并验证卸载，同时保留 Codex 聊天历史。随后 `assignment close` 保存关闭及清理证据。相关辅助 Agent 同样关闭，不保留空闲 Agent 池，不给已结束 Agent followup 新工作。关闭失败或原操作未知时保留占用和恢复输入；依赖无关且资源独立的任务可以继续。

新会话从 status、事件、派工和成果恢复，核查旧协调进程、原生 Agent、进程、工作区、版本及操作。旧执行未明确结束时不接管受影响资源。用 `assignment reconcile` 保存核查；`backend recover` 只恢复本项目创建回执对应的原线程，不创建新轮次。服务缺失可重启所属实例，恢复后先查询原结果；已核验关闭的会话不重新加载。核查后收敛旧派工；返工使用新 Agent，旧串行任务仍可 resume。恢复不能仅凭 Markdown、旧对话或租约过期。用户要求停止时先停止新派工，收敛所有子 Goal、Agent 和命令，保存检查点，再 stop 协调运行。

正式任务 DONE 前必须逐项验收、接受成果、关闭所有相关 Agent 并完成 `cleanup:finish`、`cleanup:check`、`cleanup:complete`。SYSTEM 核验测试、核心与私库提交推送、本地与可达 VPS 部署；CREATIVE 按约定成果验收，DONE 不代作故事正式采用。未完成的人工验收使用 WAITING_REVIEW，未知和跳过如实记录。成果整合或恢复引用解除前不清理 worktree。

## 稳定表格审计

正式展示号为 `T-YYYYMMDD-NNN`（例如 `T-20260914-001`），日期取任务原始发布时间的 Asia/Shanghai 日期。同一项目同一日的 SYSTEM、CREATIVE、合并新任务和拆解子任务共用 001–999，跨日重置；终态、筛选、排序、重建均不改号、不复用。超过 999 时整笔操作以 `TASK_NUMBER_LIMIT` 拒绝，不能扩位或拆批绕过上限。

历史按首次发布的原始时间排序，同时间保留事件及批内顺序；只读回放计算映射，后续成功写入将尚未固定的映射随同一事件追加，旧事件字节和任务版本不因此重写。内部永久 ID、原依赖、历史引用和阅读文件身份继续保留。JSON 的 id、taskId、关系字段仍是永久 ID，task.displayId 提供展示号；不能用展示号替换运行绑定或外部操作身份。

完整展示号与旧 ID 均可用于 show、list/audit 的 --task、依赖、关联、派工及写入定位。expectedVersions 的键也可用任一编号，但同一任务的新旧键给出不同版本会被拒绝。写入在账本锁内统一解析永久身份后检查原版本和 operationId；同一操作只换别名仍回读原结果，改变语义须报冲突。旧操作原请求始终可重放，不能换 operationId 试探未知结果。决策等待、三层版本、bindingToken 和关闭/恢复闸门继续适用。

对话中列任务默认使用 `list --format markdown`，只列 READY、RUNNING、BLOCKED、WAITING_REVIEW。用户明确要求全部或包含终态历史时才加 `--all`，纳入 DONE、CANCELLED、MERGED。`--status`、`--type`、`--task` 与所选范围取交集；例如 `list --status DONE` 为空，`list --all --status DONE` 才返回已完成。JSON 与 Markdown 一致，show、status、audit 保持原语义，完整账本与生成阅读视图不删除历史。

面向用户的 list、status、audit、show 一律调用对应 CLI 的 `--format markdown`，直接沿用共享渲染器结果。任务事实来自事件回放与现场运行态；截图、缓存视图或记忆只用于格式参考。不要自行重新挑列、改写标题、缩短编号、概括同一任务或用散文替换表格。编号是纯文本完整展示号，不生成、补写或展开 `tasks/items` 文件链接。

基础列表长期固定七列、固定顺序：**任务编号｜任务标题｜类别｜状态｜优先级｜发布时间｜前置依赖**。标题始终原样使用正式 title，不截断、省略或概括；类别只显示 `SYSTEM`、`CREATIVE` 等合法英文原码，任务状态只显示 `READY`、`RUNNING`、`BLOCKED`、`WAITING_REVIEW`、`DONE`、`CANCELLED`、`MERGED` 原码，不补写中文标签或括号；无效类型、状态一律显示 `UNKNOWN`，状态数量汇总使用同一归一化口径。默认按原始发布时间升序、展示号打破平局；只有用户明确要求时使用 `--sort` 改排序。

任务编号和前置依赖只显示完整纯文本展示号 `T-YYYYMMDD-NNN`，不附加文件路径或链接。依赖顺序与权威任务记录一致：每个编号先单独转义，再以安全的格内换行分隔，一行一项；单项仍独占一行，多项不用逗号、顿号或路径拼接，无依赖显示“—”。不得为了换行把一个任务拆成多条表格行。

一行说明查询截至时间、范围、数量与状态分布。所有时间固定北京时间完整 `YYYY-MM-DD HH:mm:ss`，不在不同查询中切换为“今日”或相对时间。完成、进展、阻塞、成果通过 `--columns` 放在附表，不改变基础七列。执行情况用“项目｜当前情况”，详情用“字段｜内容”，派工审计单独显示模型/强度、Goal 和 Agent 关闭状态。零任务仍保留表头并明确 0 项；尚未发生用“—”，无法核验用 UNKNOWN，不编造百分比。

GFM 表格不提供可携带的精确列宽契约。共享渲染器通过只输出精简原码的类别、状态等短字段，尽量把响应式余宽留给完整标题；不得使用 Markdown 源码空格、零宽字符、截断或省略标题伪造列宽。终端验收必须把现场 CLI 结果经当前对话宿主实际显示后观察，确认仍是一张横向七列表格、长标题完整且仅在单元格内合理换行、多依赖仅在同一单元格内逐项换行，并且编号旁不出现相对或绝对路径。只检查 Markdown 源码、HTML 片段或字符串测试不能宣称当前宿主视觉验收通过。宿主确实无法维持结构时，只能在记录实际限制后对同一七列完整结果做当次展示适配；不把适配变成另一套默认表格，不引入文件路径链接或 HTML 全表。

任务记录及最终结果随私库长期保存；机器路径、线程身份、执行资格和探测回执只在 runtime。复制、导入、部署不自动执行队列，不恢复历史创作和授权。
