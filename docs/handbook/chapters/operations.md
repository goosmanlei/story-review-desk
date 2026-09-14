# 部署、数据与运行维护

## 创建和部署

![固定提交与本地、VPS 顺序发布](../assets/deployment.svg)

```bash
# 在核心仓库创建空白故事
npm run project:create -- /新项目目录 --title 故事名
# 在故事项目部署
npm run deploy
npm run deploy -- --target local
npm run deploy -- --target vps-bj
npm run deploy -- --target all --dry-run
npm run deploy -- --status OPERATION_ID
npm run deploy -- --resume OPERATION_ID
```

默认发布本机核心仓库当前分支的已提交 HEAD，无需先 push。启动时固定完整 SHA，从 Git 内容建立干净构建目录；未提交和未跟踪修改不进入包。部署器不会自动 commit、pull、merge 或 push。`--source` 可以覆盖本次核心源码位置，路径不成为运行依赖。

all 先本地后 VPS；本地失败停止。SSH 不通报告 SKIPPED 并返回可区分的非成功码；已连接后的发布失败不能伪装为跳过。退出码 0 表示所选目标及清理全部成功，2 表示包含跳过，1 表示失败、结果未知或清理未完成。

## 宿主依赖与目标配置

需要 Node.js 22.13+、npm、Python 3、FFmpeg（含 ffprobe）、Docker；使用离线引用快照的项目还需要 Git 与 Git LFS。Linux 使用 systemd，macOS 使用 LaunchAgent。SSH 使用既有主机信任和 BatchMode。普通部署检查依赖，不安装系统软件或接管旧版非标准目录；反向代理及 TLS 由宿主管理。

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

目标配置只存本机运行配置，不进入普通项目包。

## 从构建到实际切换

隔离构建验证版本、依赖与包完整性。本地切换前短暂停止新写入并等待在途任务；业务数据库保持原样。VPS 将冻结的本地业务包导入新的候选数据库，核验后切换演示基线。

实际服务核验软件 SHA、实例身份、数据库 Schema、后台工作器和媒体。未知操作阻断覆盖发布。使用 status 查询，resume 使用原编号、原提交及原业务输入；远端已成功并清理完成时，只补齐本机回执，不重新执行远端发布。

## 项目包与配置

![可导出业务与本机私有运行信息的边界](../assets/package.svg)

版本 2 项目包由 manifest、模块分块 NDJSON、原始资料及 SHA 媒体构成，流式处理。单条记录上限 64 MiB，整体不要求装入内存。保留永久身份、草稿与采用头、关系、必要历史、未采用候选和正式证明。

导入仅允许空白独立实例，核对所有分块、原件和 PRESENT 媒体的字节 SHA；MISSING 和 RETIRED 保持原事实。素材附件、来源及使用位置还须通过与普通保存相同的对象、修订和 SHA 校验，任一失败回滚整笔导入。拒绝路径逃逸、符号链接、非空数据库或身份冲突。不恢复旧队列、会话和生成资格；导入产生新运行期，旧页面必须重新读取。

| 配置归属 | 例子 | 是否进入普通项目包 |
| --- | --- | --- |
| 系统 | 审阅标准、主体／素材类型、制作阶段、资源上限 | 是，独立 scope |
| 项目 | 标题、外观、画面基准、来源优先级、资源目录文本选择 | 是，独立 scope |
| 本机 | 数据库连接、端口、源仓库路径、宿主认证和执行命令 | 否 |

字段只有一个归属，不建立多层同名覆盖。具体合法字段由项目配置契约校验。

## 资源审阅目录

review-library 是便于人在文件管理器中阅读的只读投影。文件使用带正确扩展名的硬链接，与 SHA 媒体或显式选择的文本缓存共享同一文件内容，支持系统按扩展名选择打开应用；媒体不产生额外副本。项目根入口仍用相对软链，后台约每五秒检查已提交数据和文件指纹，完整构建并校验后原子切换；失败保留上一完整目录并报告 ERROR 或 STALE。

格式版本 2 自动替换旧的文件软链，保留原有业务路径与版本映射。目录与原件须位于支持硬链接的同一文件系统；不能建立硬链接时明确报错，不退回复制。索引记录生成时的文件身份，日常校验同时核对硬链接与原件的设备、inode 和内容 SHA；即使字节相同的独立副本也不被接受。清理旧目录只移除经过核验的文件入口，不删除仍由原件路径持有的内容。

目录用英文语义名、无声调拼音、真实版本和短身份后缀组织；未知归属放入 unclassified。候选、采用、历史、预览、缺失和退役在目录索引分别记录。可读文件名不是业务主键，也不是实际观察证明。

项目配置 reviewLibrary 包含 enabled 与 texts。每项文本显式指定 source 或 screenplay、永久 objectId、可选 revisionId 和 texts 下的相对 Markdown 路径。未固定修订时跟随当前内容，索引保存导出时的完整版本依据。原件和文本缓存只读，目录同步不改变业务正文。

```bash
npm run review -- library status
npm run review -- library list
npm run review -- library resolve review-library/images/分类/主体/文件.png
npm run review -- library sync
npm run review -- library verify
npm run review -- status OPERATION_ID
rg --files --hidden --no-ignore -L review-library
```

sync 和 verify 返回 operationId；必须查询成功回执。verify 强制核对全部 SHA。目录、缓存、机器路径和运行回执不进入普通业务包或 Git。

resolve 核验实际文件身份、与原件的硬链接关系和字节，返回精确媒体版本或文本来源依据及项目内 exactPath。工作器未运行时，目录保留最后一次同步结果，应先检查状态再判断是否为当前稿。

## 快照、完整项目包与恢复

![运行原件、引用快照与独立离线恢复库](../assets/snapshots.svg)

“系统管理 → 数据与运行”提供保存恢复快照、导出完整包、导入和独立恢复。业务数据库仍是当前权威；快照是一次冻结的可恢复状态，不参与网页日常读取。

| 保存位置 | 内容与用途 | 保留方式 |
| --- | --- | --- |
| instance/media | 按 SHA 登记的运行原件 | 当前作品及有效版本闭包 |
| project-data/current | 当前 manifest、数据块／媒体／来源的 LFS 指针 | 每次成功保存替换 |
| project-data/previous | 紧邻当前的一次恢复快照 | 下一次成功保存时轮换 |
| project-data/baseline | 初始化或迁移登记的可选冻结起点，只存引用 | 普通保存不轮换；通过基线编号独立恢复 |
| .git/lfs/objects | 独立的完整内容库 | 离线恢复已保留快照和基线；不能与运行原件硬链接 |
| 受管导出目录 | 自包含 tar 完整包 | 明确导出才产生，成功后保留 24 小时 |
| review-library | 人可阅读的媒体入口 | 与运行原件硬链接，共享字节 |

快照工作文件保持指针，关闭自动 smudge，避免检出后再次展开完整媒体。写入 LFS 时使用真实输入文件作为文件参数，不能用已存在的短指针目标提供输入尺寸。离线核验逐一检查指针、大小与内容库 SHA，不下载网络对象，也不依赖运行原件。项目只使用自己的独立 `.git/lfs/objects`；自定义共享 LFS 存储和仓库外路径不能用作这个恢复库。

后台工作器先生成并核验快照，取得独占锁后切换 current／previous。失败保留原快照；切换结果未知时保留恢复输入和原操作编号，阻断新保存，先核查原操作。完整下载包只有显式导出或导入时产生，清退到期归档前核对操作、阶段和占用，不清理未知任务。需要长期保留完整包时，将下载文件存放到用户自行管理的位置。

恢复使用当前／上一快照、已登记基线或未过期完整包编号，在受管新目录建立独立 PostgreSQL 和软件副本；当前实例不切换，也不启动真实模型任务。快照先从离线库展开到恢复阶段，再通过标准导入校验；阶段结束清除临时展开内容。

