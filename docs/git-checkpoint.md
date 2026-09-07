# 项目 Git 业务快照

干净核心软件与具体故事使用不同私有仓库。核心软件代码提交由维护者按发布里程碑完成；本工作器只提交绑定故事的业务快照及精确注册媒体，不扫描父目录、不代提交其他暂存内容。

## 明确启用

先在故事仓库完成首次提交、配置 Git 身份和 Git LFS；把运行目录、凭证、实时数据库、发行包缓存和助手会话加入忽略规则。已提交的 .gitattributes 至少包括：

    project-data/repository.jsonl.gz filter=lfs diff=lfs merge=lfs -text
    instances/my-story/media/** filter=lfs diff=lfs merge=lfs -text

仅将当前有效注册媒体纳入 Git；已退文件保留历史登记/墓碑，不重新复制。原始来源资料与正式业务历史仍保留。LFS 路由必须指向同一个已核验 PRIVATE GitHub 仓库，不能使用其他自定义 LFS 服务器。

在精确实例的 runtime/git-checkpoint.json 写入绑定（该配置是本机运行配置，不提交 Git）：

    {
      "schemaVersion": "1.0",
      "enabled": true,
      "instanceId": "实际实例身份",
      "instanceRoot": "/故事项目/instances/my-story",
      "repositoryRoot": "/故事项目",
      "githubRepository": "账号/故事私有仓库",
      "remote": "origin",
      "remoteUrl": "https://github.com/账号/故事私有仓库.git",
      "branch": "main",
      "snapshotPath": "project-data",
      "mediaPrefix": "instances/my-story/media",
      "core": {
        "repository": "账号/干净核心私有仓库",
        "commit": "完整40位提交SHA",
        "packageRoot": "/故事项目/review-software",
        "packageManifestSha256": "software-manifest.json原始字节的SHA256"
      },
      "pollSeconds": 30
    }

工作器必须从该精确发行包运行。明确绑定之后，实例启动会启动独立主机工作器；缺配置或 enabled=false 时不启动、不推送。也可以显式执行一次：

    node review-software/scripts/instance-git-checkpoint.mjs --instance /故事项目/instances/my-story --once

## 触发、提交和失败边界

每轮先读取当前发布、正式事件水位、非排除记录头的 revision/SHA（含未发布草稿）、媒体与文档别名元数据；不读取正文。只有此轻量业务指纹或 core pin 变化时才导出完整历史。助手对话、heartbeat、运行队列和已知临时工作器记录均不参与指纹或 Git 归档。

业务归档与媒体清单在同一 PostgreSQL 读取事务及媒体读取租约中冻结。保留行的原始字节、正式历史与 SHA 不变，整组排除运行记录链，并重算 exportSha256、表行摘要和规范运行计数。归档与媒体分别采用 LFS，普通 Git 仅保存索引与说明。

工作器只 stage 专属快照文件和清单中的精确媒体路径。其他暂存内容会阻断自动提交；不强制 add、reset、覆盖、merge 或 force push。快照替换先保留可恢复的旧目录和明确操作日志；中断后先核验并恢复该次替换。未知文件或用户修改会阻断，不能当缓存删除。

成功必须同时证明本地 commit 与远端配置分支的实际 SHA 一致。推送失败、超时或结果待核时保持未确认状态；下一轮先回读远端，同一普通 push 可重试，分叉不自动合并。状态和日志在实例 runtime 下，不刷入 Git。

## 校验与恢复

这是 REVIEW_GIT_BUSINESS_SNAPSHOT_1，不是完整备份，也不是只读网站导出。完整实例备份应另外保存，尤其是需要保留私人助手会话时。

从 Git 取得该精确项目提交，执行 git lfs pull，核对归档清单里的 core 仓库、提交与发行包 SHA。然后使用匹配软件：

    node --max-old-space-size=4096 review-software/scripts/instance-git-export.mjs verify --snapshot /故事项目/project-data --repository /故事项目
    node --max-old-space-size=4096 review-software/scripts/instance-git-export.mjs restore --snapshot /故事项目/project-data --repository /故事项目 --output /全新实例目录

恢复验证业务行摘要、完整源字节、退休清单和有效媒体 SHA，创建新目录、独立 PostgreSQL 卷与新运行期，不覆盖当前实例、私人助手任务不恢复；正式生产授权历史保留，但旧授权在新运行期不能领取、启动或继续执行。已提交／运行中／结果不明的旧请求必须先用 REQUEST_ID、LOG_ID 与平台核查时间登记真实终态；未开始的旧授权可明确取消。新的 AUTHORIZE 必须显式 authorized=true，并由服务器绑定当前实例与运行期；恢复本身不是新授权；也不恢复 Codex/Git/API 密钥。随后由操作者明确配置本地认证与新的 checkpoint 绑定，不能沿用旧机器绝对路径自动推送。
