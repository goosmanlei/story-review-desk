# 独立审阅台：实例与维护

软件以一部故事一个实例组织。每个实例拥有独立故事身份、PostgreSQL 数据库、媒体和本机运行状态，界面不设置多剧切换器。新故事创建新的项目和实例；同故事搬迁、复制或恢复保留原业务身份。

本文说明软件已实现的入口。某部故事是否完成正式迁移与部署，仍须核对该项目 STATE、实际服务和发布回执。导入、初始化、备份及恢复均不改变原审阅结论，也不授予内容生成权限。

## 目录与业务权威

```text
my-story/                         Codex 的项目工作目录
  README.md / AGENTS.md / STATE.md  项目入口与操作指引
  review-software/                 通用软件与依赖
  instance/
    instance.json                  实例身份、数据库类型与定位
    media/                         按版本和 SHA 登记的媒体
    data/                          兼容数据与维护暂存，不是 PG 业务库
    runtime/
      storage-owner.json           核实后的 Docker 技术定位
      private/                     本机凭证，不进入业务备份
      locks/ / logs/               运行锁与日志
    scratch/                       受控编译临时目录
    backups/                       源同步的数据库恢复点
  .maintenance/                    页面维护任务的受管产物
Docker 私有网络与独立数据卷         实例 PostgreSQL 数据，唯一当前业务库
```

新实例使用配置 schema 2.0 指定 PostgreSQL，数据库保存在专属 Docker 数据卷，固定 PostgreSQL 镜像由启动器校验。每实例拥有自己的私有网络与数据库口令文件，数据库没有宿主公开端口。Web、审阅工作器和维护容器使用统一 repository；宿主 Codex 和 CLI 经核实的 owner 传输执行维护，不直接连接数据库。

启动器核对数据库容器镜像、标签、网络和卷，再核验 Web 健康、实例身份、release 与运行期，最后登记 `storage-owner.json`。维护传输核对完整容器、镜像、提交和精确挂载。owner 不可用或身份不符时失败关闭，不回落到旧目录或另一份库；不要删除定位文件绕过检查。新建、恢复和迁移所需的维护容器只挂精确输入和输出，不挂整个旧故事项目，也不继承模型提供方密钥。

业务库保存不可变源版本、配置、图谱、候选、事件、任务、会话与发布。当前 release 绑定快照、配方、配置和 `sourceRevisionIds`；页面读取这批已发布版本。未发布 HEAD 是草稿或诊断数据，不能自动成为当前创作内容。项目根文件引导 Codex 选择实例，实际业务读取继续以实例发布绑定为准。

媒体文件在 `media/`，数据库登记 `mediaId + versionId + SHA-256`、字节数、相对路径、可用性和旧别名。导入原件通常进入 `media/blobs/<SHA><扩展名>`。已存在版本不能原位覆盖，同一旧路径对应多版本时必须精确指定版本和 SHA。缺失历史文件保留 `MISSING_HISTORY`，不造空文件或可用版本。

## 创建新项目并启动

需要 Node.js 22.13 或更新版本、Docker 与 Docker Compose。从已安装依赖的干净软件目录执行：

```bash
node scripts/instance-project-create.mjs --project /新项目目录 --title 我的新故事
```

目标必须不存在。该命令校验干净软件包清单，安装依赖，创建独立 PostgreSQL 空实例，并生成新项目的 README、AGENTS、STATE。新项目中的 Codex 以项目根目录为工作目录，先读这些指引。创建动作不启动 Web 或模型。

从新项目根目录检查并启动：

```bash
node review-software/scripts/instance-start.mjs --instance ./instance --offline --port 3000 --check
node review-software/scripts/instance-start.mjs --instance ./instance --offline --port 3000
node review-software/scripts/instance-verify.mjs --instance ./instance --url http://localhost:3000
```

`--check` 只读检查计划。实际启动前核对端口归属；隔离验收可选另一端口，不替换不属于本实例的容器。`--offline` 停用本实例的可选 AI 审阅工作器，不要求模型密钥。运行器会启动宿主维护工作器；AI 初始化则按其独立工作器连接与能力显示状态。

已有通用软件只想新增实例时，可以使用下列底层入口；它不创建外层项目指引和软件副本：

```bash
node scripts/instance-create.mjs --instance ../instances/my-story --title 我的新故事
node scripts/instance-package.mjs --output ../new-clean-software
```