普通部署保留当前与上一软件／数据库恢复点。更旧资源必须确认活动指针、身份、SHA 和占用后清理。用户明确保留的备份与独立恢复副本不按普通日志期限删除。封存旧项目备份不被自动读取、扫描或删除。

```bash
npm run review -- snapshot save
npm run review -- snapshot verify
npm run review -- snapshot status
npm run review -- snapshot export
npm run review -- snapshot restore --file restore.json
npm run review -- status OPERATION_ID
```

save、export、restore 与网页共用后台维护接口；verify 是不写数据的离线核验。`review maintenance verify` 另核对运行数据库、关联与原件。恢复请求包含 backupId、targetName 与 explicit:true。恢复结果给出独立目录；新副本不会自动启动 Web，可从该目录使用正常部署入口上线。

## 正式任务管理

项目 Codex 使用 `$review-tasks` 讨论、发布、执行、续办和审计正式任务。主会话维护协调运行和账本，网页及业务工作器不自动执行此队列。任务管理可在网页停机时使用；故事对象与创作结果仍通过原业务 API 保存。调度不依赖 Ultra 开关，主 Agent 保持用户选定模型与强度。

![正式任务从澄清到完成](../assets/tasks.svg)

### 讨论与批量发布

发布默认先讨论目标、范围、交付物、验收、可行性和授权，用户认可讨论结论后立即正式入案，不再重复确认。本轮已经认可的结论直接沿用。未澄清想法不生成编号、文件、草稿或事件，也不跨会话恢复；正式任务遇到障碍则记录阻塞，不能丢弃。

一次输入可以按目标、依赖和修改范围拆成多项任务或合并相关问题，不固定一次一个。每项保存原始请求、discussion.summary、feasibility、approvedRequirements 和明确授权，避免拆分遗漏。未知可行性可以成为用户认可的独立调查任务。SYSTEM 先维护通用核心并验证项目继承，CREATIVE 只在所属故事项目内按精确授权推进。

`publish` 支持单个 task 或 tasks 数组（每批 1–50 项，可分批处理更多问题），每项须 clarified 和 discussion.approved 为 true。批内 key 唯一，用 `@key` 引用同批依赖，已有任务用完整展示号或永久 ID。全部校验通过后一次追加事件，任何一项未讨论、依赖不存在或形成循环时整批不发布；未成熟部分应在讨论阶段排除。

### 稳定展示编号与永久身份

展示编号为 `T-YYYYMMDD-NNN`，例如 `T-20260914-001`。日期取任务第一次发布记录的 Asia/Shanghai 日期；北京时间 00:00:00 开始新一天，与宿主时区和永久 ID 的日期前缀无关。同一项目、同一日的全部正式任务共用 001–999，SYSTEM、CREATIVE、合并产生的任务、拆解产生的子任务使用同一个序列。序号固定三位，完成、取消、合并、筛选、排序和重建均不改号，不回收已分配编号。

历史首次发布记录按原始发布时间排序；同一时间按事件序号、事件中任务数组顺序分配。读取时计算缺失映射，不写账本或改变旧任务版本。下一次成功写入将尚未固定的映射保存为同一追加事件的 `taskNumbering: {version:1, allocations:[{taskId,displayId}]}`；新任务快照同时保存 displayId。后续回放校验映射的唯一性、日期、三位范围与快照一致性，已有映射直接继承，即使之后系统时钟校正也不重新排序。旧事件原字节、哈希链、永久 ID、依赖和历史引用保留；不靠当前列表位置、Markdown 文件或 runtime 计数器分号。

分配在现有账本独占事务中完成；发布、合并、拆解通过全部校验后只追加一条事件。并发请求按落账顺序分配，批内按发布数组顺序分配。同一 operationId 的重放返回原任务，不再次占号。当天会超过 999 项时返回 `TASK_NUMBER_LIMIT`，整个批量操作无任务、状态或部分映射落账；历史单日已经超过 999 时同样明确拒绝，不能截断、扩位或复用。

CLI 的 show、list/audit --task、依赖与精确任务引用、合并、派工、写入和停止边界接受完整展示号或旧永久 ID。JSON 的 id、taskId、taskIds、依赖、父子/合并关系继续使用永久 ID，任务另提供 displayId；阅读文件名也保持原永久身份，输出不生成文件路径链接。任意截短后缀和不完整编号均不能定位任务。

写入仅对结构化任务引用和 expectedVersions 的任务键解析别名，不替换正式标题、原话、证据、操作号、问题绑定 token 或机器执行身份。解析在账本锁内进行，随后按永久身份计算请求指纹并核对原 CAS：同一操作只换新旧编号仍返回原结果，改内容或指向另一任务拒绝，同一任务的新旧版本键冲突也拒绝。原历史请求先按原指纹识别，终态或过期版本不阻断旧操作回读；新请求仍须完整版本核验。任务/派工/问题三层版本、决策等待、关闭和恢复规则保持不变。

### 发布后的本地管理提交

Codex 在发布成功后先 `audit --operation-id 原发布编号 --format markdown` 回读，再自行调用 `commit --file -`，输入 `{operationId,actor,publishOperationId}`。不要求任务为 RUNNING 或存在执行租约，不重复请求授权。该流程只创建本地 Git 提交；publish 本身保持入队语义，其他状态变化也不自动提交。推送仍遵循独立交付授权。

提交入口在当前项目仓库内锁定账本，验证项目绑定、事件哈希与连续版本链、完整未提交前序、确定性阅读视图及 HEAD 中的历史前缀。清单只包含 `tasks/project.json`、实际事件文件、`tasks/README.md` 和实际任务对应的 `tasks/items/编号.md`；未知卡片、artifacts、故事、源码和 runtime 不自动纳入。视图的截至时间固定为最后事件时间，rebuild 不制造空变更；视图被手改或缺失时先核查并重建。

使用标准 `index.lock` 排斥常规 Git 写入，在独立 index 中从 HEAD 构建并核查精确提交树，通过 `commit-tree` 和父提交 CAS 更新分支，再仅更新原暂存区中的受管条目。无关文件内容和暂存条目保留，不执行 checkout、reset、stash、hooks、filters 或 push。需已有本地分支及初始提交；未完成合并／变基、split index、未知锁、受管文件不同暂存内容或父仓库路径均拒绝并保留现场。

管理提交回执仅存 runtime，记录原操作、发布编号、账本序号和头摘要、提交 SHA、精确清单及 index 恢复指纹。返回 SUCCEEDED / NO_CHANGES 时可报告实际 SHA；失败不撤销发布。中断先 `commit-status --operation-id 原管理提交编号` 核查原提交是否进入历史和 index 是否完成，再重放相同请求：只有分支和 index／锁指纹能共同证明范围才恢复，否则保留现场。相同请求返回原结果，后来事件须新管理提交；同内容不造空提交。并发发布与提交共用账本锁，后发事件保留待提交事实，执行资格与业务对象不受影响。

### 账本、版本与运行资格

`tasks/project.json` 绑定故事实例及协议版本。v2 CLI 可回放 v1/v2 事件；已有 v1 账本须在没有活跃执行者、命令和未关闭派工时显式 upgrade。旧事件及编号不改写，旧 CLI 读取 v2 绑定即拒绝，不能降级写入。新项目直接使用 v2。

`tasks/events` 是追加式 JSON 事务账本，包含操作编号、请求指纹、操作者、时间、前序摘要和完整任务版本。发布、批量发布、调度、合并、拆解和父项汇总均原子生效。写入短暂独占锁并校验 expectedVersions；同号同请求返回原结果，不同请求拒绝。任务编号、正式 title、原话及已认可范围在原案中长期稳定，改目标须讨论并新建任务。

