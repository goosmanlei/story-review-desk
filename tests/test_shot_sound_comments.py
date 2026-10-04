"""Exact shot sound anchors are a read-only projection, not a revision rewrite."""
import copy
import json
from pathlib import Path
import subprocess
import unittest
import test_production as fixtures
from review_desk import production as p
from review_desk.review_text import production_text_blocks
from review_desk.store import Conflict


def sound_payload():
    return {'format': 'production-shot-design-v1', 'blocks': [{'id': '@review/original', 'text': '原文'}],
            'purpose': '叙事目的', 'sound': [{'type': 'source_action', 'text': '保持隐藏'},
            {'text': '唱🧵两句', 'description': '被正文取代的说明'}, {'description': '远处铃声'}, '风声', {'text': '唱🧵两句'}]}


class ShotSoundCommentsTest(unittest.TestCase):
    def test_python_and_browser_projections_match_without_reindexing_or_rewriting(self):
        payload = sound_payload()
        before = copy.deepcopy(payload)
        source = Path(__file__).parents[1] / 'review_desk/static/production.js'
        script = "const fs=require('fs'),vm=require('vm');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);process.stdout.write(JSON.stringify(c.productionTextBlocks({payload:JSON.parse(fs.readFileSync(0,'utf8'))})));"
        result = subprocess.run(['node', '-e', script, str(source)], input=json.dumps(payload), capture_output=True, text=True, check=True)
        projected = production_text_blocks(payload)
        self.assertEqual(json.loads(result.stdout), projected)
        sounds = [b for b in projected if b.get('field', '').startswith('sound.')]
        self.assertEqual([b['id'] for b in sounds], ['@@review/sound/1/text', '@@review/sound/2/description', '@@review/sound/3/text', '@@review/sound/4/text'])
        self.assertEqual([b['text'] for b in sounds], ['唱🧵两句', '远处铃声', '风声', '唱🧵两句'])
        self.assertEqual(payload, before)

    def test_sound_comment_validates_exact_unicode_quote_and_remains_on_old_revision(self):
        f = fixtures.ProductionTest()
        f.setUp()
        self.addCleanup(f.tearDown)
        record = f.spec('shot', 'SHOT_DESIGN', episode=f.ref('episode'), source=f.source, scene_id='scene',
                        number=1, purpose='叙事目的', framing='全景', spatial='门外', action_start='静止', action_end='静止',
                        continuity='独立', duration_frames=24, fps=24, sound=sound_payload()['sound'], entities=[], states=[])
        record['payload']['blocks'] = sound_payload()['blocks']
        f.put(record)
        old = p.record(f.store, 'shot')
        before = f.store.revisions()
        anchor = {'type': 'text', 'block_id': '@@review/sound/1/text', 'end_block_id': '@@review/sound/2/description',
                  'start': 1, 'end': 2, 'quote': '🧵两句\n远处'}
        comment = f.store.create_comment({'target_object_id': 'shot', 'target_revision_id': old['id'], 'anchor': anchor, 'body': '仅测试：核对两处声音衔接'})
        self.assertEqual(f.store.revisions(), before)
        self.assertEqual(f.store.comment(comment['id'])['anchor'], anchor)
        with self.assertRaises(Conflict):
            f.store.validate_target('shot', old['id'], {**anchor, 'quote': '错引'})
        changed = copy.deepcopy(old['payload'])
        changed['sound'][1]['text'] = '新的声音安排'
        f.put({'object_id': 'shot', 'kind': 'SHOT_DESIGN', 'expected_version': old['version'], 'payload': changed})
        self.assertTrue(f.store.anchor_state('shot', old['id'], anchor)['valid'])
        self.assertFalse(f.store.anchor_state('shot', f.ref('shot')['revision_id'], anchor)['valid'])
        self.assertEqual(p.record(f.store, revision_id=old['id'])['payload'], old['payload'])


if __name__ == '__main__':
    unittest.main()
