# 可写 VPS 发布器

本地是唯一发布母本。VPS 允许业务编辑与正式审阅，但其修改不回传；发布、失败恢复和回滚都从本地生成的不可变完整包重建独立数据库、媒体与新运行期。源码交付、本机演练和真实 VPS 部署是三种不同事实。

## 入口与边界

统一入口为 `node scripts/instance-vps.mjs COMMAND --target target.json`，或 `npm run instance:vps -- …`。所有远端访问必须显式带 `--connect`；`REVIEW_VPS_OFFLINE=1` 硬性禁止 SSH。本机测试另需 `--fixture-host`、`fixture-only` SSH 名及 `.test-tmp` 专用目录，不能用于生产主机。

| 命令 | 行为 |
| --- | --- |
| `inspect` | 只读核对实际 Nginx、挂载、依赖、凭据存在性、宿主和 Docker 文件系统容量、版本与阶段 |
| `plan --package DIR` | 只读预算；`--inspection FILE` 使用已保存检查结果完全离线计算 |
| `pack --instance ROOT --output NEW_DIR` | 本地一致性数据库归档、租约媒体、精确核心软件、Linux amd64 镜像；不读取本机 AI 认证 |
| `verify --package DIR` | 核验路径、文件、大小、SHA、软件清单及数据库／媒体语义 |
| `prepare-host` | 验证已有依赖、创建专用目录与入口网络，最小修改 Nginx；不安装或升级宿主系统 |
| `deploy --package DIR` | 从本地重复流式读取，维护、收尾、重建、校验、上线，再保存干净包 |
| `rollback` | 直接使用上一版干净包，交换两份包的位置身份，不复制完整 scratch 归档 |
| `status` | 只读返回阶段、错误、资源和最近回执；进程存活不等于认证或模型可调用 |

修改命令必须提供 `--expected-current RELEASE_ID`（首次为 `NONE`）和稳定的 `--operation-id`。中断后先查 `status`，使用原包、原预期版本、原操作编号重入。排他 OS 锁、目标配置 SHA、阶段记录和精确资源清单防止并发覆盖。不允许全局 prune。

`pack` 默认要求干净精确 HEAD，排除凭据、缓存、构建历史、私有运行态和活跃锁。`--development` 仅用于明确标为 UNVERSIONED 的本机演练，禁止发送 VPS。完整包可能包含私有业务历史，须按业务敏感数据保管；只读权限与哈希用于意外修改检测，不是对宿主管理员的防篡改保证。

最终 VPS 应用镜像使用 `docker build --no-cache` 构建，并核对精确源码提交与镜像身份。

VPS 全量备份为只读一致性扫描，维护进程最长一小时；普通维护和导入仍使用原有更短上限。到期或退出会失败关闭，不能将不完整目录继续作为发布包。CLI 只显示 PostgreSQL 受控错误分类和退出原因，不输出原始 SQL、stderr 或凭据；再次尝试须使用新输出目录。

完整包先构建同一精确提交的本机架构只读备份镜像，以应用新归档兼容修复而不替换正在运行的本地 owner。独立镜像只允许 backup，校验镜像 digest／提交，仍核对原实例 owner、数据库私网、只读挂载和媒体租约；普通维护不允许切换软件。该镜像只在本机使用，成功后去除专属临时标签，不进入 VPS 包。

仅重打软件时可用 `pack --baseline VERIFIED_LOCAL_BACKUP --output NEW_DIR` 替代 `--instance`。它重新完整验证已在本地冻结的 PostgreSQL／媒体基线，只复制清单内字节并再次验证；不能用远端运行态或不完整备份充当本地母本，不会更新其冻结时间或业务修订。这样软件修复无需再扫描仍在创作的源数据库。

## 目标准备

访问策略默认 `accessMode: "BASIC_AUTH"`。只有明确用作完全公开演示站时才设置 `"PUBLIC_DEMO"`：所有访客可匿名浏览和修改，Nginx 取消认证但覆盖代理身份头，网关仍校验专用入口、HTTPS Origin 与部署／运行期。页面显示公开演示提示。它不是安全隔离或付费调用额度控制；重新发布不能撤回泄露内容或外部费用。公开演示勿放隐私、凭据，真实 AI 凭据需另行决定并控制风险。

