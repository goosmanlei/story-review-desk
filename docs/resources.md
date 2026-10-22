# 私有 OSS 资源与完整恢复

实例可用 `config/resource-storage.json` 启用 `project-resources-v1` 资源存储。未配置的实例保留完整本地包兼容。开启后，`config/resource-catalog.json` 与本机 `.runtime/resources/catalog.json` 将业务逻辑路径映射到准确对象版本；媒体读取不再回退到旧 `export/assets/`。

配置声明 project、instance_id、bucket、region 和 cache_bytes。每条目录记录保存 key、显式 version_id、SHA256、字节数、MIME、verified_sha256 及验证时间；预览放在同一记录的 variants，不创建新的业务素材或评论目标。路径不得越界、含符号链接或指向其他项目。目录不保存签名链接、凭据或内嵌原件。

已验证的配置按实例根、配置及实例声明文件的设备／inode／大小／纳秒修改与变更时间复用，最多 16 项，返回独立副本；读前读后身份不一致则拒绝本次读取并提示重试。目录采用同样的物理身份检查。配置原子替换、实例归属改变和凭据文件轮换及时生效，签名仍按当前凭据及有效期生成。

运行凭据由外部权限 600 的 JSON 文件提供，`REVIEW_OSS_CREDENTIALS_FILE` 指向该文件，内部 project／instance 与配置及 `REVIEW_RESOURCE_INSTANCE=local|vps` 对应。运行身份只读项目、写本实例允许的前缀，不需要账户级密钥或删除权。镜像、业务导出和离线介质不包含该文件。

## 读取和制作

HTTP 在核对业务与目录身份后，307 跳转到有效期 900 秒的准确版本签名地址；应用响应禁止缓存和 referrer。进程内最多保留 512 条签名，同一准确对象复用 300 秒，让浏览器复用已缓存字节；每次仍核对当前目录和凭据，根目录、项目、实例、凭据、对象版本、请求方法及下载文件名分别隔离。故障刷新强制重签，签名不写磁盘。小图 480、大图 1600 像素内等比例缩放，保留 EXIF 方向与透明度，不裁切、不放大。视频使用轻量封面，音频使用预计算波形；播放、下载和制作继续读取原件。媒体错误或播放／拖动持续等待八秒后，当前元素至多刷新一次签名；普通缓冲恢复即取消计时。刷新保留最新拖动目标、播放／暂停、范围和草稿，期间的新定位或暂停优先。

OSS 对无效 Range 和 If-Range 的行为不能直接当作应用契约。应用对无效范围返回 416；带 If-Range 的请求经准确缓存维持匹配 206／不匹配 200。普通有效范围仍直读 OSS。显式下载由应用从校验后的准确缓存提供附件，使用 UTF-8 文件名，避免跨域跳转离开未提交的审阅页面。独立媒体请求不携带应用认证 header。

轻量波形 JSON 也由应用从准确缓存同源提供，使用 ETag 复验，避免浏览器跨域重定向缺少 Origin 时无法读取波形。冷缓存先从 OSS 下载并完整校验派生文件，客户端不下载或解码整段音频来绘制波形；原音频播放仍直接读取 OSS。

后台使用 `resources.lease_scope()` 与 `materialize()`。缓存按内容摘要定位，流式下载、全量 SHA256／大小／MIME 校验、原子启用，默认上限 16 GiB、最多三个传输；持租约的输入不被清理。普通导入、提交、回执、参考选择、方案复用、需求合并和评论写入均先准备各自实际需要的媒体。全量读取与 ffprobe 探测在写事务外完成；事务内复用准确物理身份的校验结果，缺少预检或文件改变时拒绝，并在提交前再次检查身份。

### 完整内容检查与云端验证

日常读取、完整目录检查、导出及恢复默认采用 `local-first`：先验证本实例的缓存／原件介质，再查显式登记的本机来源；全部允许来源都没有合格内容时，才 GET 描述中准确 key／VersionId 的缺项。大小、完整 SHA256、描述 MIME 及业务／媒体检查保持；本地文件没有云端响应头，MIME 依据已验证描述和适用的媒体探测，不能据此断言云端当前响应 MIME。单个缓存损坏先从其他合格来源修复，不回退 latest 或同名旧文件。

完整目录通过 `verify_content()` 在合格来源上直接核验，不为检查复制整套任务镜像；只有实际物化使用或联网补缺才填充任务缓存。统计中的 `source_hits` 表示来源直接核验，`source_copies` 表示实际本地复制，两者均不产生云验时间。

`resources.set_local_sources(instance, [source_instance, ...])` 登记最多16个受控实例根，并继承来源已显式登记的恢复来源，保存到本机 `.runtime/resources/local-sources.json`，不导出；`append=True` 保留已有登记。每次检查来源的项目、bucket、region及实例身份；只搜索其准确 SHA 缓存、`resource-bundle/<SHA256>`，以及其自身目录明确绑定该内容的原件路径，不扫描其他任务或猜旧路径。复制源缓存期间持共享锁，沿用目标缓存的容量预留、磁盘余量、原子安装及租约；不清退来源实例。登记来源不是永久恢复副本的保证。

`REVIEW_RESOURCE_READ_POLICY=local-only` 或 `resources.read_scope('local-only')` 禁止云端读取，缺失／损坏准确失败；内层不能将严格策略改为联网。它不产生离线候选，也不替代用于离线继续制作的 `REVIEW_RESOURCES_OFFLINE=1`。默认制作环境保持在线语义，新原件仍须上传并真实完整回读。

