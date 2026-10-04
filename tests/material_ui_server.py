"""Real browser fixture with no production writes or paid generation.

PYTHONPATH=.:tests python3 tests/material_ui_server.py --port 39105
"""
import argparse
import io
import shutil
import struct
import zlib
from pathlib import Path
from test_generation import GenerationTest
from review_desk import production as p
from review_desk.production_media import ingest
from review_desk.server import ReviewServer, ReviewHandler
from review_desk.review_text import production_text_blocks


def png(width,height):
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    pixels=b''.join(b'\0'+b''.join(bytes((220 if x<width//2 else 60,80 if y<height//2 else 180,120)) for x in range(width)) for y in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=39105);parser.add_argument('--source-audio',type=Path);parser.add_argument('--waveform-failure',action='store_true');args=parser.parse_args()
    f=GenerationTest();f.setUp();f.setup_plans();f.media();f.associate()
    def change(oid,**fields):f.change(oid,**fields)
    def comment(row,anchor,body,closed=False,revision=None):
        c=f.store.create_comment({'target_object_id':row['object_id'],'target_revision_id':row['id'],'anchor':anchor,'body':body,**({'material_revision':revision} if revision else {})})
        if closed:f.store.change_comment(c['id'],'CLOSE',1)
        return c
    def txt(row,field):
        b=next(v for v in production_text_blocks(row['payload']) if v.get('field')==field)
        return {'type':'text','block_id':b['id'],'end_block_id':b['id'],'start':0,'end':len(b['text']),'quote':b['text']}
    for name,width,height in [('wide',480,240),('portrait',240,480),('square',360,360)]:
        need=f.need(slot=name);need['payload'].update(media_type='image',generation={'format':'generation-plan-v1','method':'generate','model':'gpt-image-2-5-sunburst','parameters':{},'prompt':'完整测试图片','inputs':[], 'output':{'name':name+'图像','description':'四角颜色用于确认完整图幅','review_criteria':['四角可见']},'blockers':[]});f.put(need)
        component=ingest(f.root,io.BytesIO(png(width,height)),name+'.png');component.update(id='original',role='original')
        f.put(f.spec('draw-'+name,'CALL',method='manual',tool='fixture',status='submitted',inputs=[],outputs=[],model='gpt-image-2-5-sunburst',prompt='四角颜色测试',parameters={},lineage={'i2i_depth':0,'references':[]}))
        f.put(f.spec('image-'+name,'ASSET',media_type='image',subjects=[f.ref('songbook')],states=[f.ref('full')],components=[component],candidate_requirements=[f.ref(need['object_id'])],production=f.ref('draw-'+name),placeholder=False,lineage={'i2i_depth':0,'references':[]},state_coverage=[{'state':f.ref('full'),'component_id':'original','role':'detail','detail':'隔离图幅测试'}]))
        row=p.record(f.store,'image-'+name);whole={'type':'visual','visual_id':'original','asset_file':component['file']}
        comment(row,whole,name+'整图已关闭',True)
        comment(row,{'type':'region','visual_id':'original','asset_file':component['file'],'points':[{'x':.1,'y':.1},{'x':.4,'y':.1},{'x':.4,'y':.4},{'x':.1,'y':.4}]},name+'区域意见')
    voice=p.record(f.store,'voice');component=voice['payload']['components'][0]
    comment(voice,{'type':'time','component_id':'original','asset_file':component['file'],'start_seconds':.1,'end_seconds':.4},'音频选段意见')
    comment(voice,{'type':'time','component_id':'original','asset_file':component['file'],'start_seconds':.5,'end_seconds':.8},'音频已关闭意见',True)
    # Plan references cover mixed types, exact crop/range, and nested dialogs.
    for name,media,model,inputs,prompt in [
        ('multi','image','gpt-image-2-5-sunburst',[{'reference':f.ref('image-wide'),'component_id':'original','use':'人物'}, {'reference':f.ref('image-portrait'),'component_id':'original','use':'环境','crop':{'x':.1,'y':.1,'width':.7,'height':.6}}],'图片1人物，图片2背景'),
        ('mixed','video','Seedance 2.0',[{'reference':f.ref('image-wide'),'component_id':'original','use':'人物'}, {'reference':f.ref('voice'),'component_id':'original','use':'音色','range':{'start_seconds':.1,'end_seconds':.8}}, {'reference':f.ref('image-square'),'component_id':'original','use':'场景'}],'@图片1人物，@音频1音色，@图片2场景'),
        ('nested','image','gpt-image-2-5-sunburst',[{'requirement':'need-full-multi','use':'未来采用的准确结果'}],'图片1整体构图')]:
        inputs=[{**v,'reference':f.ref(v.pop('requirement'))} if 'requirement' in v else v for v in inputs]
        need=f.need(slot=name);need['payload'].update(media_type=media,generation={'format':'generation-plan-v1','method':'generate','model':model,'parameters':{},'prompt':prompt,'inputs':inputs,'output':{'name':name+'方案','description':'隔离参考输入','review_criteria':['准确输入顺序']},'blockers':[]});f.put(need)
    need=p.record(f.store,'need-full-overall');comment(need,txt(need,'generation.model'),'旧模型定位评论',True)
    comment(need,txt(need,'generation.prompt'),'方案提示词意见');comment(need,{'type':'global'},'方案整块意见',True)
    # Changed executed schemes have independent versions; comments do not version.
    need=p.record(f.store,'need-full-wide');old=p.record(f.store,'image-wide')
    comment(old,{'type':'visual','visual_id':'original','asset_file':old['payload']['components'][0]['file']},'首个候选的评论，不创建方案版本')
    change(need['object_id'],generation={**need['payload']['generation'],'prompt':'第二轮修改后的完整提示词'})
    f.put(f.spec('draw-wide-next','CALL',method='manual',tool='fixture',status='submitted',inputs=[],outputs=[],model='fixture',prompt='已完成隔离绘制',parameters={},lineage={'i2i_depth':0,'references':[]}))
    change('image-wide',production=f.ref('draw-wide-next'))
    current=p.record(f.store,'image-wide');comment(current,{'type':'visual','visual_id':'original','asset_file':current['payload']['components'][0]['file']},'版本二整图意见')
    # Additional entries exist only in this disposable browser fixture.
    for media,suffix,content in [('project','json',b'{"timeline": [], "fixture": true}'),('document','txt','隔离样例的素材使用说明。'.encode())]:
        c=ingest(f.root,io.BytesIO(content),'fixture.'+suffix)
        f.put(f.spec('call-'+media,'CALL',method='manual',tool='fixture',status='submitted',inputs=[],outputs=[]))
        f.put(f.spec('legacy-'+media,'ASSET',media_type=media,subjects=[],states=[],components=[c],production=f.ref('call-'+media),lineage={}))
    multi=p.record(f.store,'need-full-multi');comment(multi,txt(multi,'generation.prompt'),'已生成卡的原方案提示词评论')
    inputs=[{**v['reference'],**{k:v[k] for k in ('component_id','crop','range') if k in v}} for v in multi['payload']['generation']['inputs']]
    lineage={'i2i_depth':1,'references':[v['reference'] for v in multi['payload']['generation']['inputs']]}
    f.put(f.spec('draw-multi','CALL',method='manual',tool='fixture',status='submitted',inputs=inputs,outputs=[],model='fixture-multi',prompt='实际多参考调用',parameters={'quality':'test'},lineage=lineage))
    for i in (1,2):
        if i==2:f.put(f.spec('draw-multi-second','CALL',method='manual',tool='fixture',status='submitted',inputs=inputs,outputs=[],model='fixture-multi',prompt='实际多参考调用',parameters={'quality':'test'},lineage=lineage))
        f.put(f.spec('image-multi-'+str(i),'ASSET',media_type='image',subjects=[f.ref('songbook')],states=[f.ref('full')],components=p.record(f.store,'image-square')['payload']['components'],candidate_requirements=[f.ref('need-full-multi')],production=f.ref('draw-multi' if i==1 else 'draw-multi-second'),lineage=lineage,state_coverage=[{'state':f.ref('full'),'component_id':'original','role':'detail','detail':'隔离多参考'}]))
    legacy=p.record(f.store,'image-square')['payload'].copy();legacy.update(title='历史缺少真实调用',subjects=[],states=[],candidate_requirements=[],production=None);legacy.pop('state_coverage',None)
    f.store.put_object('legacy-no-call','ASSET',legacy)
    gap=f.spec('legacy-gap-call','CALL',method='manual',tool='fixture',status='submitted',inputs=[{**f.ref('voice'),'component_id':'removed-original','range':{'start_seconds':.1,'end_seconds':.8}}],outputs=[],model='legacy-gap',parameters={},prompt='保留旧输入缺口')
    f.store.put_object(gap['object_id'],'CALL',gap['payload']);legacy.update(title='历史文件组成缺口',production=f.ref('legacy-gap-call'));f.store.put_object('legacy-gap','ASSET',legacy)
    if args.source_audio:
        require_audio=args.source_audio.resolve();destination=f.root/'export/assets'/require_audio.name;shutil.copyfile(require_audio,destination)
        f.store.put_source({'id':'source-audio','title':'既有声音原件 · 资料入口隔离验收','version_type':'original','origin':'test','source_url':'https://example.org/audio','collected_at':'2026-10-04','notes':'仅复用既有文件，不表示声音接受','assets':[],'blocks':[{'id':'a','text':'此资料沿用来源资料正文评论模型。'}],'media':{'kind':'audio','file':require_audio.name,'label':'既有原件','note':'声音未改动'}})
    f.store.close()
    class FixtureHandler(ReviewHandler):
        def do_GET(self):
            if args.waveform_failure and self.path.split('?')[0]=='/review-ui.js':
                raw=(Path(__file__).parents[1]/'review_desk/static/review-ui.js').read_bytes()+b"\nreviewWaveform=()=>Promise.reject(Error('isolated waveform failure'));\n"
                self.send_response(200);self.send_header('Content-Type','text/javascript');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
            super().do_GET()
    try:
        with ReviewServer(('127.0.0.1',args.port),f.root,{'id':'material-ui-test','title':'素材卡隔离验收'}) as server:
            server.RequestHandlerClass=FixtureHandler
            print(f'http://127.0.0.1:{args.port}/?workspace=settings.workspace&production_object=songbook',flush=True)
            print('Instance: '+str(f.root),flush=True)
            server.serve_forever()
    finally:f.tmp.cleanup()


if __name__=='__main__':main()
