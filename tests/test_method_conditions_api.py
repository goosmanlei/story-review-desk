"""HTTP integration checks for both condition editors and frozen deliveries."""
import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

from review_desk.server import ReviewServer


class MethodConditionsApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = ReviewServer(('127.0.0.1', 0), self.tmp.name, {'id': 'conditions', 'title': 'Conditions'})
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.server.server_close)
        self.server.timeout = 3
        self.base = 'http://127.0.0.1:%s' % self.server.server_port
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.resource = self.save('resource', 'book', 0, {
            'title': 'Professional text', 'sections': {'staging': 'book/staging.md'},
            'files': {'book/staging.md': 'Full staging text ![plan](plan.svg)',
                      'book/plan.svg': '<svg/>', 'book/sources.json': '{"source":"original"}'},
            'companions': {'staging': ['book/plan.svg', 'book/sources.json']}})
        self.payload = {'title': 'Design', 'purpose': 'Design a scene', 'applies': 'Exact input',
                        'inputs': 'Context', 'outputs': 'Design', 'checks': 'Read the source',
                        'work_types': ['audiovisual-design', 'media-plan'], 'required_inputs': ['context'],
                        'steps': ['result'], 'files': {'SKILL.md': '---\nname: design\ndescription: Design a scene\n---\nFull method.'},
                        'resources': []}
        self.ref = {k: self.resource[k] for k in ('object_id', 'revision_id')}

    def api(self, path, value=None, status=200):
        result = {}
        def client():
            try:
                request = urllib.request.Request(self.base + path,
                    data=None if value is None else json.dumps(value).encode(),
                    headers={'Content-Type': 'application/json'})
                try:
                    response = self.opener.open(request, timeout=5)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    result.update(status=response.status, body=json.load(response))
            except Exception as exc:
                result['error'] = exc
        thread = threading.Thread(target=client, daemon=True)
        thread.start()
        self.server.handle_request()
        thread.join(6)
        self.assertFalse(thread.is_alive())
        if 'error' in result:
            raise result['error']
        self.assertEqual(result['status'], status, result['body'])
        return result['body']

    def save(self, category, name, version, payload, texts=None, status=201):
        request = dict(category=category, name=name, expected_version=version, payload=payload)
        if texts is not None:
            request['condition_texts'] = texts
        return self.api('/api/methods/save', request, status)

    def resolve(self, conditions, work='audiovisual-design'):
        return self.api('/api/methods/resolve?' + urllib.parse.urlencode(
            {'work_type': work, 'conditions': json.dumps(conditions)}))

    def select(self, method, rules=None, version=0, work='audiovisual-design'):
        ref = {k: method[k] for k in ('object_id', 'revision_id')}
        return self.save('binding', work, version, {'work_type': work, 'rules': rules or [{**ref, 'when': {}}]})

    def test_full_json_values_and_exact_number_text_round_trip_both_editors(self):
        condition = {'true': True, 'false': False, 'literal-true': 'true', 'literal-false': 'false',
                     'number': 9007199254740993, 'float': 1.25, 'null': None,
                     'array': [True, 'x,y=z', None, 2], 'object': {'nested': [False, 3]},
                     '__proto__': 'data', 'text': 'comma, equals=，quotes"'}
        payload = {**self.payload, 'resources': [{**self.ref, 'section': 'staging', 'when': condition}]}
        method = self.save('skill', 'design', 0, payload)
        binding = self.select(method, [{**{k: method[k] for k in ('object_id', 'revision_id')}, 'when': condition}])
        catalog = self.api('/api/methods')
        raw = catalog['condition_texts'][method['revision_id']]
        # Emulate a browser JSON number losing precision, with the exact text
        # supplied by the catalog still used for the saved conditions.
        changed = copy.deepcopy(method['payload']); changed['purpose'] += ' edited'
        changed['resources'][0]['when']['number'] = 9007199254740992
        new = self.save('skill', 'design', 1, changed, raw)
        self.assertEqual(new['payload']['resources'], method['payload']['resources'])
        bound = self.save('binding', 'audiovisual-design', 1, binding['payload'],
                          catalog['condition_texts'][binding['revision_id']])
        self.assertEqual(bound['payload'], binding['payload'])
        selected = self.resolve(condition)
        self.assertEqual(selected['resources'][0]['content'], self.resource['payload']['files']['book/staging.md'])
        self.assertEqual(selected['resources'][0]['files']['book/plan.svg'], '<svg/>')
        changed['resources'][0]['when'] = {}
        edited = self.save('skill', 'design', 2, changed, ['{"need_staging":false,"literal":"false"}'])
        rules = [{**{k: edited[k] for k in ('object_id', 'revision_id')}, 'when': {}}]
        self.save('binding', 'audiovisual-design', 2, {'work_type': 'audiovisual-design', 'rules': rules},
                  ['{"need_staging":false,"literal":"false"}'])
        self.assertEqual(len(self.resolve({'need_staging': False, 'literal': 'false'})['resources']), 1)
        self.api('/api/methods/resolve?' + urllib.parse.urlencode({'work_type': 'audiovisual-design',
                 'conditions': '{"need_staging":"false","literal":"false"}'}), status=400)

    def test_mixed_invalid_inputs_append_nothing_and_leave_bindings_unchanged(self):
        method = self.save('skill', 'design', 0, {**self.payload, 'resources': [
            {**self.ref, 'section': 'staging', 'when': {'need_staging': True}},
            {**self.ref, 'section': 'staging', 'when': {'need_sound': True}}]})
        binding = self.select(method)
        initial = self.api('/api/methods')
        revisions = self.server.store.db.execute('SELECT count(*) FROM revisions').fetchone()[0]
        invalid = ['need_sound=', 'need_sound', 'need_sound=true,', 'need_sound=true,need_sound=false',
                   '{"x":true,"x":false}', '{"nested":{"x":1,"x":2}}', '[true]',
                   '{"x":NaN}', '{"x":1e999}', '{"x":true} trailing', 'x=01']
        for raw in invalid:
            error = self.save('skill', 'design', 1, method['payload'], ['need_staging=true', raw], status=400)
            self.assertIn('第 2 项条件', error['error'])
            rules = binding['payload']['rules'] * 2
            self.save('binding', 'audiovisual-design', 1, {'work_type': 'audiovisual-design', 'rules': rules},
                      ['need_staging=true', raw], status=400)
            self.assertEqual(self.api('/api/methods'), initial)
            self.assertEqual(self.server.store.db.execute('SELECT count(*) FROM revisions').fetchone()[0], revisions)
        self.save('skill', 'design', 1, method['payload'], ['{}'], status=400)
        self.assertEqual(self.api('/api/methods'), initial)

    def test_old_execution_stays_exact_and_media_string_branches_still_select(self):
        method = self.save('skill', 'design', 0, {**self.payload, 'resources': [
            {**self.ref, 'section': 'staging', 'when': {'need_staging': True}}]})
        self.select(method)
        request = {'work_type': 'audiovisual-design', 'run_id': 'roundtrip', 'step_id': 'old',
                   'target': 'exact-scene', 'conditions': {'need_staging': True}, 'inputs': {'context': 'Exact scene'}, 'private': True}
        old = self.api('/api/methods/prepare', request, 201)
        payload = copy.deepcopy(method['payload']); payload['purpose'] += ' edited'
        new = self.save('skill', 'design', 1, payload, ['{"need_staging":true}'])
        self.select(new, version=1)
        self.assertEqual(self.api('/api/methods/prepare', request, 201), old)
        fresh = self.api('/api/methods/prepare', {**request, 'step_id': 'new'}, 201)
        self.assertNotEqual(fresh['payload']['package']['method'], old['payload']['package']['method'])
        self.assertEqual(fresh['payload']['package']['resources'], old['payload']['package']['resources'])
        self.assertEqual(len(self.resolve({'need_staging': 'true'})['resources']), 0)
        rules = []
        for medium in ('image', 'audio', 'video'):
            m = self.save('skill', medium, 0, {**self.payload, 'title': medium})
            rules.append({**{k: m[k] for k in ('object_id', 'revision_id')}, 'when': {'media_type': medium}})
        b = self.select(new, rules, work='media-plan')
        self.save('binding', 'media-plan', 1, b['payload'], ['media_type=image', 'media_type=audio', 'media_type=video'])
        for medium in ('image', 'audio', 'video'):
            self.assertEqual(self.resolve({'media_type': medium}, 'media-plan')['title'], medium)
