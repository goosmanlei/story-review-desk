# 数据与业务接口

Web、review CLI 和网页助手访问 /api/v1。server/api.mjs 负责协议，六个模块负责业务约束，repository / commands / transfer 负责事务及存取。接口不互相调用。Next standalone 只负责页面和 HTTP；工作器独立领取后台任务。

objects 保存永久身份、当前草稿头和采用头；revisions 保存不可变正文、SHA、作者及修订号。集场顺序、实体关系、素材族、素材版本、媒体版本、关系归属和精确依赖使用关系表与索引。JSONB 保存对象自身的丰富内容；显示编号不作主键。source_documents 保留原始字节，保存来源说明的新稿仍指向同一原始资料。

保存产生草稿；提交进入待审；确认在同一事务中保存判断、采用修订和精确失效。已采用正文后续改动不改变旧采用头。素材版本本身不可覆盖，须在所属素材族新建版本。禁用及权利阻断即时阻断实际下传。内部适用确认不表示商业许可或法律审查。

依赖绑定 revisionId 及用途。设计依赖需求版本，实际输入依赖已采用的素材、调用或 Prompt 版本；改素材不废弃只依赖需求的设计。INPUT_LOCK 的采用检查全部实际输入、媒体可用性及权利；执行还需本次 objectId/revisionId 的显式授权和一个产出素材族。

所有写请求携带 operationId、对象 expectedVersion；HTTP 另携带从 health 得到的 x-review-runtime。CLI 自动绑定运行期。相同请求重放返回原回执，同编号异内容或版本冲突明确拒绝。多对象按稳定顺序加锁并全量核对；失败回滚业务变化，保留失败回执。旧运行期页面在恢复后无法写入。

入口：GET health / work / objects / objects/:id / source/:revisionId / media/:sha / configurations / operations/:id；POST transactions / jobs / upload / import / operations/:id/cancel；GET export / suggestions/:id。事务支持 save、submit、review、rights.record、configuration.save、suggestion.apply。对象读取可指定 revisionId，返回该版本的内容、关系、输入与判断。

后台状态为 QUEUED、RUNNING、SUCCEEDED、FAILED、CANCELLED、RESULT_UNKNOWN；队列上限 100，单 worker 并发 1。失联的执行先标结果未知，禁止自动再次调用。AI 建议绑定所读对象、原始资料版本和哈希，应用前重新核对；正文保留 10 分钟。操作回执及未知结果不按建议或普通日志过期。

浏览器缓存按 UTF-8 字节核算，至多 24 MiB，空闲 5 分钟淘汰；后端不缓存整剧读模型。连接池每个进程最多 8 个连接；分页目录和详情按需读取。轮询仅查询在途操作，不改变业务修订。未保存内容、筛选、阅读位置和圈选留在当前浏览器会话。