`instance-copy` 用于同故事搬迁与恢复演练，保留原身份，不能用于开新故事。

## 空实例的开工流程

先在系统管理确认系统规则；在故事创作的来源资料中显式导入原始、整理和辅助资料，再到故事设定整理主体、空间与连续性。设定和素材分别保存草稿、预览及确认；不要求全量设定完成后才能写作者稿。原文件、文字提取、来源版本和实际观察分别登记，未观察音视频保持 UNKNOWN。

故事设定的资料整理任务冻结选定来源、当前配置与已发布设定，结果仅保存为独立建议稿。两个业务工作区按 owner 分别确认 changes，保留同一 domainGraph 永久身份。旧初始化和整图写入入口关闭，历史可读，转交时使用原基线三方比较。

新故事可以登记故事结构、完整剧本、场正文及分集方案的永久作者根和修订。完整分集卷宗经候选校验后按永久集提交六项判断，用户再明确确认本集全部正文并正式放行，经精确预览／同步建立本集发布和有序正文清单；其余集未完成不阻断本集。全剧裁决与采用独立，历史场级契约保留，不补造SCENE事件。来源、配置、图谱、作者草稿、候选和采用不因写入文档而合并为一次自动完成。

## 项目指引

README负责导航、AGENTS负责共同边界与任务路由、STATE负责当前事实；五份按需专题固定为guidance/story-review.md、materials.md、production.md、review-ui.md、operations.md（均在guidance目录）。专题属于故事实例数据库，不复制故事规则到通用软件包。

instance-guidance.mjs inspect默认只读根三份，--include-topics扩展到八份。GUIDANCE_UPDATE 1.0保持根三份替换；1.1在同一事务内支持白名单专题创建与更新，每批最多八份。首次创建要求revision和SHA预期均为null，别名与永久身份均不存在，角色固定PROJECT_GUIDANCE；更新严格核对已发布头、角色、唯一别名及旧新SHA。冲突全批回滚，不发布无关草稿；快照和配方原始字节、原角色、历史哈希及事件保持。

DB提交成功后按精确发布字节同步本地并核验。响应不明先核查同一操作回执，不盲重发。助手目录绑定当前发布revision和SHA，初始只带共同规则和索引，专题按需检索／读取并保留实际读取证据；历史引用仍绑定原字节。

通用基础已经提供来源与初始化、关系、作者首稿及候选采用的入口。它不从任意文字自动补全完整审阅卷宗、模型配方和全剧交付物；正式素材生产、镜头与后续制作仍须登记所需依据、输入、输出与审阅闭环。未锁定范围显示 `UNKNOWN`，没有待审项不表示工作完成。

浏览器写入入口对应 `/api/instance/sources`、`setting-extraction`、`domain-workspaces`、`authoring`、`configuration`。`initialization` 与 `relations` 保留历史读取，不接受旧整包写入。CLI 可通过已核实 owner 使用相同服务，例如：

```bash
node scripts/instance-sources.mjs list --instance ../instances/my-story
```

完整用户步骤见 [系统管理与新故事开工](system-management.md)。普通文档 CLI 仍可登记版本化草稿证据，必须提供期望 revision；它不能修改当前创作源、九份派生注册表、获批 Prompt、配方或可执行编译扩展，也不能用新别名绕过边界。

## 配置、协作与权限

系统管理包含使用与初始化、系统配置、数据与运行。配置的七组依次为项目目标与规格、资料与证据、实体与素材体系、参考与连续性、流程与交付、审阅标准、AI协作与界面。默认值经草稿、预览与发布生效；对象冻结既有规则，显式升级受依赖检查保护。关系默认规则变化作用于后续确认，既有确认关系要重新预览并发布才能采用新规则。详见 [系统配置](system-configuration.md)。

实体图谱说明故事身份、状态和预期参考；实际生产输入另以资产族、版本、SHA 和冻结记录证明。亲缘关系不自动授权身份参考，参考声明不证明历史调用已使用附件。界面、助手和制作门禁都保留这些区别。

本机 Codex Bridge 可以检查连接和读取冻结上下文。页面助手继续是只读建议任务；AI 设定整理是独立任务，只能回交待核建议。配置中的 AI 偏好和执行方式不会自行授权付费生成，也不取消权利、版本、质量与来源门禁。数据库权限及宿主凭证由受信任维护者管理，业务事务不能代替操作系统隔离。

