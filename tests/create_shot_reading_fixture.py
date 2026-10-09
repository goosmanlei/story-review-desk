"""Create a disposable, explicitly synthetic reading fixture without media calls."""
import argparse
import copy
import json
import shutil
from pathlib import Path
from test_audiovisual import AudiovisualTest
from review_desk import production as p


def create(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('fixture destination must be new')
    f = AudiovisualTest()
    f.setUp()
    try:
        f.setup_story()
        targets = {}
        for oid in ('reading-shot-a', 'reading-shot-b'):
            spec = f.shot(oid)
            spec['payload'].update(title='隔离夹具 · ' + ('先伸手' if oid.endswith('a') else '收回手'),
                purpose='看清伸手后收回', performance='看清伸手后收回',
                framing='同框中景，固定', movement='同框中景，固定', spatial='旧镜覆盖：桌旁',
                lighting='旧镜光线：油灯', blocks=[
                    {'id':'original-purpose','field':'purpose','text':'看清伸手后收回'},
                    {'id':'original-performance','field':'performance','text':'看清伸手后收回'},
                    {'id':'original-framing','field':'framing','text':'同框中景，固定'},
                    {'id':'original-movement','field':'movement','text':'同框中景，固定'}])
            f.put(spec)
            targets[oid+'-old'] = f.ref(oid)
        def compose(version):
            f.put(f.spec('reading-scene','AV_SCENE',title='隔离夹具 · 连续动作',
                input_lock=f.ref('lock'),sources=f.sources,purpose='仅验证准确阅读，不是作品设定',
                structure='伸手到收回',rhythm='依序',continuity='不迁移旧意见',
                spatial='旧场原空间' if version == 1 else '新场原空间',
                shots=[f.ref('reading-shot-a'),f.ref('reading-shot-b')]) | {'expected_version': version-1})
            f.put(f.spec('reading-episode','AV_EPISODE',title='隔离夹具 · 非作品数据',number=1,
                input_lock=f.ref('lock'),sources=f.sources,story_episode=f.ref('episode'),
                purpose='仅供验收',structure='完整动作',rhythm='依序',continuity='准确原稿',
                scenes=[f.ref('reading-scene')]) | {'expected_version': version-1})
        compose(1)
        targets['old-episode'] = f.ref('reading-episode')
        for block_id, quote in [('original-performance','看清伸手后收回'),('original-movement','同框中景，固定'),('@review/lighting','旧镜光线：油灯')]:
            f.store.create_comment({'id':'reading-fixture-'+block_id.replace('/','-'),
                'target_object_id':'reading-shot-a','target_revision_id':targets['reading-shot-a-old']['revision_id'],
                'anchor':{'type':'text','block_id':block_id,'end_block_id':block_id,'start':0,'end':len(quote),'quote':quote},
                'body':'隔离夹具历史意见：定位原字段 '+block_id+'，不得迁到新稿或同文另一字段。'})
        for oid in ('reading-shot-a','reading-shot-b'):
            row=p.record(f.store,oid);payload=copy.deepcopy(row['payload'])
            payload.update(purpose='观众先看清她收回手',performance='收回手',framing='双人同框',movement='轻靠近',
                spatial='新镜覆盖：门边',lighting='本镜例外：日光' if oid.endswith('a') else '本镜例外：窗下阴影',
                blocks=[{'id':'new-purpose','text':'观众先看清她收回手'}])
            f.put({'object_id':oid,'kind':'AV_SHOT','expected_version':1,'payload':payload})
        compose(2)
        targets['current-episode']=f.ref('reading-episode')
        f.store.close()
        shutil.copytree(f.root,destination)
        (destination/'config').mkdir(exist_ok=True)
        (destination/'config/instance.json').write_text(json.dumps({'id':'shot-reading-fixture','title':'隔离阅读夹具 · 非作品数据','schema_version':1},ensure_ascii=False)+'\n')
        (destination/'fixture-targets.json').write_text(json.dumps(targets,ensure_ascii=False,indent=2)+'\n')
    finally:
        f.tearDown()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination',type=Path)
    create(parser.parse_args().destination)