`tasks/README.md` 与 `tasks/items` 是可重建阅读视图，审计从事件回放读取事实。任务和派工的逻辑编号、选择理由、状态、检查点、原操作编号、成果和验收/关闭证据随私库保存。机器路径、原生线程 ID、socket、PID、租约及派工绑定只在 `instance/runtime/task-execution`，不进入公开软件或业务导入包；复制数据不恢复执行资格。

日常 `tasks list` 默认只列 READY、RUNNING、BLOCKED、WAITING_REVIEW。明确指定 `--all` 才纳入 DONE、CANCELLED、MERGED；状态、类别、任务筛选与该范围取交集，所以 `list --status DONE` 为空，而 `list --all --status DONE` 返回匹配的完成历史。JSON 与 Markdown 共用同一集合、发布时间排序和固定七列；空 Markdown 列表仍显示表头和 0 项。此默认范围只影响 list，show、status、audit 及完整历史阅读视图保持原语义。

每个项目只有一个 `run` 协调运行，10 分钟租约，阶段间 heartbeat，guard 内自动续租。旧协调进程仍活跃时不接管。协调进程死去而原命令仍运行时，仅在原命令具有可核验派工及完整资源占用时允许新协调者推进无关任务；未知归属或旧串行命令仍阻断接管。运行身份不能复用。

### 调度与资源占用

主 Agent 准备 schedule 候选，包含所属正式任务、稳定派工 key、目标、交付物、验收、资源、模型选择理由、前置派工以及重派时的 attemptOf。调度事务按正式依赖、优先级（0 最高，默认 2）、发布时间、编号检查候选，原子保留可执行派工，返回其余项目的等待原因。同一正式任务可有多个独立派工，跨任务同样可以并行；派工本身不必再成为正式任务。

项目同时占用的正式任务最多 3 项，按不同任务 ID 计数：RUNNING 主任务、预留及任何未关闭派工都保留占用。同任务多个辅助派工只占一个任务位，实际 Agent 容量仍逐项计算。结果交回、空闲、BLOCKED 或关闭结果未知不会提前释放其派工；最后派工关闭后，RUNNING 父任务仍须完成收尾并转入相应状态才释放任务位。任务占用与实际同时工作的 Agent 数分别报告，预留记录不证明原生执行已经发生。

schedule、dispatch/start、串行 next、resume 与 guard 的原子活动登记共用任务上限检查。满额候选返回 `TASK_CAPACITY`；主 Agent 或子 Agent 容量不足仍返回 `MAIN_CAPACITY`／`AGENT_CAPACITY`，启动前复核当前能力变化。status 在执行附表展示任务占用、上限和可补入数，依赖及资源检查仍独立适用。旧版本留下超限占用时，允许 reconcile、关闭及收尾，拒绝继续领取、续办执行和启动命令；原事件不改写。

空位释放后，已获启动授权的主 Agent 重新检查 READY 待办和 deferred 候选，按依赖、优先级补入，无需用户重复启动。协调运行不自行调用原生模型；原生 Agent 关闭能力未验证时按现有规则由主 Agent 串行推进，不能为了达到 3 项而虚构槽位或放松关闭核验。共享核心整合、正式业务写入、提交推送和部署继续串行。

| 资源 | 规则 |
| --- | --- |
| FILE / DIRECTORY | 使用 core/...、project/... 逻辑路径；写入与同文件、重叠目录的访问互斥 |
| OBJECT | 使用永久对象身份；写入与同对象访问互斥 |
| READ | 必须提供精确不可变版本，可与其他不可变读取并行 |
| UNKNOWN | 无法确认范围，独占全部派工资源 |

路径大小写按保守冲突处理，拒绝绝对路径、父目录跳转及非规范别名。资源占用持续到派工 CLOSED；交回或空闲不能释放占用。阻塞且命令已结束的主 Agent 派工保留受影响资源，无关资源可以继续。代码派工使用独立受管 Git worktree；专属服务创建与启动轮次回执保存到 runtime，再开始工作。

每项派工依次记录 RESERVED、dispatch 尝试、RUNNING、DELIVERED、ACCEPTED、CLOSED，遇到中断可进入 BLOCKED，有未解决用户决定时进入 WAITING_DECISION。先 schedule，再 backend dispatch 由同一专属服务创建会话并启动轮次；缺失回复先 sync/recover 原调用，禁止盲目重发。一次 Agent 只绑定一项派工，负责人和辅助 Agent 分别登记，主 Agent 统一控制容量。已关闭派工不再改动；重派创建新编号及新 Agent。

`guard --assignment ID` 使用派工独立命令锁和进程记录，允许无冲突命令并行；开始命令时在账本锁内重新核查状态。共享核心整合、正式业务保存、提交推送和部署由主 Agent 串行完成，共享核心命令加 `--core` 锁定真实 Git common directory。guard 不代替业务 CAS，也不约束绕过协议的其他会话。旧 `next` 保留串行兼容，有未收敛派工时不跨过它领取新任务。

### 模型、Goal 与 Agent 关闭

| 工作 | 默认模型 | 强度 |
| --- | --- | --- |
| 明确查找、机械整理 | gpt-5.6-luna | medium |
| 多文件探索、研究 | gpt-5.6-terra | high |
| 普通实现、测试、修复 | gpt-5.6-sol | xhigh |
| 架构、高风险、争议核验 | gpt-6-astra | max |

选择必须属于专属服务 model/list 支持的模型和强度，并保存理由。主 Agent 保持用户配置；工作会话通过项目专属 App Server 创建，不依赖交互 TUI 是否属于公共 App Server，也不自动转移原生 spawn 的 Agent。

`backend ensure` / `backend probe` 在受管阶段自动启动或复用本项目服务。服务身份由实例 ID 与规范项目根派生；短 Unix socket 位于当前 Codex home 的 app-server-control，使用项目专属名称。运行记录位于 instance/runtime/task-execution/server，包含进程出生时间、启动参数、二进制 SHA/版本、socket inode、隔离 sqlite_home 和代次。启动锁排斥重复实例；健康服务必须通过进程、socket 与 RPC 联合核验。未知 socket、无法证明归属或原启动结果未知时保留现场，不接管公共服务、其他项目服务或用户交互会话。

Unix socket 使用 WebSocket HTTP Upgrade 与有界消息帧；proxy 只是字节转发，不接收 JSONL。initialize、协议、权限、服务缺失和 RPC 超时分别保留诊断；不能把失败简写成 0 槽位。`native probe` 保留兼容入口，拒绝手填 slots 和外部 socket。关闭探测使用持久命名的 legacy 历史会话；针对尚未支持条目分页的版本，读取原完整轮次作为兼容回退，不丢失结果。

能力分为 closeVerified（空线程关闭）、executionVerified（真实派工并行及关闭）和 goalVerified。CPU/内存及 RPC 配置上限给出 agentCapacity，减去所有未关闭子派工得到 availableSlots；服务配置只是受验证的上界，不是实际并行证明。派工交回或 idle 仍占用；`backend verify-execution` 核对至少两项实际活动采样、原轮次身份、成果保存、主 Agent 验收与关闭。最多 3 个不同正式任务仍独立核算；同任务辅助派工占 Agent 槽位。

代码派工需独立、干净且登记到该正式任务的受管 worktree，与本项目核心 Git common directory 和精确 baseCommit 一致。`backend dispatch --run ID --assignment ID --file -` 请求为 `{operationId,prompt,workspace,baseCommit}`。创建意图、创建回执和 turn/start 前后状态分别持久保存；原编号同请求重放仅查询，改变请求或创建结果未知不重复调用。服务创建回执、线程 ID、工作区和 loaded 状态共同证明执行归属；能读取磁盘历史只证明历史可读。

