import copy
import tempfile
import unittest
from pathlib import Path
from review_desk import methods
from review_desk.method_document import project
from review_desk.store import Store, Conflict
from test_methods import seed


class ReadingTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'db.sqlite3');self.addCleanup(self.store.close)
        self.resource,self.method,self.binding=seed(self.store,'media-plan')

    def request(self):
        files=copy.deepcopy(self.method['payload']['files']);files['SKILL.md']+='\n\n核对触发事实、持物与交接。'
        return {'object_id':self.method['object_id'],'base_revision':self.method['revision_id'],'changes':{'files':files},'scopes':[]}

    def test_only_save_and_exact_retry_preserve_old_execution_and_conditions(self):
        execution=methods.prepare(self.store,{'work_type':'media-plan','run_id':'r','step_id':'s','target':'x','inputs':{'context':'source'}})
        p=copy.deepcopy(self.binding['payload']);p['rules'] += [{**methods.reference(self.method),'when':{'media_type':'image','typed':[False,9223372036854775809,{'n':None}]}},{**methods.reference(self.method),'when':{'media_type':'audio'}},{**methods.reference(self.method),'when':{'media_type':'video'}}]
        b=methods.save(self.store,{'category':'binding','name':'media-plan','expected_version':1,'payload':p})
        req=self.request();result=methods.edit(self.store,req)
        self.assertEqual(methods.read(self.store,b['object_id']),b)
        req['scopes']=[{**methods.reference(b),'index':3}]
        applied=methods.edit(self.store,req)
        current=methods.read(self.store,b['object_id'])
        self.assertEqual(current['payload']['rules'][:3],p['rules'][:3])
        self.assertEqual(methods.edit(self.store,req),applied)
        self.assertEqual(methods.read(self.store,self.method['object_id'])['version'],2)
        self.assertEqual(methods.prepare(self.store,{'work_type':'media-plan','run_id':'r','step_id':'s','target':'x','inputs':{'context':'source'}}),execution)

    def test_explicit_existing_branch_can_choose_another_applicable_method(self):
        other=methods.save(self.store,{'category':'skill','name':'alternative','expected_version':0,'payload':self.method['payload']})
        p=copy.deepcopy(self.binding['payload']);p['rules'] += [{**methods.reference(other),'when':{'media_type':'image'}}]
        b=methods.save(self.store,{'category':'binding','name':'media-plan','expected_version':1,'payload':p})
        req=self.request();req['scopes']=[{**methods.reference(b),'index':1}]
        result=methods.edit(self.store,req);self.assertFalse(result['unapplied'])
        rules=methods.read(self.store,b['object_id'])['payload']['rules']
        self.assertEqual(rules[0],p['rules'][0]);self.assertEqual(rules[1],{**methods.reference(result['saved']),'when':{'media_type':'image'}})

    def test_partial_conflict_and_retry_never_copy_method(self):
        p=copy.deepcopy(self.method['payload']);p['work_types']+=['audiovisual-design'];m=methods.save(self.store,{'category':'skill','name':'review','expected_version':1,'payload':p})
        b2=methods.save(self.store,{'category':'binding','name':'audiovisual-design','expected_version':0,'payload':{'work_type':'audiovisual-design','rules':[{**methods.reference(m),'when':{}}]}})
        req={'object_id':m['object_id'],'base_revision':m['revision_id'],'changes':{'files':{**m['payload']['files'],'SKILL.md':m['payload']['files']['SKILL.md']+'\n新条款。'}},'scopes':[{**methods.reference(self.binding),'index':0},{**methods.reference(b2),'index':0}]}
        changed=methods.save(self.store,{'category':'binding','name':'audiovisual-design','expected_version':1,'payload':{**b2['payload'],'note':'concurrent'}})
        result=methods.edit(self.store,req);self.assertEqual((len(result['applied']),len(result['unapplied'])),(1,1))
        req['saved_revision']=result['saved']['revision_id'];req['scopes'][1]['revision_id']=changed['revision_id']
        final=methods.edit(self.store,req);self.assertFalse(final['unapplied']);self.assertEqual(methods.read(self.store,m['object_id'])['version'],3)
        self.assertEqual(methods.edit(self.store,req),final)
        other=copy.deepcopy(final['saved']['payload']);other['purpose']='different';methods.save(self.store,{'category':'skill','name':'review','expected_version':3,'payload':other})
        with self.assertRaises(Conflict):methods.edit(self.store,{k:v for k,v in req.items() if k!='saved_revision'})

    def test_file_anchors_cross_paragraph_comment_restore_and_no_cross_file(self):
        p=copy.deepcopy(self.method['payload']);p['files']['SKILL.md']+='\n\n# 目的\n\n先看**触发事实**。\n\n再核对[持物与交接](references/check.md)。\n';p['files']['references/check.md']='不能混入另一文件。'
        m=methods.save(self.store,{'category':'skill','name':'review','expected_version':1,'payload':p})
        blocks=project(p,'SKILL.md');first,last=blocks[-2:];quote=first['text']+'\n'+last['text'];a={'file':'SKILL.md','block_id':first['id'],'end_block_id':last['id'],'start':0,'end':len(last['text']),'quote':quote}
        c=self.store.create_comment({'id':'method-test-comment','target_object_id':m['object_id'],'target_revision_id':m['revision_id'],'anchor':a,'body':'核对动机'})
        self.assertEqual(self.store.validate_target(m['object_id'],m['revision_id'],a)['blocks'][-1]['file'],'references/check.md')
        with self.assertRaises(ValueError):self.store.validate_target(m['object_id'],m['revision_id'],{**a,'file':'references/check.md'})
        wrong=project(p)[-1]
        with self.assertRaises(ValueError):self.store.validate_target(m['object_id'],m['revision_id'],{**a,'end_block_id':wrong['id'],'end':len(wrong['text']),'quote':quote+'\n'+wrong['text']})
        from review_desk.comment_review import content
        self.assertEqual(content(self.store,m['object_id'],m['revision_id'])['record']['review_blocks'],project(p))

    def test_response_is_idempotent_and_public_restore_keeps_original_file_anchor(self):
        from review_desk.bundle import export, restore
        blocks=project(self.method['payload'],'SKILL.md');b=blocks[-1]
        c=self.store.create_comment({'id':'method-original','target_object_id':self.method['object_id'],'target_revision_id':self.method['revision_id'],'anchor':{'file':'SKILL.md','block_id':b['id'],'end_block_id':b['id'],'start':0,'end':len(b['text']),'quote':b['text']},'body':'Clarify triggers'})
        new=methods.edit(self.store,self.request())['saved']
        request={'comment_id':c['id'],'revision_id':new['revision_id'],'explanation':'Added accurate trigger checks'}
        methods.respond(self.store,request);count=self.store.db.execute('SELECT count(*) FROM revisions').fetchone()[0]
        methods.respond(self.store,request);self.assertEqual(self.store.db.execute('SELECT count(*) FROM revisions').fetchone()[0],count)
        folder=Path(self.tmp.name)/'export';export(self.store,folder)
        other=Store(Path(self.tmp.name)/'restored/db.sqlite3');self.addCleanup(other.close);restore(other,folder)
        self.assertEqual(other.comment(c['id'])['anchor'],c['anchor'])
        self.assertEqual(methods.read(other,new['object_id'])['revision_id'],new['revision_id'])

    def test_project_media_is_bound_to_exact_original_and_source_stays_read_only(self):
        root=Path(self.tmp.name);(root/'book').mkdir();(root/'media').mkdir()
        (root/'media/example.png').write_bytes(b'original')
        (root/'book/chapter.md').write_text('![example](../media/example.png)\n')
        spec={'name':'source','title':'Source','expected_version':0,'sections':{'main':{'path':'book/chapter.md'}}}
        old=methods.sync_source(self.store,root,spec)
        meta=old['payload']['media']['references/main.md']['../media/example.png']
        self.assertEqual((meta['path'],meta['bytes']),('media/example.png',8))
        (root/'media/example.png').write_bytes(b'changed')
        new=methods.sync_source(self.store,root,{**spec,'expected_version':1})
        self.assertNotEqual(meta['sha256'],new['payload']['media']['references/main.md']['../media/example.png']['sha256'])
        self.assertEqual(methods.read(self.store,old['object_id'],old['revision_id']),old)
        with self.assertRaisesRegex(ValueError,'项目源'):
            methods.edit(self.store,{'object_id':new['object_id'],'base_revision':new['revision_id'],'changes':{'title':'Forged'},'scopes':[]})


