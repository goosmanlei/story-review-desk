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
| .git/lfs/objects | 独立的完整内容库 | 离线恢复当前与上一快照；不能与运行原件硬链接 |
| 受管导出目录 | 自包含 tar 完整包 | 明确导出才产生，成功后保留 24 小时 |
| review-library | 人可阅读的媒体入口 | 与运行原件硬链接，共享字节 |

快照工作文件保持指针，关闭自动 smudge，避免检出后再次展开完整媒体。离线核验逐一检查指针、大小与内容库 SHA，不下载网络对象，也不依赖运行原件。项目只使用自己的独立 `.git/lfs/objects`；自定义共享 LFS 存储和仓库外路径不能用作这个恢复库。

后台工作器先生成并核验快照，取得独占锁后切换 current／previous。失败保留原快照；切换结果未知时保留恢复输入和原操作编号，阻断新保存，先核查原操作。完整下载包只有显式导出或导入时产生，清退到期归档前核对操作、阶段和占用，不清理未知任务。需要长期保留完整包时，将下载文件存放到用户自行管理的位置。

恢复使用当前／上一快照编号或未过期完整包编号，在受管新目录建立独立 PostgreSQL 和软件副本；当前实例不切换，也不启动真实模型任务。快照先从离线库展开到恢复阶段，再通过标准导入校验；阶段结束清除临时展开内容。

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

## 过程资源与宿主配置

阶段资源先登记精确归属，跨阶段交接给具名消费者；正式资源 retain 具体用途。阶段成功、失败、取消都要收尾，父任务运行 finish、check、complete；空清单同样检查项目镜像，不进行全局 prune。

执行器保存 PID 与出生时间、路径的设备／inode，以及 Docker ID 和任务标签。未知路径、符号链接、Git 工作或其他运行占用阻断清理。异常退出由服务监督器每五分钟有界补清，不按时间猜测具名交接已经失效。

跨阶段输出在阶段 scratch 之外预先登记并 transfer，消费者结束后 release。正式运行包和数据库先 retain 再切换指针，写明用途及恢复证明。process run 自动建立父任务；所有阶段结束后明确 finish，已结束任务不复用。额外资源必须先由所属执行器精确登记；cleanup:complete 的可选 --manifest 仅接受同一任务的空清单，不接管任意目标。任何主机状态未知或消费者未释放都不能报告清理完成。

日志最多七天且不超过 100 MiB。未知执行结果保留恢复输入，不按普通日志清除。临时资源默认上限 64 GiB，并保留至少 8 GiB 可用空间。

本机 assistant 配置指向宿主 Codex 与 Python 可执行程序，沿用宿主登录；外部 production.command 是显式的命令参数数组，输入通过 JSON 标准输入传入，输出必须位于受管阶段。配置和凭据不因文档阅读而改变。
