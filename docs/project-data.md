# 项目包与配置

项目根保留 README、AGENTS、STATE、package.json、core-lock.json 和 Git 配置。review-software 是固定提交的通用软件；instance 保存实例定位、SHA 媒体及私有运行态；guidance 保存项目规则；project-data 保存可验证业务包；.process 仅放受管临时资源。

`npm run review -- --help` 查看 CLI。通过正式 API 执行 export 导出版本 2 项目包；verify 核验所有分块、原始资料及媒体字节；import 向独立空白项目上传并由后台工作器事务导入。拒绝非空数据库、路径逃逸、符号链接、哈希差异及缺失的 PRESENT 媒体；原有 MISSING / RETIRED 状态按事实保留。模块分块支持流式处理；单条记录上限 64 MiB，整个业务包不要求装入内存。

包由 manifest.json、data/模块/分块.ndjson、originals/SHA 和 media/SHA 构成。保留永久身份、草稿及采用头、必要历史、原始字节、关系、精确输入、判断和未采用候选。不导入 operation 队列、运行期、凭据或执行授权；恢复时产生新运行期。

系统配置：审阅标准、主体及素材类型、制作阶段、来源规则、助手功能开关、资源上限与技术标准。项目配置：标题、语言、外观、故事规则、画面基准、默认入口及来源优先级。字段只有一个归属，不按多个层级覆盖。两个 scope 分别导入导出；本机配置始终排除。

普通恢复应新建空白标准项目并导入已验证项目包。目录复制不能代替 PostgreSQL 备份。封存备份路径不得出现在软件、项目导出或清理配置中；重新取回封存数据必须由用户明确授权。

## 项目目录审阅

项目根的 `review-library/` 是自动维护的资源入口。后台工作器每五秒检查已提交的数据和文件指纹；先完整构建、校验，再原子切换根软链。失败保留上一完整目录并报告 ERROR / STALE。只有当前及上一份受管目录保留，旧目录按任务回执核对占用和文件清单后清理；不会沿软链删除原件。

images、audio、videos、other 按登记业务类别和主体组织；名称使用英文语义名、无声调拼音、真实版本和身份短后缀，扩展名由 MIME 与登记格式决定。无法确认的归属放 unclassified。媒体入口直接相对链接 instance/media/SHA；候选、采用、历史、预览、退役及缺失分别记录于 `.catalog.json`。目录名称是可读别名，不能作为业务身份或实际观察证明。

项目配置的 `reviewLibrary` 支持 `enabled` 和 `texts`。texts 是显式选择的列表，每项包含 `kind: source|screenplay`、永久 `objectId`、可选精确 `revisionId` 和 `texts/.../*.md` 相对路径。source 导出登记原始字节；screenplay 按该故事的集场正文汇成一份完整稿，保留角色、对白及表演说明，不夹带附文、Prompt 或制作资料。未指定 revisionId 的文本跟随当前正文；索引始终保存导出时完整的对象版本依据及字节 SHA。文本缓存同样按 SHA 命名。

所有入口仅供读取。软链没有独立写权限；首次建立时核验原件并移除写权限，普通同步按 inode、大小、mtime、ctime 与权限复验变动文件。原件、数据库、业务对象与历史引用不因目录同步改写。文本选择与别名配置通过配置事务保存，随业务包往返；生成目录、缓存、机器路径及过程回执不进入业务包或 Git。

```bash
npm run review -- library status
npm run review -- library list
npm run review -- library resolve review-library/images/分类/主体/文件.png
npm run review -- library sync
npm run review -- library verify
npm run review -- status OPERATION_ID
rg --files --hidden --no-ignore -L review-library
```

sync 与 verify 返回后台 operationId，须按 status 读回 SUCCEEDED；verify 强制校验全部 SHA。resolve 校验实际链接及字节，返回精确媒体版本或文本来源依据和项目内 exactPath。录音、图片及视频是否实际观察仍需独立记录。后台没有运行时，目录保留最后一次同步的文件，应先核对同步状态再判断其是否为当前稿。

# 网页维护

系统管理的“数据与运行”提供完整备份、下载、实例核验、项目包导入和独立恢复。MAINTENANCE_VERIFY、MAINTENANCE_BACKUP、MAINTENANCE_RESTORE 经 POST /api/v1/jobs 排队，由同一个后台工作器执行；GET /api/v1/maintenance 与 operations/:id 返回实际结果。CLI 对应 `review maintenance verify`、`review maintenance backup`、`review maintenance restore --file restore.json`，恢复请求包含 backupId、targetName、explicit:true。

备份采用同一版本 2 项目包，校验全部分块、原始资料和登记媒体后才提供 tar 下载。浏览器导入选择解压后的完整目录；仅允许空白实例，媒体逐项上传并在工作器中校验 SHA，业务数据通过流式 Blob 传输。机器配置、凭据和执行资格不进入包。

独立恢复只接收本实例已核验备份的操作编号，不接收任意来源路径。新项目位于本次受管恢复目录，复制已核验软件和业务包，创建独立 PostgreSQL，核验后保留具体目录、数据库与回执；当前实例不切换，不启动新副本的 Web 或模型。运行结果给出新目录，可从该目录使用正常部署入口上线。用户备份和恢复副本作为明确保留资源，不按日志期限清除，封存旧项目备份始终不被读取。
