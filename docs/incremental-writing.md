# 后台逐步创作

`writing` 是当前会话驱动的本地状态机，不是自动模型服务。它不调用模型、不读取 API 密钥、不暴露 HTTP 页面；会话停止后不会自动续写。恢复时先看 `status` 和 `context`，不要重写已经采用的片段。

运行方式：`python3 -m review_desk --instance /故事实例 writing --run 项目自定名称 子命令`。省略 `--run` 时名称为 `default`；工作数据在实例 `.runtime/novel-writing/名称/work.sqlite3`，与正式审阅库、公开 export 分开。书名取自种子 `book_title`，通用引擎不内置具体故事。工作库包含真实过程候选和检查点，不能用事后日志伪造逐步创作。

## 初始化与每轮步骤

`init seed.json` 的种子包含 `source_id`、`book_title`、`constraints` 和 `notes`。CLI 从正式库的只读快照固定原资料及评论基线。笔记分为 `outlook`、`facts`、`threads`、`issues`、`next`；事实和问题可用 `fragment_ids` 指向正文，问题用 `status: OPEN|CLOSED`、`blocking: true|false` 区分是否阻碍续写。

1. `context [--full] [--fragments ID ...]`：返回当前修订、笔记、片段目录、最近两段及指定前文；`--full` 返回全部正文。
2. `begin step.json`：输入 `step_id,base_revision,action,targets,purpose`。WRITE 另需 `chapter_id,chapter_title`，只新建一个片段；REVISE 只修改声明的已有片段；REFLECT 只更新构想，targets 为空。
3. `save-candidate STEP candidate.json`：正文候选为 `{"fragments":[{"id":"f01","text":"正文"}]}`，必须匹配声明范围，每片段不超过 2200 字符。通常写 600—1200 字，硬上限不是篇幅目标。REFLECT 候选仅含 `reflection` 文本。
4. `read-candidate STEP`：先保存后重读；其工具返回值是下一次判断的实际材料。
5. `accept STEP review.json`：输入简短 `observations` 和 `updates`。笔记顶层对象按记录键合并，其他值替换；可用 CLOSED 保留已解决事项的依据。REVISE 还要求 `rechecked_fragment_ids` 覆盖修改目标，及非空 `dependency_review` 交代后文核查。正文与笔记一次事务采用。
6. 或 `reject STEP 原因`：保留候选但不采用，允许重新决定下一步。候选不可原位改写，同一步骤重试必须内容相同。

有未结束步骤时不能开始下一步；未读当前检查点、基础修订过期、未重读候选或存在阻碍续写的问题时，相应操作拒绝。代码记录读取发生过，不能证明作者真的理解文本；必须实际阅读、判断，不机械填写通过。

## 全稿与发布

`stage file.json` 按 DRAFTING → FULL_DRAFT → REVISING → READY_TO_PUBLISH 推进，输入 `base_revision,phase,review`。最终 READY 另需在当前修订执行全稿读取，列全 `checked_fragment_ids`，并让 `checks` 中 `complete,causality,continuity,language,clean_copy` 均为 true；不得有阻塞问题或未结束步骤。它们是有依据的作者审校声明，不是文学质量的自动评分。

`bundle` 只在 READY/PUBLISHED 生成本工作目录的 `publication.json` 与 `clean.md`，不会修改正式库。每个实际章节成为一个稳定正文块，片段间自然分段，正文不含创作笔记。

正式原地替换使用单独的 `replace-source-content publication.json --expected-revision 原SOURCE哈希`（在 `writing` 命令组之外）。它只更新已有故事精修资料，保留 ID、分类、排序和菜单入口。普通 `import-sources` 仍不可改写旧 ID。比较版本、检查零评论/零依赖/单一 SOURCE 修订，以及修改正文和修订记录在同一 SQLite 写事务内完成；失配拒绝，异常回滚，相同内容重试不产生新写入。该受限操作替换无引用的旧修订，不建立历史版本入口，不删除任何评论。公开 Git 历史不重写。

发布后 `writing published` 只读核对正式正文哈希，再记录后台 PUBLISHED。若发布成功但进程中断，重新执行即可；不得重写小说。随后更新故事实例的干净正文与导入文件，执行常规 export、同步和恢复检查。工作库与笔记不随 export 公开。

测试：`PYTHONPATH=. python3 -m unittest discover -s tests -v`。所有写作和发布测试使用临时隔离库，不污染正式评论。