class ReadingHTTPTest(unittest.TestCase):
    def setUp(self):
        from review_desk.server import ReviewServer
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.server=ReviewServer(('127.0.0.1',0),self.root,{'id':'reading','title':'Reading'})
        self.addCleanup(self.server.server_close)
        self.resource,self.method,self.binding=seed(self.server.store,'media-plan')

    def get(self,path,status=200):
        import urllib.request,urllib.error,threading,json
        response={}
        def read():
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:r=opener.open('http://127.0.0.1:%s'%self.server.server_port+path,timeout=5)
            except urllib.error.HTTPError as exc:r=exc
            with r:response.update(status=r.status,body=r.read(),mime=r.headers.get_content_type())
        t=threading.Thread(target=read);t.start();self.server.handle_request();t.join(6)
        self.assertFalse(t.is_alive());self.assertEqual(response['status'],status,response)
        return json.loads(response['body']) if response['mime']=='application/json' else response['body']

    def test_exact_document_and_media_fail_closed_then_recover(self):
        from urllib.parse import urlencode
        method=methods.reference(self.method)
        doc=self.get('/api/methods/document?'+urlencode({**method,'file':'SKILL.md'}))
        self.assertEqual(doc['record']['payload'],self.method['payload'])
        self.get('/api/methods/document?'+urlencode({**method,'file':'missing.md'}),400)
        (self.root/'book').mkdir();(self.root/'media').mkdir()
        original=b'exact-original';media=self.root/'media/image.png';media.write_bytes(original)
        (self.root/'book/main.md').write_text('![original](../media/image.png)')
        r=methods.sync_source(self.server.store,self.root,{'name':'source','title':'Source','expected_version':0,'sections':{'main':{'path':'book/main.md'}}})
        url='/api/methods/media?'+urlencode({**methods.reference(r),'file':'references/main.md','href':'../media/image.png'})
        self.assertEqual(self.get(url),original)
        media.write_bytes(b'changed');self.get(url,400)
        media.unlink();self.get(url,400)
        media.write_bytes(original);self.assertEqual(self.get(url),original)
        self.get('/api/methods/media?'+urlencode({**methods.reference(self.resource),'file':'references/main.md','href':'../media/image.png'}),400)
