"""Disposable synthetic editions: reuse, moved parent, ambiguous and absent shot."""
import argparse
import copy
import json
from pathlib import Path
from create_shot_reading_fixture import create as create_reading
from review_desk.store import Store
from review_desk import production as p


def create(destination):
    root=Path(destination).resolve()
    create_reading(root)
    store=Store(root/'.runtime/review.sqlite3')
    try:
        targets=json.loads((root/'fixture-targets.json').read_text())
        def ref(oid):
            row=p.record(store,oid)
            return {'object_id':row['object_id'],'revision_id':row['id']}
        def revise(oid,**values):
            row=p.record(store,oid);payload=copy.deepcopy(row['payload']);payload.update(values)
            p.import_records(store,{'format':'production-import-v1','records':[{'object_id':oid,'kind':row['kind'],'expected_version':row['version'],'payload':payload}]})
        revise('reading-episode',rhythm='第三版复用第二版的准确场镜')
        targets['reuse-episode']=ref('reading-episode')
        old=p.record(store,'reading-scene')
        payload=copy.deepcopy(old['payload']);payload.update(title='隔离夹具 · 镜头移入新父场',shots=[ref('reading-shot-a')],spatial='移动后父场条件，非原场')
        p.import_records(store,{'format':'production-import-v1','records':[{'object_id':'moved-scene','kind':'AV_SCENE','expected_version':0,'payload':payload}]})
        revise('reading-scene',shots=[ref('reading-shot-b')])
        revise('reading-episode',scenes=[ref('reading-scene'),ref('moved-scene')])
        targets['moved-episode']=ref('reading-episode')
        # The same exact child occurs under two exact parents, so identity is
        # insufficient until the reader explicitly chooses a parent.
        targets['remaining-scene']=ref('reading-scene')
        revise('reading-scene',shots=[ref('reading-shot-a'),ref('reading-shot-b')])
        revise('reading-episode',scenes=[ref('reading-scene'),ref('moved-scene')])
        targets['ambiguous-episode']=ref('reading-episode')
        revise('reading-episode',scenes=[targets['remaining-scene']])
        targets['absent-episode']=ref('reading-episode')
        (root/'fixture-targets.json').write_text(json.dumps(targets,ensure_ascii=False,indent=2)+'\n')
    finally:store.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination',type=Path)
    create(parser.parse_args().destination)
