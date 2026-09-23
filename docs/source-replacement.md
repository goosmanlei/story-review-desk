# 精修正文的受控原地替换

这是审阅台的独立内容管理操作，不负责小说写作、候选生成、创作检查点或完本判断。故事特有的写作过程、工具与私有工作记录由故事项目管理；审阅台只接收作者已准备好的完整正文，供展示和审阅。

普通 `import-sources` 仍禁止改写已有资料 ID。用户明确要求原地更新且资料满足下述保护条件时，才使用：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/story-repo \
  replace-source-content /path/to/complete-source.json --expected-revision 原SOURCE哈希
```

输入是一个完整资料 JSON 对象，不是片段、差异或包含多个资料的数组；格式与普通资料相同。预期哈希取自当前资料的 SOURCE 修订内容（`objects` 命令输出 `revisions[].payload.source_revision`），不是对象修订 ID。作者需自行确认完整性与文学质量，系统不要求采用某种写作流程。

## 保护条件

- 目标必须是已有 `story-refinements` 资料，保留原 ID、分类和排序；要保留原标题，提交文件也应保留标题。ID 不变使菜单入口与链接不变。
- 当前源哈希必须等于 `--expected-revision`，否则拒绝覆盖用户或其他进程的更新。
- 目标没有任何评论（包括已关闭评论），没有传入或传出的修订依赖，且对象只有一个 SOURCE 修订。
- 校验完整输入后，在同一个 SQLite 写事务内比较当前版本、检查引用并替换资料和对应的无引用修订；异常整体回滚。
- 相同内容重复提交直接返回 `changed:false`，不改写数据；不会删除评论、创建第二个条目或自动关闭意见。

这条受限通道不适用于已产生评论的后续稿件，不能为通过门槛而删除评论或依赖。真正的新版本审阅应保留原修订关联，并另行设计适当的版本流程。

## 交付与验证

成功后回读 `/api/sources`、`/api/comments` 和 `objects`，确认正文及保留项，再执行既有 `export`、故事仓库同步及干净恢复。完整干净稿与导入文件由故事项目管理，不另存旧稿文件，Git 历史不重写。

独立测试位于 `tests/test_source_replacement.py`，覆盖身份与幂等、普通导入不变、评论／依赖／版本保护、事务失败回滚及导出恢复，不导入任何写作引擎。运行：`PYTHONPATH=. python3 -m unittest discover -s tests -v`。
