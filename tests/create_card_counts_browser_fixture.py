"""Reproducible isolated 1008 cases; no network generation or formal writes."""
import argparse
import copy
import json
import shutil
from pathlib import Path
from test_material_plans import PlanVersionsTest
from review_desk import production as p, generation as g, entity_review as er, material_plans as mp


def create(destination):
    destination = Path(destination).resolve()
    if destination.exists():raise ValueError('fixture must be new')
    f = PlanVersionsTest();f.setUp()
    try:
        f.setup_plans();f.generate();f.generate('call2', 'result2')
        # Multiple file components of the same original remain one candidate.
        asset = p.record(f.store, 'generated')
        components = copy.deepcopy(asset['payload']['components'])
        components.append({**components[0], 'id': 'same-original-second-component'})
        f.change('generated', components=components)
        plan = p.record(f.store, 'need-full-overall')['payload']['generation']
        f.change('need-full-overall', generation={**plan, 'prompt': '新版方案尚未生成'})
        for oid, title in [('zero', '隔离 · 零状态未采纳'), ('single', '隔离 · 单状态已采纳'),
                           ('other', '隔离 · 另一个关联实体')]:
            entity = f.entity(oid);entity['payload'].update(title=title, production_description='隔离完整描述')
            f.put(entity)
        form = f.full('single-full', production_description='隔离完整形态')
        form['payload']['entity'] = f.ref('single');f.put(form)
        f.change('songbook', title='隔离长名称 · 同一关联实体两条直接关系与多个文件组成的计数核验')
        for oid, target, label, direction in [('relation-one', 'single', '第一条直接关系，保留完整说明', 'forward'),
                ('relation-two', 'single', '第二条直接关系；'+('完整的长说明需要全部阅读，不能截断。'*12), 'mutual'),
                ('relation-three', 'other', '切换另一准确关系', 'forward')]:
            f.put(f.spec(oid, 'RELATION', relation_type='entity', entities=[f.ref('songbook'), f.ref(target)],
                         label=label, direction=direction, category='use', basis='script',
                         sources=[f.source], applies_to=[f.source]))
        view = er.snapshot(f.store, 'single')
        g.decide(f.store, {'entity_id':'single','action':'accept','expected_version':view['decision_version'],
                          'scope':view['decision_scope'],'acceptance_mode':view['acceptance_mode'],
                          'actor':'隔离技术验收','reason':'测试记录，不是作品采纳'})
        # Model an older stored original whose scheme/version was not registered.
        with f.store.db:
            f.store.db.execute("DELETE FROM material_plan_comments WHERE material_id='voice'")
            f.store.db.execute("DELETE FROM material_plan_members WHERE material_id='voice'")
            f.store.db.execute("DELETE FROM material_plan_versions WHERE material_id='voice'")
        targets = {'entity': f.ref('songbook'), 'zero': f.ref('zero'), 'single': f.ref('single'),
                   'material': f.ref('need-full-overall'), 'candidate': f.ref('generated'),
                   'counts': mp.card_counts(f.store, ['need-full-overall', 'need-wet-overall', 'voice'])}
        f.store.close();shutil.copytree(f.root, destination)
        (destination/'config').mkdir(exist_ok=True)
        (destination/'config/instance.json').write_text(json.dumps({'id':'1008-fixture','title':'1008 隔离边界测试'},ensure_ascii=False)+'\n')
        (destination/'fixture-targets.json').write_text(json.dumps(targets,ensure_ascii=False,indent=2)+'\n')
    finally:f.tearDown()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('destination',type=Path)
    create(parser.parse_args().destination)