`backend sync` 查询原轮次，`collect` 以 `{operationId}` 登记结构化结果，主 Agent 逐项 accept。长派工使用 FOLLOWUP：上一轮已确认成功且尚未交回时，`backend continue` 以新操作编号和同范围 prompt 继续原会话，保留全部原轮次。活动、失败未知或已关闭派工不允许续行。专属服务暂不声明 Goal 自动跨轮能力；原生 Goal 必须先独立验证，不能把选择 Ultra 当作已启用。

完成、取消或替换时先保存结果/检查点，再 `backend close`（native close 兼容）：暂停并回读 Goal、停止原活动 turn、精确终止并回读后台命令，归档并核验 loaded/list 消失和 read 为 notLoaded。保留聊天历史，不调用 thread/delete。最后 assignment close 保存验收及清理证据；失败保留容量，不留空闲 Agent 池。`backend stop` 只有在无未关闭服务派工和加载会话时停止本项目 supervisor/子进程，核对退出，保留恢复状态及历史。

### App Server Foundation

通用核心 `tools/app-service.mjs` 统一维护专属服务生命周期和身份核验，`tools/execution-runtime.mjs` 提供本机范围绑定、boot 身份及持久写入。正式任务通过 `task-backend.mjs` 接入，`task-server.mjs` 保留兼容入口和容量、关闭探测策略。服务层不读取正式任务内容，不依赖故事名称、某项任务或固定机器路径；实例 ID 与规范项目根派生的身份和既有 runtime 地址在升级后保持稳定。

| 基础接口 | 调用契约 |
| --- | --- |
| `serverPaths(project)` | 显式标准项目根；验证本机范围，返回实例私有路径和服务身份 |
| `ensureAppService(project)` | 启动锁内复用健康服务，或重建可证明已退出的所属服务；原启动未知时停止 |
| `verifyAppService(project)` | 联合核对进程/boot、命令、二进制、socket 和 RPC 配置，返回由调用方关闭的连接 |
| `verifyAppServiceRecovery(project, {threads})` | 旧 macOS boot 无法比对时，核验存活原进程、精确原线程/轮次及工作区后提供受限核查和关闭连接；不改写旧身份，不允许新派工或答复 |
| `stopAppService(project, {assertIdle})` | 调用方先核查全部执行占用，再验证无加载线程，仅终止核验所属的子进程 |

未绑定原生线程或服务的 MAIN 派工可执行空闲服务维护；未关闭子派工及任何原生服务绑定仍阻断接收器停止。正式任务生命周期 CLI 仍经 guard + process；基础接口不代替调度、业务授权或任务验收。配置中的线程上界不代替最多 3 项正式任务、实际容量和资源互斥检查。supervisor 退出但子服务仍可核验时复用原服务，不再次启动实例。

标准 project create、installSourceOnly 和部署升级沿用固定提交的受管源码安装流程，一并交付服务模块、Skill 与手册，项目副本不维护补丁。接收器 ESM 依赖由 `decisionChannelSources` 一起打包，包含任务编号、基础服务和运行记录模块，必须在独立目录实际验证载入。运行中的旧接收器保留代码与连接到原派工收敛，不热替换。

`instance/runtime/task-execution` 的记录仅属于本机：

| 位置 | 恢复用途 |
| --- | --- |
| `scope.json` | 本机身份摘要、实例 ID 和规范根目录；跨机器/目录复制不能继承执行资格 |
| `server/server.json`、`launch.json`、`launch-process.json`、`generations/` | 当前/历史服务代次、启动意图及进程回执；状态目录仍为 `server/state` |
| `run.json`、`runs/`、`activities/` | 当前/历史协调运行、上一运行编号、boot 身份及受管命令占用 |
| `bindings.json` | 原协调运行、派工、工作区、原操作、线程/轮次、归属转换及恢复历史 |
| `decision-channel/calls/` | 以派工、原 operationId、方法定位的调用意图、成功回执或 UNKNOWN |
| `backend-results/operations/` | 原操作索引的结果回读；派工结果文件保留兼容读取入口 |

关键回执通过文件 fsync、原子替换及目录 fsync 保存；账本仍只追加，不重写旧事件。机器路径、进程、线程、租约和执行资格不进入公开核心或普通项目包。安装/升级不创建协调运行；复制或导入保留长期事实，不恢复历史执行权限。

#### 三类恢复入口与原操作对账

| 中断类型 | 恢复入口与核查 |
| --- | --- |
| 专属服务异常退出 | 原 run 有效时，经受管阶段 `backend recover --run RUN_ID --assignment ASSIGNMENT_ID`；核对原服务代次和原回执，必要时重建同实例服务，只订阅原线程并读取原轮次 |
| 协调会话退出 | 主 Agent 核查旧协调者明确失效，取得新 run；assignment reconcile 携带任务/派工版本、expectedRunId、检查点和五项核查，再 recover 原派工；旧进程存活时租约过期也不能接管 |
| 同实例机器重启 | 本机 scope 必须匹配；核验旧 boot 与当前启动不同，核查过期活动、工作区和回执。新 run 关联旧 run，再按 reconcile/recover 续办，不依赖旧 PID、连接或内存 |

归属在账本锁内通过版本 CAS 更新，保留 originRunId、旧/新 run、检查点操作及 backend operationId。未确认关闭的 Agent、资源与正式任务占用继续保留。重复恢复只重复核查，不创建线程或工作轮次；已关闭派工拒绝恢复加载。旧协调者身份缺失、归属不符或原命令仍活跃时停止接管，保存恢复输入。

| 中断窗口 | 允许的恢复行为 |
| --- | --- |
| 完整意图已保存，创建/发送尚无回执 | 保留原 prompt、operationId 和 CREATING/PENDING；不能用新编号重试 |
| 成功调用回执已保存，派工绑定未更新 | 精确校验派工、操作、服务代次和工作区后，补齐原线程/轮次 |
| 原操作实际完成，结果回执未保存 | 已有精确 turnId 时回读原结果；无法证明原 turnId 时保持 UNKNOWN，唯一可见轮次也不是证明 |
| 原操作仍在执行 | 跟踪原线程/轮次；恢复订阅不发送 turn/start |
| 请求重复到达或并发 FOLLOWUP | 原调用锁和持久意图防重复发送；成功复用回执，UNKNOWN 先对账；新续办还须原操作状态 CAS |

同一 boot 内缺失 supervisor/子进程回执，不代表创建从未发生，不能只凭旧 PID 消失再启动。重启证明只说明旧进程不再存在，不能说明原工作是否完成。无法核验结果时保持 UNKNOWN、原编号与输入，阻断自动重试。

启动身份使用内核 boot UUID，进程身份使用 macOS 内核出生时间或 Linux `/proc` 启动 tick；`ps` 的本地化时间只用于核对旧记录。来源不同、旧 macOS `kern.boottime` 散列变化或进程探测失败保持 UNKNOWN，不能据此清理、接管或断言机器重启。逐任务清理隔离 UNKNOWN 并保留该任务资源，其他任务仍可核查，Web 与工作器不会因清理身份未知而退出。

受限旧服务恢复只能用于调用方显式列出的原线程、原轮次和项目受管工作区。连接同时核查进程出生信息、命令中的二进制与状态目录、二进制 SHA、socket 身份、RPC 版本与隔离配置；观察到的新内核进程身份单独保存，不把旧 boot UNKNOWN 写成 SAME。仅允许读取指定线程、必要的原线程恢复订阅、暂停 Goal、停止精确原轮次和已观察到的后台进程、归档并验证卸载；禁止创建线程、新工作轮次、代填决策和访问其他会话。完整新派工仍通过正常身份核验。