## 实例定制编译器的受控源同步

对已经接入故事定制编译器的实例，入口为 `scripts/instance-source.mjs`，默认 `plan`。通用作者首稿的分集候选采用使用 `/api/instance/authoring` 的精确预览与采用事务，不要求新故事复制这套定制扩展。清单沿用 `schemaVersion: 1.0`，必须包含 `operationId`、当前 `snapshotId`、`operationType`、精确审阅绑定 `impact` 和 `changes`。每项变更给出唯一相对路径、旧 SHA、新 SHA、完整 `content` 或 `contentBase64`；不接受从外部目录继续读取的 `sourceFile`。

`CREATIVE_REVISION_SYNC` 只修改 profile 中该候选类型唯一对应的源，绑定获批 ReviewEvent、CreativeRevision、内容规范哈希和 basis 哈希。`PROMPT_SYNC` 绑定获批实际版本及实际 Prompt 哈希，并检查编译后的对应配方。九份派生路径从同次发布的 profile 获取，不能由请求临时换成另一组。

清单还须显式指定 `compiler` 的五个扩展入口：`workflowPath`、`storyQaPath`、`registryBuilderPath`、`snapshotBuilderPath`、`semanticQaPath`；以及 `snapshotPath`、`recipesPath`、`eventDirectory`。当前桥接对应数据库内登记为 `INSTANCE_EXTENSION` 的 `review_workflow.py`、`qa_story_structure_v2.py`、`build_production_control_registries.py`、`build_review_site_data.py`、`qa_review_site_v8.py`。它们是从原故事迁入、按精确 revision 固定的定制代码，不是基础软件自动推导出来的通用故事规则。

```bash
node scripts/instance-source.mjs plan --instance ../instances/my-story --manifest ../approved-source-manifest.json
node scripts/instance-source.mjs apply --instance ../instances/my-story --manifest ../approved-source-manifest.json --plan-hash 本次plan返回的完整SHA
```

`plan` 只在本实例 scratch 中物化发布固定的源文档、正式事件和已登记媒体，运行源修改范围检查、生成器、生成一致性检查、语义 QA 和获批候选规范哈希验证。输入不会从旧工程目录补齐。普通未采用草稿另放隔离证据目录。缺少扩展、源、九份注册表或精确媒体时失败关闭。发布的 Node 镜像包含 Python 3 和 ffmpeg；扩展在该容器内执行，不继承提供方密钥。宿主只通过 stdin 传递精确清单及其哈希，清单中的替换内容必须内联，禁止从 `sourceFile` 或旧宿主路径补读。额外 Python 依赖需要作为软件扩展显式安装到镜像，缺少依赖时不能回落旧工程运行。

`apply` 重新编译并核对整个 planHash，使用正式 API 登记 `REQUESTED → STARTED → BUILT`，建立独立 lease、追加 journal 和数据库恢复点。发布时再次核验审阅、配置、源和媒体绑定，在**一个实例数据库事务**内更新唯一源、九份注册表、快照和配方。正式 runtime 与 UI bootstrap 读回实际 release／epoch 后，才登记数据库证明及 `DEPLOYED → SUCCEEDED`。PostgreSQL 证明使用 `authority=INSTANCE_POSTGRES` 和 `INSTANCE_POSTGRES_RELEASE_AND_SOURCE_RECORDS`；既有 SQLite 历史证明保留原标记与字节，不据此把当前数据库误判为 SQLite。

旧语义 QA 中对文件系统证明模式的比较，由受控兼容桥增加数据库模式；先独立核对历史数据库 release 与证明哈希，不改写原扩展字节，也不关闭其他 QA。

地图原图未登记、但当前发布已精确绑定1600px审阅代理时，编译器可复用该代理的原字节并跳过对应缓存重建。计划逐项记录原图为`MISSING`、原图SHA为空及代理的精确路径和SHA，不补造原图。扩展升级前后地图函数、路径配置的AST和复用证据必须相同；源同步不得同时修改缺失原图或所复用代理。其余生成与语义QA照常执行，代理未绑定、哈希不符或宽度不符均失败关闭。正式镜像包含Python 3、PyYAML、Pillow和ffmpeg，不使用宿主的Python环境。

