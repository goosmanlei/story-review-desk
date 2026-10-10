"""Approval removal preserves original feedback and frozen execution facts."""
import copy
import json
import shutil
import unittest

import test_generation as fixture
from review_desk import production as p, generation as g, review_retirement as retirement
from review_desk import version_consolidation as vc, comment_review, bundle
from review_desk.store import Store, Conflict, canonical, digest, now


class RetirementTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','media','change','setup_plans'):
        locals()[name] = getattr(fixture.GenerationTest,name)

    def old(self, oid, kind, payload):
        # Explicit legacy storage fixture; public APIs must reject these kinds.
        rid=vc.row_hash(oid,1,payload);at='2026-01-02T03:04:05+00:00'
        self.store.db.execute('INSERT INTO objects VALUES (?,?,?,?,?,?)',(oid,kind,rid,1,at,at))
        self.store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)',(rid,oid,1,canonical(payload),at))
        self.store.db.executemany('INSERT INTO dependencies VALUES (?,?,?)',[(rid,r['revision_id'],path) for path,r in p.references(payload)])
        self.store.db.commit()
        return {'object_id':oid,'revision_id':rid}

    def prepared(self):
        self.setup_plans();self.media()
        original=self.store.create_comment({'target_object_id':'voice','target_revision_id':self.ref('voice')['revision_id'],
            'anchor':{'type':'time','component_id':'original','asset_file':p.record(self.store,'voice')['payload']['components'][0]['file'],
                      'start_seconds':.1,'end_seconds':.8},'body':'已有准确录音意见'})
        a=self.old('old-user','JUDGMENT',{'target':self.ref('voice'),'reason':'1. 认可\n2. 不补'})
        b=self.old('old-copy','JUDGMENT',{'target':self.ref('voice'),'reason':original['body']})
        c=self.old('old-wrapper','REPRESENTATION',{'entities':[self.ref('songbook')],'blocks':[]})
        manifest=g.package(self.store,'need-full-overall')
        call=self.spec('real-old','CALL',method='generation',status='submitted',tool='test',inputs=[],outputs=[],
            generation_requirement=manifest['requirement'],generation_acceptances=[a,b],
            **{k:manifest[k] for k in ('model','parameters','prompt')})
        self.call=self.old('real-old','CALL',call['payload'])
        source={'author':'user','occurred_at':'2026-01-02T03:04:05+00:00','statement_kind':'verbatim','scope':'仅此母版，不代表派生或镜头效果。'}
        dispositions={a['revision_id']:{'action':'import','reason':'独有原话','comment_id':'history-user','body':'1. 认可\n2. 不补',
            'source':source,'target':self.ref('voice'),'anchor':{'type':'global'}},
            b['revision_id']:{'action':'reuse','reason':'已有原话','comment_id':original['id'],'expected_comment':{'body':original['body'],'anchor':original['anchor']},'source':source},
            c['revision_id']:{'action':'delete','reason':'空包装，无独有内容'}}
        return retirement.plan(self.store,dispositions),original,a

    def test_atomic_idempotent_history_and_full_restore_without_resurrection(self):
        plan,original,old=self.prepared()
        before=list(self.store.db.iterdump());call=p.record(self.store,revision_id=self.call['revision_id'])['payload']
        with self.assertRaises(RuntimeError):retirement.apply(self.store,plan,fault='before_commit')
        self.assertEqual(list(self.store.db.iterdump()),before)
        result=retirement.apply(self.store,plan)
        self.assertEqual((result['deleted_objects'],result['deleted_revisions'],result['imported_comments'],result['reused_comments']),(3,3,1,1))
        for key in ('body','anchor','status','version','created_at','updated_at'):
            self.assertEqual(self.store.comment(original['id'])[key],original[key])
        imported=self.store.comment('history-user')
        self.assertEqual(imported['created_at'],'2026-01-02T03:04:05+00:00')
        self.assertEqual(imported['history_sources'][0]['author'],'user')
        self.assertEqual(p.record(self.store,revision_id=self.call['revision_id'])['payload'],call)
        count=len(self.store.events());self.assertTrue(retirement.apply(self.store,plan)['already_applied'])
        self.assertEqual(len(self.store.events()),count)
        missing=p.snapshot(self.store,object_id=old['object_id'],revision_id=old['revision_id'])
        self.assertTrue(missing['record']['retired_review']);self.assertEqual(missing['comments'][0]['id'],'history-user')
        with self.assertRaises(ValueError):p.record(self.store,'wrong',old['revision_id'])
        for kind in retirement.KINDS:
            with self.assertRaises(ValueError):self.store.put_object('resurrection',kind,{'title':'old'})
        # Lifecycle updates keep the frozen inputs, including explainable old
        # approval references. A new call cannot borrow them.
        self.change('real-old',status='failed')
        with self.assertRaises(Conflict):self.change('real-old',prompt='changed input')
        with self.assertRaises((Conflict,ValueError)):self.put({**self.spec('new-call','CALL',**call)})
        self.assertTrue(g.readiness(self.store,'need-full-overall')['ready'])
        bundle.export(self.store,self.root/'export')
        target=self.root/'restored';shutil.copytree(self.root/'export',target/'export')
        restored=Store(target/'.runtime/review.sqlite3')
        try:
            bundle.restore(restored,target/'export')
            self.assertEqual(retirement.inventory(restored),[])
            self.assertEqual(restored.comment('history-user'),imported)
            self.assertEqual(p.record(restored,revision_id=self.call['revision_id'])['payload'],call)
        finally:restored.close()

    def test_plan_inventory_and_source_hash_are_checked_before_any_write(self):
        plan,_,_=self.prepared();before=self.store.comments()
        wrong=copy.deepcopy(plan);wrong['dispositions'][next(iter(wrong['dispositions']))]['reason']='edited'
        with self.assertRaises(ValueError):retirement.apply(self.store,wrong)
        self.old('unexpected','JUDGMENT',{'reason':'new historical record'})
        with self.assertRaises(Conflict):retirement.apply(self.store,plan)
        self.assertEqual(self.store.comments(),before)

    def test_production_response_opens_exact_changed_text_and_original_anchor(self):
        self.setup_plans();row=p.record(self.store,'need-full-overall')
        comment=self.store.create_comment({'target_object_id':row['object_id'],'target_revision_id':row['id'],
            'anchor':{'type':'global'},'body':'测试：说明增加单位'})
        self.change(row['object_id'],purpose='每个完整状态的整体参考')
        changed=self.ref(row['object_id'])
        item={'format':comment_review.FORMAT,'id':'comment-handling-production-test','comment_id':comment['id'],
            'original':{'object_id':row['object_id'],'revision_id':row['id'],'anchor_sha256':digest(canonical(comment['anchor']).encode())},
            'response':changed,'decision':'已修订','explanation':'只补充方案用途说明。',
            'provenance':{'file':'test-response.json','sha256':'a'*64},'evidence':[{**changed,'anchor':{'type':'global'},'label':'准确改后用途'}]}
        comment_review.import_evidence(self.store,[item])
        view=comment_review.snapshot(self.store,row['object_id'],row['id'])
        self.assertEqual(view['reviews'][0]['responses'][0]['response']['revision_id'],changed['revision_id'])
        content=comment_review.content(self.store,**{'object_id':row['object_id'],'revision_id':changed['revision_id']})
        self.assertTrue(content['record']['review_blocks'])
        self.assertEqual(self.store.comment(comment['id'])['target_revision_id'],row['id'])
        with self.assertRaises(ValueError):comment_review.content(self.store,'songbook',changed['revision_id'])


if __name__=='__main__':unittest.main()