keeper 关闭循环遇到 `PROCESS_LOCK_BUSY` 时保留 executor 锁，输出 `EXECUTOR_LOCK_BUSY` 并重新核查，不延长租约。guard 在租约失效时照常拒绝执行；`PROCESS_LOCK_UNAVAILABLE` 等故障保留诊断。不能删除内核锁文件、更改绑定或手动延长资格绕过闸门。

主协调者通过单独核验的专属只读连接，按每项已绑定的线程及原轮次采样；工作会话连接仍仅允许本派工线程。派工返回时线程可能尚未报告 active；`backend sync` 跟踪原运行轮次时也采集同服务的实际重叠。只有保存的活动样本与原轮次、成果、逐项验收及物理关闭一致，才通过真实并行核验；旧样本无法验收时不改写为成功。

故障验证使用受管隔离 fixture：实际终止假服务/协调进程、持久原操作回执、跨 Node 进程读取和受控 boot 身份切换，分别记录窗口与执行计数。模拟 boot 切换不等于真实机器重启；实际重启、项目固定版本升级、本地/VPS 部署和源码推送各需独立回执，未执行部分如实标记。

### 检查点、恢复与完成

#### 用户决策通路

`tasks run` 的协调循环每秒检查未解决问题，变化时输出 `DECISIONS_CHANGED`，并在 runtime 的 `decision-channel/notices` 保存发现时刻及问题归属。此通知帮助主会话及时发现问题，不能替代主会话实际提问；没有活跃协调会话时，由持久接收器保存待办，恢复后重新发现。

项目 App Server 的工作会话通过持久连接接收器创建、执行和恢复订阅。接收器在 `backend ensure/probe` 的受管阶段启动，CLI 返回或协调租约失效不会结束接收；无活跃协调者时继续保存待转达事项。生命周期、二进制/服务代次和 socket 身份沿用项目服务核验；接收器代码使用 runtime 中的固定内容副本，工作 worktree 退出后仍可接收。运行中的接收器版本不一致时不热换连接：先收敛旧派工并停止所属服务，再加载新版本。不处理公共及其他项目服务。

工作 Agent 主动业务决策使用 `thread/start.dynamicTools` 注册的 `review_task_decision`，在 `item/tool/call` 请求中携带稳定 key、问题、必要背景、选项影响、建议、待决步骤及已完成工作。该调用等待主会话的明确用户答复；普通已授权实现选择继续自主处理。内建 `item/tool/requestUserInput` 为 INPUT，动态业务决定为 BUSINESS，命令/文件/权限的 `requestApproval` 为 APPROVAL。`approvalPolicy: never` 不等于批准业务选择，也不免除人工权限请求的核查。技术性 `currentTime/read` 按本机 schema 返回时间；不认识的服务请求与通知保留诊断，不静默当作成功。

问题及答复的逻辑身份、归属、内容、版本、呈现证据、发送状态和时间随正式任务事件长期保存。原消息先同步写入 `instance/runtime/task-execution/decision-channel/inbox`，再在同一任务账本锁内更新派工；轮次回执稍后落盘时可重放收件。机器服务、连接、线程、轮次、协议请求 ID、原命令/权限、调用回执和工作区只保存在 runtime。请求按原服务代次、线程、轮次和带类型的请求编号区分；重复事件不新增问题。稳定业务 key 已有未解决问题而出现新回调时保留核查，不重复提问或自动换绑。

主会话在派工后、每次 heartbeat/checkpoint 与恢复阶段执行 `decisions list` 和 `decisions status`，把尚未呈现的问题集中转达给用户。转达须说明正式任务原题、派工、问题编号、选项/建议、影响及暂停步骤。CLI 是发现和回执入口，不会自行向交互宿主弹窗，也不向外部通信平台发送消息。主 Agent 真正向用户提问后，才以 `decisions present` 保存消息引用及内容；新协调会话沿用已呈现记录，不把重复 CLI 查询当作新的提问。

| 决策状态 | 意义与允许动作 |
| --- | --- |
| OPEN | 原请求待用户答复；尚未呈现时由主会话提问 |
| ANSWERED | 用户明确答复已落账，原连接仍可接收；仅未尝试发送时允许 deliver |
| DELIVERY_UNKNOWN | 已持久保存发送/续办意图；写入连接不证明送达，只核查原操作 |
| NEEDS_RECONCILIATION | 断线、请求清理、服务代次改变或协议不支持；保留问题和答复 |
| FOLLOWUP_READY | 原请求已核查失效、已有明确答复、原派工允许同范围续办 |
| RESOLVED | 精确工具回读、原操作人工核查或同范围续办回执证实已交回答复 |
| CANCELLED | 工作会话已核验停止关闭，保留原问题、答复及未知回传历史；不表示用户同意 |

前五种状态都未解决。派工显示 WAITING_DECISION；任务可能还有其他正在运行的派工，因此正式任务总状态仍可为 RUNNING。`status/show` 的派工附表及 `backend sync` 提供区别，后者同时报告原轮次 executionStatus。等待不等于普通故障 BLOCKED、完整交回 DELIVERED 或正式 WAITING_REVIEW；轮次正常完成也不能跳过决定。collect、直接 assignment result、accept、DONE 均有闸门；未归入账本的相关原请求同样阻止验收。等待派工、Agent、资源与正式任务容量保留到核验关闭，资源独立且无依赖的其他工作仍可推进。

`decisions show ID` 返回当前 `requestFields`，包含所属任务/派工/问题的三个版本及不透明 bindingToken。present/answer/reconcile 都携带这些字段和稳定 operationId；每次写入前重新读取。答复还必须包含 `actor:"USER"`、`explicitUserAnswer:true`、用户原话/消息引用 evidence 和结构化 answer。BUSINESS 为 `{text}`；INPUT 精确映射原问题 ID 为 `{answers:{问题ID:{answers:[文本]}}}`；命令和文件审批仅允许原请求支持的单次 accept/decline/cancel；权限请求为 grant/deny，并限制在原请求本轮权限。审批前用 `show ID --runtime` 查看原始操作、路径和权限并向用户说明。秘密输入、会话授权、持久规则修改、MCP elicitation 等尚不支持的请求只保留诊断，不能扩大授权或假称转达成功。

答复先持久保存，接收器再核对原服务代次、连接、线程、轮次和请求状态，将协议结果写回原请求 ID。相同 operationId 重放只回读，不重发；同号异内容、冲突答复、错误归属及过期版本拒绝。已失效请求的明确答复可保存为待核查，不能送到新请求。`serverRequest/resolved` 同时用于答复和请求清理，不能单独证明送达；本通路不把超时、非阻塞请求的默认项或轮次结束当成用户同意。动态业务工具的完成条目必须匹配原工具、参数、条目及完整答复内容才自动确认；输入与审批缺少精确回读时继续核查原操作。

连接断开或服务重启后，先保留旧接收记录；原创建/轮次调用结果未知时查看 runtime 的 `decision-channel/calls` 与原工作结果，不换号调用。新协调者先核查旧进程和受管命令、`assignment reconcile` 接续归属，再在受管阶段 `backend recover` 订阅原线程并查询原轮次。恢复不新建线程或轮次，不把旧请求编号直接用于新服务。原请求在同一服务重新呈现时，未发送答复可以重新核对绑定；已有发送意图仍不重发。未取得呈现的旧问题不会自动假设已经转达。

旧历史存储在重启后可能不支持 `thread/turns/list` 和带完整轮次的 `thread/read`。只有明确的“不支持”错误且已核验原线程为空闲或未加载时，后端才回读本项目持久接收器保存的原 `turn/completed`；核对原 `turn/start` 成功回执、操作、派工、服务代次、连接、线程、轮次、消息摘要和时间。冲突或缺失证据继续保留 UNKNOWN；网络错误、活动线程、报告文件或仅有最终消息不能替代轮次完成。完成通知与最终条目分开核验，缺少完整最终答复时不能 collect。恢复来源随原操作结果保存在 runtime，不改写原通知或启动新轮次。