数据库物化的已核验输入在临时编译目录内使用同一固定修改时间，避免别名写入顺序使已有审阅代理重复转码；这不是原文件的业务时间，也不修改实例媒体。四个代理缓存函数的完整AST始终进入升级前后比较，原有宽度、码率与字节校验保持。源同步真正改写的文件仍产生新的临时修改时间。

源同步继续引用已登记代理时，必须保持同一已发布原件路径、完整SHA和代理绑定；固定代理地址改指另一原件或无法证明原配对时失败关闭。新代理地址仍由原编译器生成，缓存保留本身不构成新媒体登记、质量验收或权利判断。

全部场次已失效且当前审阅项为空的历史分镜联系表，也可在已发布QA记录、失效记录和当前媒体绑定一致时复用审阅代理。原件仍记为`MISSING`，预期原件SHA和实际代理SHA分别记录，角色保持`EVIDENCE_ONLY`；有效产物或不完整失效范围不能使用此例外。编译用事件文件按原事件的`eventKind + idempotencyKeyHash`命名，严格拒绝无效或重复身份，不改数据库事件。

历史剧本全文缺失时，只能复用同一已发布快照内精确命中的行段摘录，不能补全文或推算相邻行。重写记录与人物表演记录必须同时将该源路径及SHA绑定为`EVIDENCE_ONLY`；当前正文、已有源记录与变更中的源不能走此路径。复用须验证发布身份、快照SHA、原始resolver的AST、原件预期SHA、行区间与摘录SHA，其余引用仍由完整原resolver解析。计划单列原全文缺失与实际保留的摘录，升级前后全部复用证据必须一致。

已发布生产参考的原始构建清单缺失时，语义检查仅可对其执行`RELEASE_BOUND_REFERENCE_PARITY`：完整资产族、版本、来源记录及注册表保持不变，实际媒体、构建器和规格源的SHA逐项重验。原清单状态记为`MISSING`、实际SHA为空，报告明确未重验历史地图构建。此分支仅替换精确固定的原清单校验代码；原件存在时仍执行原校验，其余语义检查照常运行。原始校验AST与所有复用证据进入计划和CAS，升级前后须一致；相关对象、媒体或来源发生变化时失败关闭。

发布事务失败会整体回滚。若数据库已经提交，但端点读回或状态回执中断，journal 会明确标记需要核验；只可对精确操作继续：

```bash
node scripts/instance-source.mjs resume --instance ../instances/my-story --source-operation-id sop_精确操作ID
```

`resume` 只继续核验和状态链，不重新写源。恢复后 epoch 改变、发布已变化或操作不匹配时拒绝续接。不得把已有 BUILT、数据库恢复点或界面提示当成 SUCCEEDED，也不得为赶进度自动放行返修对象。

## 已发布编译扩展升级

`instance-extension` 仅维护已发布的 INSTANCE_EXTENSION，不改业务源、九份派生注册表、Prompt、媒体或正式事件。先将新软件按精确提交打包并部署至该实例的 Docker owner，再执行：

```bash
node scripts/instance-extension.mjs plan --instance ../instances/my-story --manifest extension-manifest.json
node scripts/instance-extension.mjs apply --instance ../instances/my-story --manifest extension-manifest.json --plan-hash 精确计划SHA --url http://localhost:3000
```

清单必须绑定 instanceId、baseReleaseId、softwareCommit、五个 compiler 入口与输出路径，以及逐项 alias、oldRevisionId、oldSha、newSha 和完整 UTF-8 content。普通导入接口仍禁止写扩展。此入口面向维护者已审核的编译代码，不是执行外部任意代码的安全沙箱。

计划在相同已发布输入上分别编译旧、新扩展，通过全套生成和语义 QA 后比较快照、配方及九份注册表的完整 canonical 内容。只允许指定生成器的精确代码 SHA 和对应生成快照标识在已知元数据位置变化；全部业务字段、历史事件身份与九份注册表必须一致。计划记录原始前后哈希、完整业务比较哈希和逐项元数据变化。apply 重验计划、全部发布源与 HEAD、事件、媒体、profile、lease 和 epoch，在同一事务追加扩展 revision 与 release，保留原业务快照、配方和注册表字节。正文支持新版本后，仍须单独登记候选、正式审阅和受控源同步。

