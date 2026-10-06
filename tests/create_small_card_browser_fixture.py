"""Disposable small-card cases. No story data or real generation is published."""
import argparse
import copy
import json
import shutil
from pathlib import Path
from test_generation import GenerationTest
from review_desk import production as p, generation as g, entity_review as er


def create(destination):
    destination=Path(destination).resolve()
    if destination.exists():raise ValueError('fixture must be new')
    f=GenerationTest();f.setUp()
    try:
        ep=p.record(f.store,'episode');f.store.put_object('episode','EPISODE',{**ep['payload'],'number':1,'scenes':[{'id':'s001','block_ids':['a','b']}]} ,expected_version=ep['version']);f.source['revision_id']=f.ref('episode')['revision_id'];f.source['scene_id']='s001'
        f.setup_plans();f.media();f.associate()
        f.change('voice',candidate_requirements=[f.ref('need-full-overall')])
        # Zero, single and multiple complete-state identities; candidates and
        # metadata revisions never add a state or material identity.
        f.change('songbook',title='隔离测试 · 多状态未采纳')
        f.put(f.entity('zero'))
        f.change('zero',title='隔离测试 · 无完整状态',sources=[])
        for oid,title in [('single','隔离测试 · 单状态已采纳'),('stale','隔离测试 · 需重新采纳')]:
            entity=f.entity(oid);entity['payload'].update(title=title,production_description='隔离构造的基础描述');f.put(entity)
            form=f.full(oid+'-full',production_description='隔离完整状态');form['payload']['entity']=f.ref(oid);f.put(form)
            need=f.need(oid+'-full');need['payload']['entities']=[f.ref(oid)]
            need['payload']['generation']=copy.deepcopy(p.record(f.store,'need-full-overall')['payload']['generation']);f.put(need)
            view=er.snapshot(f.store,oid)
            g.decide(f.store,{'entity_id':oid,'action':'accept','expected_version':view['decision_version'],'scope':view['scope'],'actor':'隔离技术验收','reason':'测试记录，不是作品采纳'})
        f.change('stale',production_description='隔离构造的基础描述已变化')
        f.change('need-full-overall',generation={**p.record(f.store,'need-full-overall')['payload']['generation'],'prompt':'隔离新版未生成'})
        f.store.put_object('fixture-story','STORY',{'title':'隔离测试剧本','blocks':[]})
        f.put(f.spec('fixture-lock','INPUT_LOCK',screenplay=f.ref('fixture-story'),episodes=[f.ref('episode')],approval={'actor':'隔离技术验收','statement':'测试记录，不是作品确认','scope':'one episode'},specification={}))
        for oid,scope,title in [('global','fixture-story','隔离测试 · 全剧素材'),('episode-only','episode','隔离测试 · 仅关联集'),('unassigned','zero','隔离测试 · 未关联集场')]:
            f.put(f.spec(oid,'REQUIREMENT',title=title,scope=f.ref(scope),slot='overall',required=False,purpose='隔离技术验收',media_type='image',usage='generation_input',entities=[],states=[],specification={}))
        f.put(f.spec('scene','PREPARATION',source={**f.source,'block_ids':['a','b']},checked=True,occurrences=[],notes='隔离测试'))
        f.put(f.spec('shot','SHOT_DESIGN',episode=f.ref('episode'),parent=f.ref('scene'),scene_id='s001',source=f.source,number=1,purpose='隔离测试',framing='近景',spatial='桌面',action_start='起',action_end='止',continuity='测试',duration_frames=24,fps=24,sound=[],entities=[f.ref('songbook')],states=[f.ref('full')]))
        plan=copy.deepcopy(p.record(f.store,'need-full-overall')['payload']['generation']);plan['prompt']='隔离旧视频方案，无原件';plan['output']['name']='隔离测试视频'
        f.put(f.spec('video-need','REQUIREMENT',scope=f.ref('shot'),slot='video',required=False,purpose='隔离技术验收',media_type='video',usage='editorial',entities=[],states=[],specification={},generation=plan))
        f.put(f.spec('failed-video','CALL',method='generation',tool='test',status='failed',inputs=[],outputs=[],generation_requirement=f.ref('video-need'),**{k:plan[k] for k in ('model','parameters','prompt')}))
        f.change('video-need',generation={**plan,'prompt':'隔离新视频方案，无原件'})
        targets={'entity':f.ref('songbook'),'state':f.ref('wet'),'material':f.ref('need-full-overall'),'candidate':f.ref('voice')}
        f.store.close();shutil.copytree(f.root,destination)
        (destination/'fixture-targets.json').write_text(json.dumps(targets,indent=2)+'\n')
    finally:f.tearDown()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination',type=Path)
    create(parser.parse_args().destination)
