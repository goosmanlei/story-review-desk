"""Transport checks for the same production operations used by the browser."""
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import wave
from review_desk.server import ReviewServer


class ProductionApiTest(unittest.TestCase):
    def test_file_range_batch_conflict_exact_source_and_time_comment(self):
        with tempfile.TemporaryDirectory() as root, ReviewServer(('127.0.0.1',0),root,{'id':'test','title':'test'}) as server:
            ep=server.store.put_object('episode','EPISODE',{'title':'依据','blocks':[{'id':'a','text':'说一句话。'}],
                                                        'scenes':[{'id':'s1','block_ids':['a']}]})
            stream=io.BytesIO()
            with wave.open(stream,'wb') as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(48000);wav.writeframes(b'\0\0'*48000)
            raw=stream.getvalue();result={}
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            base=f'http://127.0.0.1:{server.server_port}'

            def request(path,data=None,method=None,headers=None):
                req=urllib.request.Request(base+path,data=data,method=method,headers=headers or {})
                with opener.open(req,timeout=5) as response:
                    return response.status,response.read(),response.headers

            def client():
                try:
                    status,body,_=request('/api/production/files/voice.wav',raw,'PUT')
                    result['upload_status']=status;component=json.loads(body)
                    def item(oid,kind,**values):
                        return {'object_id':oid,'kind':kind,'expected_version':0,'payload':{
                            'format':'production-'+kind.lower()+'-v1','title':oid,'blocks':[{'id':'note','text':'接口测试'}],**values}}
                    records=[item('call','CALL',method='recording',tool='test fixture',status='submitted',inputs=[],outputs=[]),
                             item('voice','ASSET',media_type='audio',subjects=[],states=[],lineage={},components=[component],
                                  production={'object_id':'call','revision_id':'@call'})]
                    batch=json.dumps({'format':'production-import-v1','records':records}).encode()
                    status,body,_=request('/api/production/import',batch,'POST')
                    result['import_status']=status;revision=json.loads(body)['records'][1]['revision']
                    status,body,headers=request('/api/production/files/'+component['file'],headers={'Range':'bytes=0-43'})
                    result['range']=(status,body,headers['Content-Range'])
                    source_query=urllib.parse.urlencode({'object_id':'episode','revision_id':ep['revision'],'scene_id':'s1','block_ids':'a'})
                    _,body,_=request('/api/production/source?'+source_query);result['source']=json.loads(body)
                    comment={'target_object_id':'voice','target_revision_id':revision,'anchor':{'type':'time',
                        'component_id':'original','asset_file':component['file'],'start_seconds':0.1,'end_seconds':0.8},'body':'时间段技术检查'}
                    _,body,_=request('/api/comments',json.dumps(comment).encode(),'POST');result['comment']=json.loads(body)
                    try:request('/api/production/import',batch,'POST')
                    except urllib.error.HTTPError as exc:result['conflict']=exc.code
                    _,body,_=request('/api/production?object_id=voice');result['asset']=json.loads(body)
                    _,body,_=request('/api/production/readiness?scope=voice');result['ready']=json.loads(body)
                except Exception as exc:
                    result['error']=repr(exc)

            thread=threading.Thread(target=client,daemon=True);thread.start();server.timeout=3
            for _ in range(8):server.handle_request()
            thread.join(timeout=6)
            self.assertFalse(thread.is_alive());self.assertNotIn('error',result)
            self.assertEqual(result['upload_status'],201);self.assertEqual(result['import_status'],201)
            self.assertEqual(result['range'],(206,raw[:44],f'bytes 0-43/{len(raw)}'))
            self.assertEqual(result['source']['blocks'],[{'id':'a','text':'说一句话。'}])
            self.assertEqual(result['comment']['anchor']['end_seconds'],0.8)
            self.assertEqual(result['conflict'],409);self.assertEqual(len(result['asset']['history']),1)
            self.assertFalse(result['ready']['inputs_ready'])


if __name__=='__main__':unittest.main()