关闭原未加载线程时，先以 `excludeTurns:true` 恢复运行信息，再查询 Goal 与后台命令。部分旧服务会在已加载运行信息之后返回历史“不支持”错误；此时只重读原线程状态，实际证实已加载后继续停止核验，不重复 resume。超时、断线或仍未加载则保留未知结果。调用报错不证明没有副作用，只有最终 Goal、活动轮次、后台命令和卸载回读全部通过才登记关闭。

`decisions reconcile` 先读取原线程/轮次，再接受 `checkedOriginalOperation:true` 及明确 evidence：DELIVERED 仅用于确认原回传；FOLLOWUP 仅用于原本采用 FOLLOWUP、上一轮成功且未交回/关闭的 INPUT/BUSINESS 派工。随后 `decisions followup` 自动使用保存的问题、用户答复和已完成/待办步骤构造同范围输入，保存新操作与原轮次历史。活动、失败、结果未知不能续办；新轮次回执丢失先查该续办操作，不能重新执行。失效审批不可变为新轮次授权。单轮派工或已关闭派工由主 Agent 先收尾、再创建新派工并核对新请求，不复用旧授权。

停止协调执行后禁止新答复和新工作，仍允许保存检查点、核查及关闭。`backend close` 先中断原轮次、停止并核对后台命令、归档并验证卸载，再取消关联决策，最后 assignment close；关闭失败保留占用。不通过发送“拒绝”替代真实停止核验，也不把 CANCELLED 包装为验收成功。