非敏感 JSON 字段以 `vps-target.mjs` 为严格 schema。配置包括 SSH 别名、HTTPS URL、basePath（根路径使用空字符串）、独立深层 hostRoot、已有 Nginx 容器与单文件挂载源、专用网络、显式 Node／Docker／Bash／Python／uv／Codex 路径、凭据路径引用和容量保留值。推荐 4 vCPU、8 GiB 内存、120 GiB SSD；实际剩余空间必须重新读取。公网 IP 可作为 HTTPS 主机名，但须有可信 IP 证书并自动续期；HTTP 仅承载 ACME challenge 和到固定 HTTPS 主机的跳转，不承载应用或认证。

发布控制器要求 Linux x86_64、Node 22.13+、Docker 29+（包括按平台 inspect/save/load）、Compose v2+、Python。镜像包含应用、PostgreSQL 18.6、Python 3.11 和确定性媒体工具。宿主 Codex 桥接器另外要求兼容 Node、uv、Python 以及既有 VPS 认证来源；缺项时业务可用，对应 AI 能力未就绪。Python 历史 AST 兼容验证使用 3.11，不改写历史哈希适应新解释器。

已有认证配置未知时，两项 `authBasicRealm` 和 `authBasicUserFile` 同时设为 `FROM_EXISTING_HTTPS_SERVER`。发布器只自动提取目标 HTTPS server 的明确 Basic Auth 指令；包含复杂 include／继承或无法唯一解析则停止，需人工核对后提供精确非敏感值。绝不猜测密码文件位置。

Nginx 修改以完整旧 SHA 和精确标记区块约束；保留其他字节，以同 inode 原位写入适配单文件 bind mount，执行 `nginx -t`、reload、挂载读回。失败恢复修改前配置。私有模式的认证覆盖无尾斜杠入口、页面、API、静态资源和媒体；代理保留前缀、覆盖转发身份，只关闭该路径访问日志。

Web 无发布端口，连接数据库私网与专用入口网；数据库和工作器不接入口网。网关只接受重新 inspect 得出的 Nginx IP，内部应用仅监听 loopback。客户端伪造身份／代理头不能替代 Basic Auth；写入同时要求 HTTPS Origin、部署标识、运行期、原有 CAS、幂等键及授权门禁。

## 三份存储与恢复

常态为当前可写实例、当前干净包、上一版干净包。逻辑归档字节不是 PostgreSQL 物理大小，不能按固定倍数估算数据库。`pack` 默认使用冻结基线、本机架构的同提交镜像和独立 PostgreSQL 完成四遍流式恢复，采样数据／索引与 WAL；不启动 Web、工作器或模型。精确资源清单和详细样本保存在输出目录旁的 `.capacity.json`，演练实例随后按清单回收。

运行预算包含实测数据／索引峰值、20%（至少 256 MiB）的布局／架构余量、实测 WAL 与 PostgreSQL max_wal_size 中较大者、再一个 max_wal_size 的检查点余量，以及登记媒体、软件和 256 MiB 运行文件余量。镜像解包层、内容存储、临时上限及保留空间单独列出，不在运行预算中重复计入。它是可核验的发布预算，不是业务长期增长配额或 PostgreSQL WAL 的硬上限，仍需监控磁盘。

软件修复重打包可加 `--capacity-measurement VERIFIED_MEASUREMENT.json` 重用已成功的本机恢复实测，须匹配基线 SHA、数据库 SHA、恢复／数据库结构代码闭包、版本、四遍流式证明及新运行期；不接受仅手填数据库大小或未完成恢复。旧格式完整包仍可校验及回滚，但保留其旧预算，不伪造实测。

`plan` 按阶段计算峰值：输入校验与镜像加载时不抵扣运行实例；确认干净恢复包后移除旧实例，才抵扣只读盘点中明确归属的实际分配字节；新版开放且最旧包删除后，才抵扣该包并保存新版。已有干净包已经反映在实际剩余空间中，不再加一次；回滚只交换已有两包，不预留新的完整包。不同文件系统或无法核对归属时不抵扣；开始回收运行实例前再次检查容量。

