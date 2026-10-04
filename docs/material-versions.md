# 素材、完整定义与候选

素材是一项持续存在的制作需求。实体或状态通过明确关联使用素材；相同素材可以由多个状态复用。只有准确的 `reuse` 来源、相同完整要求及输出规格能够证明共享身份。同名、相同文件或同一实体不足以合并。原需求 ID、准确修订及状态差异继续保存，采用仍逐使用位置记录。

素材版本包含一份完整定义：素材要求（用途、正文块、规格等）、检查项、输出规格，以及制作方法、模型、提示词、参数、有序准确输入和随机策略。输入锁定对象修订、文件组成和必要裁切或时间范围；顺序变化也改变定义。相同定义的重复调用可以产生多个候选，实际随机种子属于调用证据；改变显式固定种子会改变定义。

## 创建与冻结

首次实际 submitted、completed、failed 或 unknown 调用固定完整定义。提交前的草稿可在同一准备版本继续修改；冻结后修改任何要求或制作方案进入另一个版本。不能修改同一实际调用的方案、准确需求来源或已记录的实际种子。失败或未知调用仍固定定义，没有真实原件便没有候选。

候选身份由实际调用 ID 和原件 SHA-256 集合决定。相同调用与原件的标签、说明或用途补全沿用候选；另一调用即使输出相同文件也保留另一候选。一个调用的不同结果只服务各自明确关联的需求，不能因共用调用扩大用途。

`material_plan_versions` 保存素材版号与冻结状态，`material_plan_members` 保存准确的需求、调用及结果成员，`material_candidate_members` 保存候选身份。完整定义存于 `material_definitions`，每个版本由 `material_definition_versions` 绑定定义及取证来源。相同字段和子结构在 `material_content` 按内容哈希只保存一份；历史修订的存储引用由 Store 还原，调用者仍收到原逻辑 JSON 和原 revision ID。

## 共享身份与阅读接口

素材列表按规范 ID 去重。`material_identity` 返回规范 `id`、原 `aliases` 以及 `associations`：准确需求引用、原标题、scope、states、复用证据和旧版本归属。旧 ID 查询仍可用；旧 ID 与版号共同保持原含义，不把旧版号直接解释为规范素材的同号版本。需求发生实质变化时，写入入口重新核对证据并解除不再成立的共享关联。

每个版本返回 `definition`、`definition_id`、`definition_provenance`、`definition_gaps` 和 `definition_records`。后者只包含真正存在的准确 requirement/call 记录，方便正文与评论锚点共用原身份。历史没有要求或输出时明确标记缺口；引用方案与实际调用不同则同时保留真实方案和差异，不用最新方案补写历史。

场次镜头中的素材只由明确需求归属、计划参考、真实调用输入和准确采用建立关联；上级内容或同场状态适用性不自动传播为镜头素材。`placement_level` 表示真实归属层级（story、episode、scene、shot、entity 或 state），`usage_evidence` 解释该镜头为何关联它。

## 评论与采用

页面链接保存准确对象修订、素材、版本及候选；旧轮次与旧别名链接沿原身份解析。不存在的准确引用报错，不自动跳最新。版本切换只改变阅读上下文。

评论使用 `/api/comments`，继续绑定准确修订和原文字、图像区域或时间锚点，可附：

```json
{"material_context":{"material_id":"需求ID","number":2,"model":"plan-v1"}}
```

服务端仅允许目标是该版本准确成员，或该版本完整定义已验证的要求、检查项、输出、制作方案来源。来源可不在旧成员表；这不会扩大候选归属或改变原成员。`comment_records` 和 `comment_targets` 包含这些准确来源。同评论 ID 重试必须保持正文、锚点和版本上下文一致。评论及选择候选均不创建版本。

认可实体内容、审阅候选与采用候选分别记录。采用使用 `RELATION.relation_type=adoption`，锁定使用位置准确修订、需求槽位、候选修订、component_id 和必要 range/crop。共享素材不会将一个状态的采用复制到其他状态。

## 归档、导出与恢复