协议字段已于 2026-09-14 使用本机 `codex-cli 0.154.0 app-server generate-json-schema --experimental` 核对，包括输入、审批、DynamicToolSpec、动态工具完成条目和请求清理通知。请求清理与动态工具回传的语义参考 [OpenAI App Server 官方说明](https://learn.chatgpt.com/docs/app-server)。当前验证包含持久收件、并行归属、版本/重放、协调更换、断线/重启、发送未知、FOLLOWUP 及容量/关闭的受控测试；真实用户呈现与明确答复必须另行执行，不能用 fixture 结果替代。

#### 真实决策往返验收

由主 Agent 在项目继承此核心版本后执行。先核对受管核心、Skill 和 CLI 已同步，保持当前有效 run；以下命令的账本根始终是故事项目。服务生命周期及所有测试通过当前已领取派工的 guard + process 阶段执行，阶段编号每次唯一。机器路径、run/线程/连接和轮次证据只写 runtime；手册和长期成果引用逻辑任务/派工/问题编号。

1. 在受管阶段执行 `backend probe --run RUN_ID`，回读 `decisions status` 确认 READY；旧接收器版本不一致先收敛并关闭，不能热替换。用原正式任务 schedule 一个独立、同范围、`longRunning:true` 的验证派工，使用干净且已登记的 worktree。`backend dispatch` 请求包含唯一 operationId、workspace、baseCommit 和以下 prompt：

   ```text
   本次仅验证用户决策通路，不改代码，不操作业务或外部服务，不调用故事生成模型。
   先完成检查点“已准备验收输入”，然后调用 review_task_decision：
   key=roundtrip-proof；question=请为本次决策通路验收选择一个结果标记；
   context=只在返回结果中记录用户选择，不触发其他动作；
   options=[{label:alpha,description:结果记录 alpha},{label:beta,description:结果记录 beta}]；
   recommendation=两种标记都能完成验收；pendingWork=[记录用户实际选择]；completedSteps=[已准备验收输入]。
   等待工具返回，不代答、不使用默认值。得到答复后只输出约定结果 JSON，
   summary 与 acceptance[0].evidence 明确记录实际答复；artifacts=[]；
   completedSteps 记录提问及接收答复；nextSteps=[]，然后结束。
   ```

2. dispatch CLI 已返回但工作轮次尚未完成时，用 `decisions list --format markdown` 找到问题，`decisions show DECISION_ID` 读取内容及版本。回读 `backend sync --run RUN_ID --assignment ASSIGNMENT_ID` 的 WAITING_DECISION/执行状态。此时尝试 collect 应被拒绝。保存请求 createdAt、发现时间和派工归属；不能把“CLI 有问题”记为“用户已看到”。
3. 主会话实际向用户呈现该问题、所属任务/派工、alpha/beta 选项及无外部效果的说明。收到真实提问回执后，再执行 `decisions present --run RUN_ID --file -`，stdin 合并最新 show.requestFields 与 `{operationId:"唯一提问编号",actor:"PROJECT_CODEX",evidence:"真实主会话消息引用及所提问题"}`。不提前登记，不自动选择 alpha。
4. 等待用户在主会话明确答复。重新 show 后，`decisions answer --run RUN_ID --file -` 合并当前 requestFields 与 `{operationId:"唯一答复编号",actor:"USER",explicitUserAnswer:true,evidence:"用户原话及消息引用",answer:{text:"用户实际答复"}}`。这些示例文本必须替换为真实内容；尚未得到答复时停止于本步骤并登记待用户参与。
5. 查询同一问题直到精确回读为 RESOLVED，再 sync 原派工直至 SUCCEEDED/resultReady。核对结果仅含用户所选标记，原问题/答复/回传/完成条目一致；保存原请求 runtime 文件、用户消息引用和原结果的对应证据。以同一答复请求重放应只返回 replayed；不能产生第二次回传或第二个工作轮次。按当前版本提交不同 answer 应被拒绝或转入核查，不可改用另一派工。
6. collect 保存结果，由主 Agent 逐项验收、backend close、assignment close；原正式任务的其他验收、用户参与、继承、发布和清理未完成时不标 DONE。正式成果只引用逻辑编号，机器回执留 runtime。

恢复验收分别用独立受控派工/协议 fixture，保留每次原输入，不对真实用户重复制造相同问题：请求产生后断线；提问后更换协调 run 并 reconcile；答复保存后中断回传；服务代次变化且原请求失效；FOLLOWUP 回执丢失；停止/关闭期间拒绝新答复。每种场景均核对原问题及答复保留、旧绑定不误用、无自动默认同意、无新增重复轮次、关闭前占用不释放。主会话真实呈现与用户答复仍是独立必需证据。升级前未被旧短连接接收的问题无法凭空回补；若原服务不重放，应明确保留 UNKNOWN 和原线程恢复输入，由主 Agent 核查后决定收尾或新派工。

#### 最近安全检查点暂停

`tasks pause --run ID` 面向当前协调运行及其主任务和相关派工，不等待整项正式任务完成。暂停是执行子状态，正式任务的 READY/RUNNING/WAITING_REVIEW 等业务状态不因此改写。`pause status` 和 `status` 单独展示执行暂停事实；审计主表继续沿用七列业务状态。

| 执行子状态 | 已有事实 | 允许继续的动作 |
| --- | --- | --- |
| PAUSING | 持久执行闸门已落盘；检查点或实际停止仍未完成 | 保存协作 checkpoint、查询原操作、停止核验 |
| PAUSE_UNVERIFIED | 原执行、回执、版本、工作区或后台命令存在未知事实 | 核查原编号及修复检查点；资源和占用保留 |
| PAUSED | 各方 checkpoint 已回读；Agent/Goal/turn、后台终端和登记的受管进程均停止 | 保留成果和未完成派工，等待 task run |
| RESUMED | 新协调运行核查原执行、原操作和恢复输入后接续归属 | 读取 CHECKPOINT_READY，从 nextSteps 继续；待决问题照常等待 |

暂停闸门和 schedule、guard spawn、process CLI 的阶段登记/spawn、持久接收器的实际 turn/start 发出共用 ledger.lock。原调用已发出但尚无回执时仍按原操作处理，不生成第二次执行。backend 派工锁收敛在途创建/轮次；停请求先保存唯一意图，重入不重发 turn/interrupt、后台终端终止、archive 或暂停恢复调用。回执丢失时只查询原线程/轮次；仍活跃、归属不明或结果未知不能据空闲时间释放资源。

暂停 checkpoint 是主协调者与工作 Agent 的协作协议。命令无法读取主 Agent 尚未落盘的思考，也不把旧 Markdown 或进程退出当成已保存工作。`pause` 返回 pauseId 和 targets；主协调者先停止推进新步骤，为每个 task 和未关闭 assignment 分别执行：

```text
tasks pause checkpoint --run RUN_ID --file -
{
  "operationId": "本次稳定检查点编号",
  "actor": "PROJECT_CODEX",
  "pauseId": "pause 返回的编号",
  "taskId": "原任务编号",
  "assignmentId": "保存子派工时填写，主任务省略",
  "expectedVersions": {"原任务编号": 当前版本},
  "expectedAssignmentVersion": 当前派工版本,
  "quiescent": true,
  "evidence": "最近已落盘边界与不再推进新步骤的真实证据",
  "checkpoint": {
    "summary": "当前可恢复状态",
    "completedSteps": ["已经完成且不得重复的步骤"],
    "nextSteps": ["下一步"],
    "inputs": ["精确输入与版本"],
    "artifacts": ["已保存成果引用"],
    "operations": [{"id":"原操作编号","kind":"原操作种类","status":"PENDING"}]
  },
  "workspace": {"path":"显式工作区","baseCommit":"完整 Git 基准提交","files":["相对恢复文件"]}
}
```

示例中的值须换成当前事实，主任务不发送 assignmentId/expectedAssignmentVersion。五个 checkpoint 数组全部必填，inputs 非空；已有 completedSteps、inputs、artifacts 和操作编号不能丢弃。`quiescent:true` 确认可中断边界，不是 Agent 停止回执、用户回答、生成授权或整项任务完成声明。Git 工作区须提供完整 SHA，文件清单包含全部已修改、未跟踪及需要核查的恢复文件。目录设备/inode、规范路径、Git common-dir/HEAD/diff 摘要、明确文件的 SHA、原 prompt、线程/轮次/操作和决策绑定只保存在本机 runtime；长期账本继续保存逻辑步骤、版本和成果引用。

没有各方 checkpoint 时保持 PAUSING，只封住新执行入口，不发送破坏性停止。协调者无法核实的未保存工作不得补写成已完成；应保留原执行，由所属 Agent/协调者保存可知边界。外部调用尚未收敛时保留 PENDING/RESULT_UNKNOWN。全部边界保存后调用 `pause verify --run ID`，必要时反复只读核验原停止意图。命令先保留相关阶段恢复目录，再停止已登记 runner/子进程和专属服务中的原派工，最终在锁内回读检查点、原操作和工作区，持久保存整体 snapshot 后才报告 PAUSED。任何未核查事实都显示其原因，不能显示已暂停。

`instance/runtime/task-execution/pause.json` 保存当前周期与闸门；`pauses/<id>/checkpoints/` 保存协作回执，`rpc/`、`stops/` 保存唯一停止意图，`checkpoint.json` 保存整体恢复快照与摘要。bindings 中的 pauseReceipt 标明可恢复，独立于禁止 recover 的 closureReceipt。暂停不取消问题、不删除答复、不关闭逻辑派工、不释放资源/任务容量；原正式关闭事实也不能转成可恢复暂停。进程阶段的恢复目录标记 RETAINED，普通 finish 不删除其成果，整合与恢复引用解除后由主协调者精确处置。

#### 同会话与跨会话续办

再次 `tasks run` 自动发现暂停周期。原 run 即使租约过期仍存活时拒绝接管；新 run 核对本机/项目/原协调身份，CAS 接续原任务及派工的收敛归属，核查原工作区、精确版本、文件 SHA、原线程状态及操作。暂停中断或原调用未知时维持闸门，先补存 checkpoint/核查原结果；不能换号重建工作 Agent。检查通过输出 CHECKPOINT_READY，包含 completedSteps、nextSteps、原成果及待决问题/答复。主协调者使用这些事实继续工作，CLI 不自动重放后台命令或原模型调用。

未完成子派工的 `backend continue --file -` 可仅提供 `{operationId}`。后端自动使用保存的暂停输入，恢复同一未结束线程并启动一个可对账的新续办操作，保留原操作及全部轮次历史；它不是给已经正式结束的 Agent 分配新工作。新轮次回执丢失只查本次续办编号。已交回、已验收、正式关闭或原结果未核查的派工不能借此继续工作。

未答问题继续等用户实际答复。原请求失效、原轮次已停止且有明确保存、从未回传的 BUSINESS/INPUT 答复时，暂停续办可核查后携带这些答复；已有发送意图或未知送达先查原回传，APPROVAL 失效不能成为新授权。暂停和新协调会话均不制造提问回执，不默认同意，不覆盖旧答复。

当前受控验证覆盖主任务受管命令及后台子进程、并行子派工、缺 checkpoint、重复请求、停止回执丢失、PENDING/RESULT_UNKNOWN、旧 run 存活、工作区漂移、同/新协调运行续办、决策保留及正式关闭边界。fake RPC 不代替真实 App Server、主会话协作和实际项目固定版本继承验收。CLI 与底层 `beginPhase` 共用账本锁中的暂停检查；阶段保存正式任务身份，`ProcessPhase.startChild` 在同一临界区检查、启动并登记子进程，直接 `finish` 也保留暂停恢复输入。锁顺序为账本、父任务、阶段；收敛清理不授权嵌套的新执行。外部宿主未登记执行不在 CLI 的可枚举范围，所属执行器必须提供精确停止身份，未知保持占用。服务/boot 的恢复身份算法沿用通用运行时协议，不能仅凭旧 PID 或租约过期接管。

主协调者最终在独立验证实例执行最小现场验收：安装整合后的固定核心版本并核对 Skill/CLI/手册；登记一项只写测试标记的主任务与两个独立派工；保存第一步及原操作并启动有界受管命令；从其执行会话 pause、保存各方 checkpoint、verify，现场确认所有原轮次和后台进程停止且文件保留；退出原 run 后分别在同会话和新会话 task run，从下一步续办并核对原调用计数、问题和答复未改变；完成结果验收、正式关闭以及精确清理。真实用户呈现/答复、当前项目继承、部署与正式任务 DONE 由主协调者另行验收，本段受控验证不提供这些事实。

检查点保存已完成步骤、下一步、精确输入、成果与原操作编号。外部操作先登记 PENDING，执行后保存结果；RESULT_UNKNOWN 只查询原操作，不重复调用。新检查点不能遗失既有操作编号，有未核查操作不能关闭派工或完成任务。

普通异常中断的跨会话恢复先核查旧协调进程、Agent、命令、工作区、版本和原操作，再 assignment reconcile；已保存暂停使用上面的专用续办协议。服务创建及轮次身份可补记原回执，不能换绑为新线程。`backend recover` 可启动缺失的所属服务，只恢复原创建回执对应的线程，再读取原结果，不发送新 turn；恢复调用已发送则查询原线程，不自动重复恢复，已确认关闭的派工不重新加载。活跃 writer 或无法验证的归属阻断接管；核查收敛后，返工用新派工、新 Agent，旧串行任务仍支持 resume。用户指定某项完成后暂停时，先以 `policy --run ID --file -` 保存 `{stopAfterTaskId}`；该任务进入终态后 next/schedule 返回 PAUSED_BY_POLICY，不再自动补位。明确结束执行时先停止新派工、保存状态，收敛 Goal/Agent/命令，再 stop；停止请求后仅允许检查点、结果及关闭等收尾写入。

| 正式状态 | 含义 |
| --- | --- |
| READY | 正式发布，等待依赖满足和调度 |
| RUNNING | 当前或待恢复运行已经领取任务 |
| BLOCKED | 已记录障碍，或等待拆解子任务 |
| WAITING_REVIEW | 已执行并收敛派工，等待约定验收 |
| DONE | 逐项验收有证据、全部派工关闭、清理已记录 |
| CANCELLED | 明确取消，保留原案 |
| MERGED | 合并到另一正式任务，保留原案和指向 |

合并仅处理同类未开始任务，继承全部原范围、授权、交付物与逐项验收。拆解覆盖原验收项，子项继承依赖，全部完成后父项汇总完成；依赖合并原案时沿目标核查完成。完成结果保存逐项证据、成果引用及清理证明。SYSTEM 分别核实测试、核心与私库推送、项目继承、本地和可达 VPS；CREATIVE 的 DONE 不代替故事正式采用。

父任务完成 cleanup:finish、cleanup:check、cleanup:complete 后再标 DONE；Agent 关闭不等于 worktree 可删除，成果整合或恢复引用未解除时保留资源。最终任务事件可在收尾提交保存，不自引用其提交 SHA。

### 稳定审计契约

用户可见列表始终使用下列七列，不按内容或查询次数增删、换序。标题原样取正式 title，不缩写、截断或临时概括；类别与状态只显示合法英文原码，无效值统一为 UNKNOWN，状态汇总采用相同口径。任务编号和依赖只显示完整展示号 T-YYYYMMDD-NNN，不生成文件链接；依赖按权威顺序先逐项转义，再以可信的格内换行分隔，一行一个编号，不拆为多条任务，无依赖写“—”。

| 任务编号 | 任务标题 | 类别 | 状态 | 优先级 | 发布时间 | 前置依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| T-YYYYMMDD-NNN | 原案正式 title | SYSTEM / CREATIVE | READY / RUNNING 等合法原码 | 0–3 | 北京时间完整日期与秒 | 前置任务完整展示号，每项一行 |

一行说明截至时间、范围、数量和状态分布；默认原始发布时间升序，展示号打破平局，用户明确指定才改变排序。时间统一 Asia/Shanghai 的 YYYY-MM-DD HH:mm:ss，不改用今日或相对时间。进展、完成时间、阻塞、成果用附表；执行概况用“项目｜当前情况”，详情用“字段｜内容”，派工审计另表展示模型/强度、Goal、关闭情况。未发生写“—”，无法核验写 UNKNOWN，空列表仍显示表头和 0 项，不虚构百分比。

list / status / audit / show 的 `--format json|markdown` 默认 JSON 保持接口兼容；Skill 面向用户必须采用 Markdown 共享渲染器，任务 README 使用同一渲染器。共享输出把任务编号作为纯文本，不能包含 `tasks/items` 相对路径、项目绝对路径或会被终端展开的链接目标。audit 返回当前任务事实及事件时间窗口，from 包含、to 不包含；窗口限定事件，不伪装历史时点快照。

终端显示链路是 tasks CLI 生成语义表格、Agent 原样转交、对话宿主按当前可用宽度排版。GFM 不提供可携带的精确列宽契约；精简类别、状态等短字段，为完整标题保留响应式余宽，不用源码空格、零宽字符或截断标题伪造列宽。共享层不得输出编号文件链接，多项依赖以同一单元格中的 <br> 逐项换行。回归检查七列表头、每行七个单元格、长标题、多依赖、不同状态和零项；项目继承后必须运行现场命令，在当前宿主窗口实际观察依赖格内换行、完整标题空间及横向结构。Markdown 源码、HTML 结构或字符串测试不能替代宿主视觉验收。宿主确实无法维持结构时，记录实际限制，对同一七列完整结果做当次展示适配，不删字段、不引入路径或 HTML 全表、不另设默认表格；宿主布局设置不由核心修改。

当当前终端实际把 <br> 原样显示、无法实现单元格换行时，使用同一共享结果的终端适配：运行对应查询的 --format text，必要时指定 --width 120（40–400 列）；有真实 TTY 时默认读取其列宽，否则采用 120 列。把 CLI 输出原样放入 text 代码块；依赖用真实续行、每格一项，按中文、组合字符和 emoji 显示宽度对齐，完整标题和编号只在同格换行，不截短、不改值。窄窗口会增加同格续行，不能冒充横向空间充足。终端控制字符只作可见转义，原账本内容不变。Markdown 与 JSON 默认保持原契约；text 只是已确认宿主限制下的完整信息适配。该终端不再使用带可信 HTML 换行标记的 Markdown 表格交付。修复后原样呈现实际查询，回读用户对依赖续行及表格可读性的反馈。

终端文字宽度所需的锁定 MIT 实现随 tools/vendor/terminal-width 安装，原始版本、源码 SHA 和许可证同目录保留。标准项目无需 node_modules 即可执行任务 CLI；隔离安装检查必须覆盖真实 CLI 的 text、JSON 与帮助入口。

```bash
npm run tasks -- help
npm run tasks -- list --format markdown
npm run tasks -- status --format markdown
npm run tasks -- audit --task TASK_ID --format markdown --columns progress,completed
npm run tasks -- show TASK_ID --format markdown
npm run tasks -- audit --operation-id OPERATION_ID
npm run tasks -- rebuild
```

发布和修改通过 `--file -` 接收 JSON，避免保存临时请求文件，完整字段契约以 help 为准。Skill 模板和 CLI 只在核心维护，部署安装至项目 `.agents/skills/review-tasks`，核查 SHA 并拒绝覆盖未知本地修改。`tasks install` 可重做安装，rebuild 可重建视图。
## 过程资源与宿主配置

阶段资源先登记精确归属，跨阶段交接给具名消费者；正式资源 retain 具体用途。阶段成功、失败、取消都要收尾，父任务运行 finish、check、complete；空清单同样检查项目镜像，不进行全局 prune。

执行器保存 PID 与出生时间、路径的设备／inode，以及 Docker ID 和任务标签。未知路径、符号链接、Git 工作或其他运行占用阻断清理。异常退出由服务监督器每五分钟有界补清，不按时间猜测具名交接已经失效。

跨阶段输出在阶段 scratch 之外预先登记并 transfer，消费者结束后 release。正式运行包和数据库先 retain 再切换指针，写明用途及恢复证明。process run 自动建立父任务；所有阶段结束后明确 finish，已结束任务不复用。额外资源必须先由所属执行器精确登记；cleanup:complete 的可选 --manifest 仅接受同一任务的空清单，不接管任意目标。任何主机状态未知或消费者未释放都不能报告清理完成。

日志最多七天且不超过 100 MiB。未知执行结果保留恢复输入，不按普通日志清除。临时资源默认上限 64 GiB，并保留至少 8 GiB 可用空间。

本机 assistant 配置指向宿主 Codex 与 Python 可执行程序，沿用宿主登录；外部 production.command 是显式的命令参数数组，输入通过 JSON 标准输入传入，输出必须位于受管阶段。配置和凭据不因文档阅读而改变。

部署排空仍阻断活动任务和未核查的结果未知操作。内置只读 Codex 建议若已具有同实例唯一受管进程结束回执、无活动子进程，原恢复目录身份完整且本机只读执行器配置自该请求启动前未改变，可在保留原 RESULT_UNKNOWN 操作和恢复输入的前提下发布；部署回执逐项保存该证明。此判断仅释放已结束只读建议的运行占用，不改变结果状态、不重发模型请求，不适用于素材生成、媒体处理或其他未知外部执行。
