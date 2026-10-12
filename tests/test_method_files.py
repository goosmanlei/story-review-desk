import copy
import json
import tempfile
import unittest
from pathlib import Path
from review_desk import methods, method_files as files, comment_review
from review_desk.store import Store
from test_methods import seed


class FileHistoryTest(unittest.TestCase):
    def test_reading_outline_numbers_follow_document_order_not_alphabetical_paths(self):
        ordered, labels = files.reading_order({'payload': {'files': {
            'book/checks.md': '# 检查', 'book/prompt.md': '# 提示词',
            'book/handbook.md': '# 视频手册\n<!-- section:prompt -->\n<!-- section:checks -->',
            'book/extra.md': '# 更多资料'}}})
        self.assertEqual(ordered, ['book/handbook.md', 'book/prompt.md', 'book/checks.md', 'book/extra.md'])
        self.assertEqual(labels['book/prompt.md']['reading_label'], '01 · 提示词')
        self.assertEqual(labels['book/checks.md']['reading_label'], '02 · 检查')
        order, titles = files.reading_order({'payload': {'files': {
            'README.md': '# 影视知识\n[镜头](01-shots.md)\n[剪辑](12-edit.md)',
            '12-edit.md': '# 12 剪辑', '01-shots.md': '# 01 镜头'}}})
        self.assertEqual(order, ['README.md', '01-shots.md', '12-edit.md'])
        self.assertEqual(titles['12-edit.md']['reading_label'], '12 · 剪辑')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root/'.runtime/review.sqlite3'); self.addCleanup(self.store.close)
        self.resource, self.method, self.binding = seed(self.store)

    def save(self, **changes):
        old = methods.read(self.store, self.method['object_id'])
        payload = copy.deepcopy(old['payload']); payload.update(changes)
        return methods.save(self.store, {'category': 'skill', 'name': 'review', 'expected_version': old['version'], 'payload': payload})

    def test_independent_bytes_metadata_repeat_return_and_atomic_conflict(self):
        body = self.method['payload']['files']['SKILL.md']
        second = self.save(files={'SKILL.md': body, 'references/one.md': 'a\r\n'})
        third = self.save(files={'SKILL.md': body, 'references/one.md': 'b\n'})
        fourth = self.save(title='Metadata only')
        fifth = self.save(files={'SKILL.md': body, 'references/one.md': 'a\r\n'})
        self.assertEqual([files.manifest(self.store, r['revision_id'])['SKILL.md']['version'] for r in (second, third, fourth, fifth)], [1]*4)
        self.assertEqual([files.manifest(self.store, r['revision_id'])['references/one.md']['version'] for r in (second, third, fourth, fifth)], [1,2,2,3])
        self.assertEqual(files.compare(self.store, self.method['object_id'], 'references/one.md', 1, 3)['equal'], True)
        self.assertEqual(files.migrate(self.store)['added'], dict.fromkeys(files.TABLES, 0))
        before = files.directory(self.store, self.method['object_id'])
        with self.assertRaises(Exception):
            methods.save(self.store, {'category':'skill','name':'review','expected_version':1,'payload': fifth['payload']})
        self.assertEqual(before, files.directory(self.store, self.method['object_id']))

    def test_legacy_replay_exact_package_and_rename_delete_no_substitution(self):
        a = self.save(files={**self.method['payload']['files'], 'old.md':'原文\n'})
        b = self.save(files={**self.method['payload']['files'], 'new.md':'原文\n'})
        with self.store.db:
            for table in reversed(files.TABLES): self.store.db.execute('DROP TABLE '+table)
        files.migrate(self.store)
        self.assertEqual(files.document(self.store,a['object_id'],'old.md',revision_id=a['revision_id'])['content'],'原文\n')
        with self.assertRaisesRegex(ValueError,'没有该文件'):
            files.document(self.store,b['object_id'],'old.md',revision_id=b['revision_id'])
        self.assertFalse(files.document(self.store,a['object_id'],'old.md')['present'])
        self.assertNotEqual(files.file_id(a['object_id'],'old.md'), files.file_id(a['object_id'],'new.md'))
        with self.assertRaisesRegex(ValueError,'不匹配'):
            files.document(self.store,b['object_id'],'new.md',revision_id=b['revision_id'],version=2)
        self.store.db.execute('DELETE FROM method_file_members WHERE package_revision=?',(a['revision_id'],))
        with self.assertRaisesRegex(ValueError,'映射不符'): files.validate(self.store)

    def test_full_context_chinese_code_crlf_and_single_line_diffs(self):
        oid = self.method['object_id']; body=self.method['payload']['files']['SKILL.md']
        a='中文\n```py\nx=1\n```\n[原链接](a.md)\n'
        b='中文\n```py\nx=2\n```\n[原链接](a.md)\n'
        self.save(files={'SKILL.md':body,'sample.md':a})
        self.save(files={'SKILL.md':body,'sample.md':b})
        result=files.compare(self.store,oid,'sample.md',1,2)
        self.assertEqual(''.join(line for row in result['changes'] for line in row['left']),a)
        self.assertEqual(''.join(line for row in result['changes'] for line in row['right']),b)
        self.assertEqual([row['type'] for row in result['changes']],['equal','replace','equal'])
        self.assertTrue(files.compare(self.store,oid,'sample.md',2,2)['equal'])
        self.save(files={'SKILL.md':body,'sample.md':b.replace('\n','\r\n')})
        self.assertFalse(files.compare(self.store,oid,'sample.md',2,3)['equal'])

    def test_frozen_execution_and_registry_restore_keep_original_exact_files(self):
        request={'work_type':'comment-polish','run_id':'file-history','step_id':'one','target':'text@1','inputs':{'context':'中文'}}
        old=methods.prepare(self.store,request)
        original=copy.deepcopy(old)
        new=self.save(files={**self.method['payload']['files'],'template.json':'{"one":1}\n'})
        methods.save(self.store,{'category':'binding','name':'comment-polish','expected_version':1,'payload':{'work_type':'comment-polish','rules':[{**methods.reference(new),'when':{}}]}})
        self.assertEqual(methods.prepare(self.store,request),original)
        fresh=methods.prepare(self.store,{**request,'step_id':'two'})
        self.assertEqual(set(fresh['payload']['file_manifest']['method']),{'SKILL.md','template.json'})
        other=Store(self.root/'empty/.runtime/review.sqlite3');self.addCleanup(other.close)
        methods.restore_registry(other,methods.export_registry(self.store,executions=[old['object_id'],fresh['object_id']]))
        self.assertEqual(methods.prepare(other,request),original)
        self.assertEqual(files.directory(other,new['object_id']),files.directory(self.store,new['object_id']))
        methods.export_execution(other,methods.reference(fresh),self.root/'delivered')
        self.assertEqual(json.loads((self.root/'delivered/file-manifest.json').read_text()),fresh['payload']['file_manifest'])

    def test_source_raw_bytes_and_svg_versions_and_original_comment_label(self):
        (self.root/'book').mkdir(); original=b'# text\r\n![svg](image.svg)\r\n'
        (self.root/'book/read.md').write_bytes(original)
        (self.root/'book/image.svg').write_text('<svg><text>A</text></svg>')
        spec={'name':'source','title':'Source','expected_version':0,'preserve_paths':True,'sections':{'main':{'path':'book/read.md'}},'companions':{'main':['book/image.svg']}}
        old=methods.sync_source(self.store,self.root,spec)
        (self.root/'book/image.svg').write_text('<svg><text>B</text></svg>')
        new=methods.sync_source(self.store,self.root,{**spec,'expected_version':1})
        self.assertEqual(files.document(self.store,new['object_id'],'book/read.md')['content'].encode(),original)
        comparison=files.compare(self.store,new['object_id'],'book/image.svg',1,2)
        self.assertEqual(comparison['left']['content'],'<svg><text>A</text></svg>')
        self.assertEqual(comparison['right']['content'],'<svg><text>B</text></svg>')
        self.assertEqual(comparison['changes'],[])
        label=comment_review.reference(self.store,{**methods.reference(old),'file':'book/read.md'})
        self.assertEqual(label['file_version'],1)
        self.assertEqual(comment_review.reference(self.store,{**methods.reference(new),'file':'book/read.md'})['file_revision'],label['file_revision'])