受管 JSON 请求、回执和制作归档使用 `material-archive-reference-v1` 保存原字节重建配方。字符串与嵌套 JSON 字符串引用同一内容图；空白、键序、Unicode 转义、重复键与数字原写法均可恢复。容器物理哈希与原文件逻辑哈希分开；HTTP（含 Range）、媒体校验和后台脚本经 `material_archives.read_bytes/read_json` 得到原字节。图片、音频和视频原件不作转换。

Schema 6 导出在 `objects.json` 保存物理引用和全部旧身份、修订、版本、评论、事件、采用、依赖；唯一 `material-content.json` 保存共享内容，manifest 校验其物理哈希。恢复时先校验内容图，再还原并校验旧 revision 身份、原件哈希、完整定义绑定与评论资格。空实例恢复兼容 Schema 1—6。旧格式保持原证据，不自动推断缺失定义；要输出完整新模型需先完成对应迁移。Git 已提交历史不作重写。

## 隔离迁移与回滚

旧轮次到方案的迁移保留 `material-plan-map/material-plan-migrate`。本次完整定义与物理存储迁移使用独立接口：

```bash
python3 -m review_desk --instance PATH material-model-map --output migration.json
python3 -m review_desk --instance PATH material-model-migrate migration.json --validate-only
python3 -m review_desk --instance PATH material-model-migrate migration.json
python3 -m review_desk --instance PATH material-model-verify
python3 -m review_desk --instance PATH material-model-rollback migration.json --validate-only
```

`--archive-list` 可向 map 传入实例根目录相对的受管 JSON 路径列表。`material-model-migrate --defer-archives` 只执行数据库事务，供正式 Git 归档切换前的短写窗口使用。新服务兼容旧原始 JSON，并可从实例活库解析稍后到达的归档容器。

HTTP 对应 `GET /api/production/material-model-map`、`GET /api/production/material-model-verify`、`POST /api/production/material-model-migrate` 和 `POST /api/production/material-model-rollback`；POST 使用 `{migration:完整迁移文档,validate_only:布尔}`，migrate 另接受 `defer_archives`。

Python `migration_plan(store, system_head=None, archive_paths=())` 生成准确增量；`migrate(store, document, validate_only=False, system_head=None, apply_archives=True)`、`rollback(store, document, validate_only=False, require_legacy=False)` 和 `verify(store)` 操作已有实例。可审阅发布包 `material-model-package-v1` 只包含内容节点 ID，并以相对路径和 SHA-256 绑定唯一内容图；`load_migration(path, content_path=None)` 校验后恢复完整迁移文档。

迁移在独立副本准备与预演，正式发布依实例授权顺序执行。数据库改写同一事务，重复执行校验模型后返回已应用；相关头、版本索引或归档改变则整批回滚。无关新增对象、评论与采用得到保留。专用回滚只撤销准确增量；相关内容已继续修改时拒绝覆盖，不能用旧副本替换活库。 正式旧镜像恢复使用 `require_legacy=True`，在逆向事务提交前拒绝仍含新编码素材的数据库，保留并发数据供向前恢复。回到原始 JSON 基线时同时移除本功能依赖新读取器的数据库触发器，保留其他触发器。若首次打开数据库后、迁移前即失败，可用 `prepare_legacy_runtime(db_path)` 清理这六个功能触发器；它只允许无已应用迁移且无引用载荷的数据库，否则拒绝启动旧读取器并要求向前恢复。文件采用暂存替换和异常恢复，数据库与文件不构成跨介质断电事务；正式切换使用延迟归档和发布编排处理这一边界。

## 验证入口

`tests/test_material_plans.py` 覆盖版本、候选、冻结、随机策略及评论；`tests/test_material_model.py` 覆盖事务冲突、延迟归档、回滚、字节恢复、发布包和 Schema 6 恢复；独立 `tests/test_ui_material_independent.py` 覆盖完整签名、共享身份、冻结来源及篡改拒绝。实例交付另需完整导出到空实例、原媒体与归档字节比较，以及真实浏览器中的版本、预览、评论和采用；自动化结果不替代页面验收。