发布顺序：校验新输入和当前干净恢复包 → 维护／等待在途请求与工作器 → 阻断未终结及结果未知执行 → 按清单移除可丢弃运行态 → 多遍流式验证并导入新 PG 卷／直接写媒体 → 核验 HTTP、镜像与媒体 → 开放 → 删除最旧 backup → 当前干净包转为 backup → 向腾出的包位置流式保存新版。

发布前的静止检查区分当前 VPS 执行与恢复进来的旧 AUX 未知结果。只有当前运行期的完整恢复证明成立，且当前 AUX 头修订、原始字节 SHA 与该实例所属干净包逐项相同，才列为 `RESTORED_HISTORY_UNCHANGED`；外部结果仍 UNKNOWN，不重试、不改历史。新增／变化的 UNKNOWN、任何其他未终结工作、活动事务、HTTP 请求及宿主会话仍阻断；时间戳、旧运行期或同请求编号本身不能豁免。

数据库恢复四遍读取，源在每遍校验 SHA；媒体和镜像直接进入目标资源，不将完整归档复制到 scratch。干净包保存中断时，新服务和前版干净包仍保留；阶段为 `SAVING`，禁止开始下一轮，原命令逐文件校验续传。所有目标删除限定发布器清单与所有权标签；不会收集远端修改作为 backup。

新版开放前恢复失败，可用原部署命令增加 `--recover-current`，从当前干净包重建旧版；这不是恢复远端修改。没有当前干净包的首次发布只可修复并重试原操作。未知外部结果必须先人工核查，不自动重试模型或清空记录。若状态、Nginx 或资源归属漂移，保留现场并停止。

## AI、浏览器和运行期

VPS 禁用 Git checkpoint，不写项目仓库。浏览器存储和写请求绑定部署 ID／runtimeEpoch；旧页面收到变化即停止写入并要求刷新，不迁移旧 VPS 草稿。数据库逻辑路径和冻结历史字节不加前缀，只有 HTTP 表现层加 basePath；构建契约与启动配置不匹配拒绝启动。根路径 LOCAL 与 Sites 只读模式保持独立。

数据库恢复不会赋予旧队列执行资格。运行目录、日志、助手会话和临时产物随实例回收；凭据位于独立基础设施目录，包只保存路径引用。Web 不直接调用模型；评论与素材 AI 工作器在数据库私网运行，密钥只来自目标私有文件。缺凭据、认证失败和结果未知分别处理，不以进程健康冒充提供方可调用。

Codex 复用 VPS 既有认证，不复制开发电脑凭据。显式传入 `REVIEW_CODEX_AUTH_HOME`、`REVIEW_EXECUTABLE_PATH`、Node／uv／Python／Codex 路径，受管进程精确停止，工作目录每个运行期独立。官方 [认证说明](https://developers.openai.com/codex/auth/) 将 auth.json 视为敏感凭据；[app-server account/read](https://developers.openai.com/codex/app-server/) 的缓存账户读取不证明真实模型请求成功。因此发布器就绪信息明确保留认证未核验状态，不自动发收费探针。

宿主桥接器的私有 SDK home 通过独立空 tmpfs 在 Web／工作器容器中遮蔽；容器不读取其中的目标认证副本。任务收尾依据数据库 AUX 和公开运行记录，不扫描私有凭据目录。

VPS 页面内“完整备份／导入／恢复”由发布器接管，防止网页上传再制造第四份完整副本；该基础设施入口禁用不影响业务编辑、审阅与受控工作器。

## 本机验收

`npm run test:vps` 覆盖协议、状态机、故障、流式验证、恢复执行门禁和桥接服务。`node scripts/check-http-presentation.mjs` 检查 HTTP URL 属性与客户端指令。真实演练需显式 `REVIEW_TEST_VPS=1 node tests/vps-rehearsal-setup.mjs`，仅创建 synthetic 故事和 loopback TLS Nginx。不得复用生产端口、任务或密钥。实际执行的版本、容量样本、浏览器结果、未观察项以单独验收证据为准；单元测试不替代真实部署观察。