提交后的运行读回失败会返回已提交 release 的明确错误；同一清单与计划哈希重调只续验，不重放写入。发布被替换、实例恢复、存在未发布 HEAD 或精确绑定变化时不能复用旧回执。

## 备份、恢复与 PostgreSQL 迁移

“系统管理 → 数据与运行”提供核验、完整备份、只读导出和恢复副本。页面先登记持久 `QUEUED` 任务，宿主维护工作器执行后更新 `RUNNING → SUCCEEDED / FAILED`。工作器离线时任务保留排队；执行中断的结果标为待核查，不自动重试。成功状态必须包含真实产物和校验证明。

维护 CLI 从软件目录执行：

```bash
node scripts/instance-backup.mjs --instance ../instances/my-story --output ../backups/my-story-backup
node scripts/instance-restore.mjs --backup ../backups/my-story-backup --output ../instances/my-story-restored
node scripts/instance-copy.mjs --instance ../instances/my-story --backup ../backups/my-story-copy --output ../instances/my-story-copy
```

输出必须是不存在的新目录。PostgreSQL 备份从一致事务视图导出完整业务归档，再按冻结媒体清单复制并校验 SHA、大小和缺失事实；业务备份不是直接复制活跃数据库数据卷。恢复先校验归档、清单和媒体，创建新的数据库卷、网络与口令，保留故事和历史业务 ID，并生成新的 `runtimeEpoch`。它不覆盖当前实例，不恢复宿主密钥、owner 容器身份或活跃模型线程，不续跑原任务。

页面只接受本实例已核验的受管备份，恢复目标限实例同层的新目录名。维护产物位于实例父目录的 `.maintenance`；CLI 可使用明确的新目标路径。完整备份含私有创作会话历史，应按创作资料保管。源同步产生的数据库恢复点不含全部媒体，不能替代整实例备份。

旧 SQLite 实例仍可通过兼容运行和备份工具维护。将它迁到 PostgreSQL 时，先取得已经核验的完整 SQLite 备份，再创建新目标：

```bash
node scripts/instance-migrate.mjs --backup ../backups/verified-sqlite-story --output ../instances/my-story-pg
```

迁移保留原文档、版本、事件、审阅和媒体的身份与原始字节，创建新的运行期；旧实例不被原位改写。SQLite 仅为兼容输入及隔离测试后端，不是新项目默认业务存储。有 Docker owner 的旧 SQLite 实例仍只允许在同一 Linux 虚拟机内通过核实后的维护传输访问，不能由宿主跨系统打开其 WAL。

恢复或迁移后先在隔离端口核验身份、release、epoch、数据和配方指纹、源版本、事件数量及关键媒体，再决定正式切换。源码、测试或备份成功不表示正式切换已经完成。

正式切换期间先登记迁移冻结锁，再停止原实例的精确容器和宿主工作器，记录其身份、镜像、原运行状态与数据库水位。以冻结后的一致备份完成迁移；`instance-cutover.mjs plan --freeze 冻结证明文件` 将计划绑定到这份证明及目标软件提交。普通启动和重新部署在冻结期间会被阻断，受控切换只允许启动计划中的 PostgreSQL 配置。

切换保持原实例根目录、媒体目录和私有运行目录的位置与身份，只替换数据库连接控制文件；Docker 启动前从容器侧逐项核验连接文件与媒体哈希。失败时恢复原控制文件和原容器运行状态。切换归档仅供这次控制文件回滚，不是完整业务备份；业务恢复仍须使用已核验的整实例备份。实际端口回读成功后才解除冻结。

## 只读导出与交付

只读导出是独立展示制品，不是可恢复业务备份。导出不包含原始录音、助手私有记录、提供方凭证和试制素材。准备导出任务只生成并核验制品，不自动发布网站。远端不接受资料导入、初始化、配置发布、正式审阅、运行、维护或源同步写入。

软件升级和正式发布必须保留原审阅、原 Prompt、版本与历史，隔离试制与正式域。先完成精确提交的构建、数据与语义 QA、隔离 E2E，再无缓存重建并强制替换所选正式 Docker，回读实际端口的实例、release、epoch、快照、配方和源一致性，完成只读浏览器回归。Sites 使用同一源码与已核验导出，保留实时访问策略并独立验证读写边界。测试端口不能代替正式入口，恢复副本不能未经切换验证就被称为当前权威。
