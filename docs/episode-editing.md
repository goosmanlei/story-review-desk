# 成片剪辑

“生产制作 → 成片剪辑”把已选素材组织为每集一个可编辑工程、多个不可变成片。它不改变镜头原件、素材候选或故事输入。故事项目负责选材和剪辑判断；本系统负责准确保存、合成、播放、评论和恢复。

## 使用路径

初次进入选第一集，之后恢复上次选择。集、版本、字幕版和时间线缩放沿用共用平铺筛选、纸面配色和绿色选中状态。场镜导航、全片播放器及多轨时间线使用同一合成版本；空轨隐藏。窄屏筛选换行，场镜和时间线在自身区域滚动。

可逐帧、按帧定位、循环选段、查看完整原片并返回，或把当前范围交给既有评论侧栏。范围起止使用成片帧，止帧不包含在范围内；旧评论始终绑定旧输出和准确媒体组件。比较版本按稳定片段及来源位置定位对应内容；找不到对应内容时明确提示，不以相同秒数替代。

工程区可改源入出点、时间线位置、音量和淡变，分割或替换片段，并撤销、重做。保存工程不改变已播放成片；有修改时提示预览尚未更新，需“渲染新版本”后打开新成片。声音若来自原片混合音轨，会明确标注，不提供伪造的对白或音乐独听。下载包含字幕版、无对白字幕版、混音母版、SRT、工程和来源映射。

## 对象与时间单位

| 对象 | 行为 |
| --- | --- |
| `EPISODE_EDIT` | 每个视听集一个工程，以 `expected_version` 乐观并发保存；过期写入拒绝。 |
| `EDIT_SNAPSHOT` | 提交时冻结工程、准确依赖和渲染引擎；不可改写。 |
| `EPISODE_FILM` | 一个快照对应一套不可变交付物；与镜头素材及生成调用分开。 |

工程格式为 `episode-edit-v1`。`episode` 固定集对象及修订；`sources` 固定素材对象/修订、候选、完整组件及实际探测的流规格。`tracks`、`clips`、`markers`、`subtitles` 和 `titles` 分别表达轨道、编辑片段、场位置、对白/唱词字幕和片名/署名。可选 `method_execution` 绑定该集的准确方法执行。

视频源入出点使用源整数帧，时间线位置和淡变使用工程整数帧；音频源入出点使用源采样，时间线及淡变使用工程 48 kHz 采样。所有出点不包含，帧率保存为有理数。源入出点与时间线位置独立；归一化时长由真实流规格计算。画面须完整覆盖工程，只允许显式叠化的重叠，缺口、越界、零长片段、失效依赖或原件变化均拒绝。

原生工程支持声画不同切点、多个声音叠加、音量/淡变、画面裁切、局部原字幕去除、基础亮度/对比度/饱和度、叠化、片名及中文字幕。它不是外部 NLE 工程，也不提供复杂特效或自动选材。

## HTTP 与 CLI

浏览器和 CLI 共同调用 `editing_api.dispatch`。HTTP 使用 `POST /api/editing/{action}` 与 JSON 请求；CLI 从 `--request` 读取同一 JSON：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/instance edit validate --request validate.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/instance edit save --request save.json
PYTHONPATH=. python3 -m review_desk --instance /path/to/instance edit submit --request submit.json
```

| action | 请求内容 |
| --- | --- |
| `catalog` | 可选 `episode_id`，读取工程及可用成片。 |
| `get` | `object_id`，可选准确 `revision_id`；返回完整工程或成片。 |
| `validate` | `project`，校验结构、依赖、原件和流规格，不保存。 |
| `save` | `project`、`expected_version`；首次为 0。导入使用同一入口，导出使用 `get` 或成片工程组件。 |
| `submit` | `project_id`、`expected_version`、`task_id`、`request_id`。 |
| `status` / `cancel` / `retry` | 任务 `id`；重试仅允许失败、取消或中断的任务，每快照累计最多三次。 |
| `compare` | `source_output`、`target_output`、`frame`，返回对应内容的位置或无法对应的原因。 |

提交以准确工程及引擎生成持久指纹。重复请求不产生重复输出；未知结果先查状态。每实例只允许运行一个独立 worker：

```bash
PYTHONPATH=. python3 -m review_desk --instance /path/to/instance serve --render-worker
# 或由进程管理器分别启动 HTTP 与下面的独立 worker，勿同时重复启动：
PYTHONPATH=. python3 -m review_desk --instance /path/to/instance edit-worker
```

队列、进度和进程状态在 `.runtime/edit-render.sqlite3`，worker 持有 `.runtime/edit-worker.lock`；两者不进入业务导出。FFmpeg 在数据库写事务外运行；校验六份成品后才原子登记。重启核对已登记结果，将未完成任务标为中断，等待显式重试。取消会终止本任务子进程；Linux 父进程退出时也终止 FFmpeg。HTTP 与 worker 登记均参加实例 `http-write.lock` 的共享锁，正式发布需取得排他锁并协调所有写入进程。

## 渲染与恢复

Dockerfile 提供 FFmpeg、libass、Noto CJK 字体及 tini。目标实例仍须真实试渲染中文字幕；仅安装软件或健康检查成功不等于渲染可用。声音以 48 kHz、24-bit PCM 混音，输出 H.264/AAC；混音采用两遍响度规范化，目标 −18 LUFS、−1.5 dBTP。源编码仍如实记录，PCM 派生不代表源内容无损。

每套输出恰好含 `subtitled`、`clean`、`mix`、`project`、`subtitles`、`source-map` 六组件。校验不仅核哈希，还核视频尺寸、帧数、帧率、起点、声音编码/采样数，以及 JSON、SRT 与冻结工程的语义一致性。无对白字幕版仍保留片名和画内文字。

Schema 15 完整导出包含工程、快照、成片、准确来源及评论；运行队列不导出。Schema 14 旧完整导出在不含剪辑对象时仍可恢复。恢复只进入空实例，原件和业务依赖先预检；恢复后新队列可按工程重新提交。实例发布须使用增量及版本检查，保全新评论和历史，不能用任务快照覆盖活库。具体正式窗口和镜像切换由故事项目管理。

自动验证见 `tests/test_editing.py`、`tests/test_editing_recovery.py`、相关 bundle 与前端测试。它们与实例实际 Chrome 操作、完整作品观看、人耳听感及用户接受分别记录。