`verify_remote()` 始终完整 GET 指定云版本，独立于缓存；`verify_catalog(..., mode='remote')` 对每个去重云版本执行同样检查。即使相同 SHA 在另一个版本已可读，也不替代本版本。冷缓存下该次合格字节原子保留，后续物化不再下载；暖缓存仍实际读云验证。返回回执写本次远端验证时间，普通本地命中不更新目录中历史 `verified_at`。`full=False` 只核描述及冲突，不能当作内容或云端检查。描述冲突先整体验出，再开始读字节。

```sh
python3 -m review_desk --instance "$INSTANCE" resource-verify --mode local-only
python3 -m review_desk --instance "$INSTANCE" resource-verify --mode remote
```

该命令检查导出目录全部原件／派生、准确数据库快照、逐表指纹、数据库完整性及业务引用。结果分别标明内容策略与是否实际云验，并输出 OSS GET尝试数、返回正文字节、缓存命中、本地复制及补取数量。`resources.read_statistics()` 可在后台流程取得相同计数；它不统计浏览器流量、HTTP头或账户账单，不将模拟测试算作真实云请求。

下载期间只持同一对象的排他锁和传输名额，全局容量锁仅用于预留、清退和安装。容量核算包含活动预留的完整大小，磁盘余量还扣除尚未写入的预留并保留 64 MiB；不同对象的小文件可在其他传输进行时继续读取。同对象下载合并，完成后原子安装；取消或失败释放预留和本次临时文件。未知临时文件计入占用，不误删活跃下载；已持租约的原件不能清退。资源锁等待和传输边界检查客户端取消，写事务预检沿原契约执行。

上传先探测文件，再上传并完整读取准确版本，最后登记。8 GiB 单文件上限保持；128 MiB 以上采用 32 MiB 分片，检查点保存 key、SHA256、字节数、MIME、upload_id。源文件改变或检查点不符停止；未知结果先查对应 key／分片，重复上传保留第一个已经验证的目录身份。派生明确传 MIME，不依赖宿主机文件扩展名数据库。云端验证不以 ETag 或自写 metadata 代替真实读取。

独立附件可在任务实例运行 `python3 -m review_desk --instance "$TASK_INSTANCE" resource-put "$CANDIDATE_FILE" --prefix content/attachments`。命令返回带 SHA256 文件名的不可变逻辑路径，冻结准确目录，供后续业务登记／发布使用；它不创建业务素材或修改正式数据库。新内容产生新路径，不能覆盖旧逻辑路径的身份。

旧候选物理清空、制作层物理清空和合并后的本地文件删除工具拒绝操作云实例，不能把本地文件缺失误报为云资源已删除。普通需求合并仍可用；云对象的最终删除须另行核对完整历史引用、保留版本、独立恢复介质与项目授权后执行。

## Schema 16

云配置实例的 `export` 生成一致性 SQLite 快照，上传为实例自己的准确快照版本。Git 中的 manifest 保存快照描述、逐表指纹及轻量资源目录摘要。故事、方法、对象修订、候选、调用、配置、评论编辑历史、关系、工程及成片表均保存；私有渲染队列不导出。有私有创作记录时拒绝公开恢复导出。

`restore` 先按选定策略核对全部完整字节、目录、数据库完整性和业务闭包，再在一个写事务中安装。安装前重新检查目标仍为空且未改变；失败回滚数据和目录，不覆盖并发到达的业务。日常恢复默认本地优先；明确审计云端或验证在线灾难恢复时使用 `--resource-policy remote`，准确远端版本缺失不能被暖缓存掩盖。旧 Schema 14／15 完整本地包仍沿原解析器恢复。

```sh
python3 -m review_desk --instance "$INSTANCE" export
python3 -m review_desk --instance "$EMPTY_INSTANCE" restore
python3 -m review_desk --instance "$EMPTY_INSTANCE" --resource-policy remote restore
python3 -m review_desk --instance "$INSTANCE" offline-bundle --destination "$OFFLINE_MEDIUM"
```

恢复命令读取目标实例自身的 `export/`；先把准确轻量导出及声明的实例配置放入空实例。独立介质保存准确快照、声明的配置和每个原件／派生的真实字节，目录为 `resource-bundle/<SHA256>`，不复制任意配置文件。介质必须放在 Git 外。另一个新空实例配置 `REVIEW_RESOURCES_OFFLINE=1` 并禁止网络后，可从介质恢复；每项必须在自身介质内通过完整校验，即使缓存已热也不掩盖缺项。也可用 `read_scope('local-only', medium_only=True)` 限定介质验收范围。项目发布工具负责最新快照、双端部署、介质位置与保留责任，系统恢复不负责覆盖在线活库。

离线介质与继续工作的实例分开保留。工作实例也必须位于 Git 外，并有可写的 `resource-bundle/`；新增工程、成片、附件和预览先完整校验，再原子保存到该目录，不依赖可驱逐缓存。目录以 `source=offline-candidate` 标明仅在本地保存，包含内容摘要、大小与 MIME，不伪造 OSS key 或版本号。离线模式禁用签名及所有云端客户端入口；也可重新导出包含本地快照的新离线介质。

恢复网络后，关闭 `REVIEW_RESOURCES_OFFLINE`，显式运行 `python3 -m review_desk --instance "$OFFLINE_WORK_INSTANCE" resource-promote`。命令按原逻辑路径和 MIME 上传全部离线原件及其派生，完整回读后一次切换资源目录；任何失败都保留原离线目录，重试先查询已上传对象。随后重新 `export` 生成准确云快照，才可沿项目流程发布。未提升的离线候选在在线读取、远端验证和发布时一律拒绝；本地候选不是正式云资源。

读取缓存 `.runtime/read-cache.sqlite3` 与资源字节缓存用途不同，前者的范围见 [读取性能](production-performance.md)。自动测试、真实云请求、Chrome 交互、两种完整恢复及用户接受分别记录，不能互相代替。
