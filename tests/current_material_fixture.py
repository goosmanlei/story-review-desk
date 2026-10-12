"""Current-plan candidates created through the real submission boundary."""
from review_desk import production as p, generation as g, production_current as current, production_operations as operations
from test_generation import GenerationTest


class MaterialFixture:
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','media','change','setup_plans'):
        locals()[name] = getattr(GenerationTest, name)

    def generate(self, name='call1', asset='generated'):
        need = p.record(self.store, 'need-full-overall')
        package = g.package(self.store, need['object_id'])
        operations.submit(self.store, {'id':'submit-'+name, 'call_id':name, 'requirement_id':need['object_id'],
                           'expected_content':current.marker(need),'package_sha256':current.checksum(package),'tool':'test'})
        if not self.store.db.execute("SELECT 1 FROM objects WHERE id='voice'").fetchone(): self.media()
        component = p.record(self.store,'voice')['payload']['components'][0]
        record = self.spec(asset,'ASSET',media_type='audio',subjects=[self.ref('songbook')],states=[self.ref('full')],
                           components=[component],production=self.ref(name),lineage={},candidate_requirements=[self.ref(need['object_id'])],
                           state_coverage=[{'state':self.ref('full'),'role':'overall','component_id':'original','detail':'isolated original'}])
        old = self.store.db.execute('SELECT version FROM objects WHERE id=?',(asset,)).fetchone()
        record['expected_version'] = old[0] if old else 0
        self.put(record)
        self.change(name,status='completed',outputs=[self.ref(asset)])
