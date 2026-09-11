# 项目包与配置

项目根保留 README、AGENTS、STATE、package.json、core-lock.json 和 Git 配置。review-software 是固定提交的通用软件；instance 保存实例定位、SHA 媒体及私有运行态；guidance 保存项目规则；project-data 保存可验证业务包；.process 仅放受管临时资源。

`npm run review -- --help` 查看 CLI。通过正式 API 执行 export 导出版本 2 项目包；verify 核验所有分块、原始资料及媒体字节；import 向独立空白项目上传并由后台工作器事务导入。拒绝非空数据库、路径逃逸、符号链接、哈希差异及缺失的 PRESENT 媒体；原有 MISSING / RETIRED 状态按事实保留。模块分块支持流式处理；单条记录上限 64 MiB，整个业务包不要求装入内存。

包由 manifest.json、data/模块/分块.ndjson、originals/SHA 和 media/SHA 构成。保留永久身份、草稿及采用头、必要历史、原始字节、关系、精确输入、判断和未采用候选。不导入 operation 队列、运行期、凭据或执行授权；恢复时产生新运行期。

系统配置：审阅标准、主体及素材类型、制作阶段、来源规则、助手功能开关、资源上限与技术标准。项目配置：标题、语言、外观、故事规则、画面基准、默认入口及来源优先级。字段只有一个归属，不按多个层级覆盖。两个 scope 分别导入导出；本机配置始终排除。

普通恢复应新建空白标准项目并导入已验证项目包。目录复制不能代替 PostgreSQL 备份。封存备份路径不得出现在软件、项目导出或清理配置中；重新取回封存数据必须由用户明确授权。
