"""Explicit, disposable new-model compositions shared by regression tests."""
from review_desk import production as p


def ensure_lock(f):
    if not f.store.db.execute("SELECT 1 FROM objects WHERE id='lock'").fetchone():
        if not f.store.db.execute("SELECT 1 FROM objects WHERE id='story'").fetchone():
            f.store.put_object('story', 'STORY', {'title': '隔离测试故事', 'blocks': []})
        f.put(f.spec('lock', 'INPUT_LOCK', screenplay=f.ref('story'), episodes=[f.ref('episode')],
            approval={'actor': 'fixture', 'statement': '隔离技术测试，不是作品认可', 'scope': 'fixture'}, specification={}))
    return f.ref('lock')


def shot(f, oid='shot', **values):
    fields = dict(input_lock=ensure_lock(f), sources=[{**f.source, 'block_ids': ['a', 'b']}],
        number=1, purpose='核对连续动作', framing='桌旁中景', spatial='人物和歌本同框',
        axis='桌南侧', movement='固定机位', action_start='拿起歌本', action_end='放下歌本',
        performance='轻拿轻放', lighting='窗边柔光', color='灰蓝', editing='动作完成再切',
        continuity='同一本歌本', fps=24, duration_frames=192, sound=['纸页声，无对白'], entities=[], states=[])
    fields.update(values)
    return f.spec(oid, 'AV_SHOT', **fields)


def composition(f, *, shot_id='shot', scene_id='scene', episode_id='av-episode', shot_values=None, scene_values=None):
    f.put(shot(f, shot_id, **(shot_values or {})))
    source=p.record(f.store, shot_id)['payload']['sources']
    fields=dict(input_lock=f.ref('lock'), sources=source, purpose='测试视听场', structure='观察与放下',
                rhythm='先看再放', continuity='保持手位', shots=[f.ref(shot_id)])
    fields.update(scene_values or {})
    f.put(f.spec(scene_id, 'AV_SCENE', **fields))
    f.put(f.spec(episode_id, 'AV_EPISODE', input_lock=f.ref('lock'), sources=source,
        story_episode=f.ref('episode'), number=1, purpose='测试视听集', structure='完整动作',
        rhythm='留出反应', continuity='同一时段', scenes=[f.ref(scene_id)]))
