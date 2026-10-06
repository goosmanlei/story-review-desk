import copy
import shutil
import unittest
import test_production_breakdown as fixtures
from review_desk import production as p, business_codes as codes
from review_desk.bundle import export, restore
from review_desk.store import Store
from test_structure import direction


class GlobalCodesTest(unittest.TestCase):
    for name in ('setUp', 'tearDown', 'spec', 'put', 'ref', 'scene_shot'):
        locals()[name] = getattr(fixtures.BreakdownTest, name)

    def test_repeated_local_numbers_and_reordering_keep_distinct_exact_identities(self):
        self.scene_shot()
        first_episode = p.record(self.store, 'episode')
        self.store.put_object('episode-other', 'EPISODE', copy.deepcopy(first_episode['payload']))
        scene = copy.deepcopy(p.record(self.store, 'scene')['payload'])
        scene['source'].update(self.ref('episode-other'))
        self.put({'object_id':'scene-other', 'kind':'PREPARATION', 'expected_version':0, 'payload':scene})
        shot = copy.deepcopy(p.record(self.store, 'shot')['payload'])
        shot.update(episode=self.ref('episode-other'), parent=self.ref('scene-other'), source=scene['source'])
        self.put({'object_id':'shot-other', 'kind':'SHOT_DESIGN', 'expected_version':0, 'payload':shot})
        original = codes.dump(self.store)
        view = {r['object_id']:r['display_code'] for r in codes.display_dump(self.store)}
        for a, b in [('episode','episode-other'), ('scene','scene-other'), ('shot','shot-other')]:
            self.assertNotEqual(view[a], view[b])
        self.assertEqual(view['scene'], view[codes.scene_identity('episode','scene')])
        old = p.record(self.store,'shot')
        self.put({'object_id':'shot','kind':'SHOT_DESIGN','expected_version':old['version'],
                  'payload':{**old['payload'],'number':88}})
        self.assertEqual(codes.dump(self.store), original)
        self.assertEqual(codes.annotate(self.store, old)['business_code'], view['shot'])
        revised = {**first_episode['payload'], 'scenes':[]}
        self.store.put_object('episode','EPISODE',revised,expected_version=first_episode['version'])
        historical = codes.annotate(self.store,first_episode)
        self.assertEqual(historical['payload']['scenes'][0]['business_code'],view['scene'])
        export(self.store,self.root/'export')
        dest=self.root/'recovered';shutil.copytree(self.root/'export',dest/'export')
        recovered=Store(dest/'.runtime/review.sqlite3');self.addCleanup(recovered.close)
        restore(recovered,dest/'export')
        self.assertEqual(codes.dump(recovered),original)
        self.assertEqual(codes.annotate(recovered,first_episode),historical)

    def test_removed_prefixes_remain_hidden_tombstones_and_vc_stay_local(self):
        for oid, kind in [('source','SOURCE'), ('story','STORY')]:
            self.store.put_source(direction(oid,'没有简写编号')) if kind == 'SOURCE' else self.store.put_object(oid,kind,{'title':'没有简写编号','blocks':[]})
            self.assertNotIn(oid,{r['object_id'] for r in codes.dump(self.store)})
        with self.store.db:
            self.store.db.execute("INSERT INTO business_codes VALUES ('source','D',7)")
            self.store.db.execute("INSERT INTO business_codes VALUES ('story','B',8)")
        codes.initialize(self.store)
        for oid in ('source','story'):
            self.assertNotIn('business_code',codes.annotate(self.store,p.record(self.store,oid)))
        self.assertFalse({'source','story'} & {r['object_id'] for r in codes.display_dump(self.store)})
        types = {v['prefix']:v for v in codes.catalog()['types']}
        self.assertNotIn('D',types);self.assertNotIn('B',types)
        self.assertIn('同一准确素材身份内',types['MV']['scope'])
        self.assertIn('同一素材版本内',types['MC']['scope'])
