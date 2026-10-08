"""Disposable browser fixture. Local color/tone clips are not story candidates."""
import argparse
import copy
import json
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch
from test_audiovisual import AudiovisualTest
from review_desk import production as p, material_plans as mp
from review_desk.production_media import ingest


def create(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('fixture destination must be new')
    f = AudiovisualTest(); f.setUp()
    try:
        f.composition()
        def change(oid, **fields):
            old=p.record(f.store,oid);payload=copy.deepcopy(old['payload']);payload.update(fields)
            f.put({'object_id':oid,'kind':old['kind'],'expected_version':old['version'],'payload':payload})
        f.put(f.spec('book','ENTITY',title='隔离测试歌本',entity_type='prop',aliases=[],facts=['仅供验收'],choices=[],unknowns=[],sources=f.sources))
        for oid,title in [('dry','干燥'),('wet','浸湿')]:
            f.put(f.spec(oid,'STATE',title='隔离歌本 · '+title+'状态',entity=f.ref('book'),state_model='complete-v1',
                dimensions={'structure':'纸页与封面','condition':title,'contents':'测试文字','placement':'桌面'},
                reference_media='image',production_description=title+'的测试歌本，仅验收控件',sources=f.sources,facts=[],choices=[],unknowns=[]))
        change('av-shot',entities=[f.ref('book')],states=[f.ref('dry')],state_model='complete-v1',continuity_context=[f.ref('wet')])
        change('av-scene',shots=[f.ref('av-shot')]);change('av-episode',scenes=[f.ref('av-scene')])
        for oid,title,media in [('front','正面身份','image'),('side','侧面机位','image'),('first-frame','镜头首帧','image'),('sound','动作声音','audio'),('video','镜头视频','video')]:
            need=f.need(oid);need['payload'].update(title='隔离测试 · '+title,media_type=media,
                usage='editorial' if media=='video' else 'post_audio' if media=='audio' else 'generation_input')
            need['payload']['generation'].update(model='isolated-fixture',prompt='仅供界面验收的本机色块和测试音，不是作品生成。',
                output={'name':'隔离测试 · '+title,'description':'不是作品素材，不发布到正式库','review_criteria':['核对版本、候选和准确引用']})
            f.put(need)
        targets={}
        for oid,media in [('front','image'),('sound','audio'),('video','video')]:
            for version in (1,2):
                if version==2:
                    row=p.record(f.store,oid);change(oid,generation={**row['payload']['generation'],'prompt':'第二版隔离方案；本机测试原件，不是作品生成。'})
                for candidate in (1,2):
                    name=f'{oid}-v{version}-c{candidate}';suffix={'image':'.png','audio':'.wav','video':'.mp4'}[media];path=f.root/(name+suffix)
                    color=['red','blue','green','yellow'][(version-1)*2+candidate-1]
                    base=['ffmpeg','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1']
                    if media=='audio':args=['-f','lavfi','-i',f'sine=frequency={220+version*100+candidate*50}:duration=2','-ar','48000',str(path)]
                    elif media=='image':args=['-f','lavfi','-i',f'color=c={color}:s=640x360','-frames:v','1','-threads','1',str(path)]
                    else:args=['-f','lavfi','-i',f'color=c={color}:s=640x360:r=24:d=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',str(path)]
                    subprocess.run(base+args,check=True,capture_output=True,timeout=30)
                    with path.open('rb') as stream:component=ingest(f.root,stream,path.name)
                    plan=p.record(f.store,oid)['payload']['generation'];call=name+'-call'
                    # Import explicitly synthetic execution facts. No provider is called.
                    with patch('review_desk.generation.validate_call'):
                        f.put(f.spec(call,'CALL',title='隔离测试本机色块／测试音',method='generation',tool='local-ffmpeg-fixture',
                            status='submitted',synthetic_fixture=True,inputs=[],outputs=[],lineage={'i2i_depth':0},generation_requirement=f.ref(oid),
                            **{k:plan[k] for k in ('model','parameters','prompt')}))
                    f.put(f.spec(name,'ASSET',title='隔离测试 · '+name,media_type=media,subjects=[],states=[],components=[component],
                        production=f.ref(call),lineage={'i2i_depth':0},synthetic_fixture=True))
                    with patch('review_desk.generation.validate_call'):change(call,status='completed',outputs=[f.ref(name)])
                    targets[name]=f.ref(name)
        # A third empty video plan proves results are not borrowed from another version.
        row=p.record(f.store,'video');change('video',generation={**row['payload']['generation'],'prompt':'第三版尚无候选，仅测试空版。'})
        inputs=[{'reference':f.ref('front'),'selection_state':'unselected','use':'正面路线','necessity':'one_of','group':'构图','route':'front'},
                {'reference':f.ref('side'),'selection_state':'unselected','use':'侧面路线','necessity':'one_of','group':'构图','route':'side'},
                {'reference':f.ref('sound'),'selection_state':'unselected','use':'可选动作声','necessity':'optional'},
                {'reference':f.ref('sound'),'selection_state':'unselected','use':'条件动作声','necessity':'conditional','condition':'保留同期声'}]
        change('first-frame',generation={**p.record(f.store,'first-frame')['payload']['generation'],'inputs':inputs,'relation_model':'context-v1'})
        f.put(f.spec('custom-relation','MATERIAL_RELATION',title='测试自定义关系',upstream=f.ref('front'),downstream_id='first-frame',context=f.ref('av-shot'),
            purpose='对照两份构图的阅读关系',preserve='身份',change='仅作描述，不进入生成输入',check='人工查看',
            type_id='custom-echo',type_label='画面呼应',type_version=1,type_definition={'endpoints':['REQUIREMENT','REQUIREMENT'],'direction':'directed','attributes':{'note':'关联说明'}},
            attributes={'note':'隔离自定义属性'},semantics='description',necessity='optional',basis='production_choice',sources=f.sources))
        targets.update({oid:f.ref(oid) for oid in ('front','side','first-frame','sound','video','av-shot','av-scene','av-episode','book')})
        mp.validate(f.store)
        f.store.close();shutil.copytree(f.root,destination)
        (destination/'config').mkdir(exist_ok=True)
        (destination/'config/instance.json').write_text(json.dumps({'id':'audiovisual-fixture','title':'隔离验收 · 非作品素材','schema_version':1},ensure_ascii=False))
        (destination/'fixture-targets.json').write_text(json.dumps(targets,ensure_ascii=False,indent=2)+'\n')
    finally:
        f.tearDown()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination',type=Path)
    create(parser.parse_args().destination)
