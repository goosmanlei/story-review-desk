#!/usr/bin/env python3
"""Deterministic stdio fixture. No network and no model invocation."""
import json,sys,os
def send(value):print(json.dumps(value),flush=True)
stage=0
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    if method=='initialize':send({'id':message['id'],'result':{}})
    elif method=='thread/start':
        assert message['params']['sandbox']=='read-only'
        assert {x['name'] for x in message['params']['dynamicTools']}=={'read_object','read_context','list_objects','read_source','read_image'}
        send({'id':message['id'],'result':{'thread':{'id':'mock-thread'}}})
    elif method=='turn/start':
        value=json.loads(message['params']['input'][0]['text']);obj=value['object']
        send({'id':message['id'],'result':{'turn':{'id':'mock-turn'}}})
        send({'id':'read-1','method':'item/tool/call' if not os.getenv('MOCK_ILLEGAL_TOOL') else 'item/commandExecution/requestApproval','params':{'threadId':'mock-thread','turnId':'mock-turn','tool':'read_object','arguments':{'id':obj['id']}}})
    elif message.get('id')=='read-1':
        if 'error' in message:sys.exit(4)
        parsed=json.loads(message['result']['contentItems'][0]['text']);assert parsed['revision']['id']=='fixture-revision'
        send({'id':'read-2','method':'item/tool/call','params':{'threadId':'mock-thread','turnId':'mock-turn','tool':'read_source','arguments':{'revisionId':'fixture-revision','offset':0}}})
    elif message.get('id')=='read-2':
        send({'id':'read-3','method':'item/tool/call','params':{'threadId':'mock-thread','turnId':'mock-turn','tool':'read_context','arguments':{'id':'fixture'}}})
    elif message.get('id')=='read-3':
        parsed=json.loads(message['result']['contentItems'][0]['text']);assert parsed['primary'][0]['revision']['id']=='parent-revision'
        send({'id':'read-4','method':'item/tool/call','params':{'threadId':'mock-thread','turnId':'mock-turn','tool':'list_objects','arguments':{'kind':'SCENE','query':'信件'}}})
    elif message.get('id')=='read-4':
        parsed=json.loads(message['result']['contentItems'][0]['text']);assert parsed['items'][0]['id']=='fixture'
        if os.getenv('MOCK_IMAGE_SHA'):
            send({'id':'read-image','method':'item/tool/call','params':{'threadId':'mock-thread','turnId':'mock-turn','tool':'read_image','arguments':{'id':'image-fixture','sha256':os.environ['MOCK_IMAGE_SHA']}}})
            continue
        answer=json.dumps({'summary':'受控模拟建议','patch':{'text':'模拟修订'},'draftSuggestions':[]})
        send({'method':'item/completed','params':{'threadId':'mock-thread','turnId':'mock-turn','item':{'id':'answer','type':'agentMessage','text':answer}}})
        send({'method':'turn/completed','params':{'threadId':'mock-thread','turn':{'id':'mock-turn','status':'completed'}}})

    elif message.get('id')=='read-image':
        assert 'error' not in message, message
        content=message['result']['contentItems']
        assert content[1]['type']=='inputImage' and content[1]['imageUrl'].startswith('data:image/png;base64,')
        info=json.loads(content[0]['text']);assert info['width']==1 and info['height']==1
        answer=json.dumps({'summary':'受控原图字节模拟','patch':{},'draftSuggestions':[]})
        send({'method':'item/completed','params':{'threadId':'mock-thread','turnId':'mock-turn','item':{'id':'answer','type':'agentMessage','text':answer}}})
        send({'method':'turn/completed','params':{'threadId':'mock-thread','turn':{'id':'mock-turn','status':'completed'}}})
