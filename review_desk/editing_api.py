"""The common editing operation surface for the browser and CLI."""
from . import editing as edit
from . import editing_worker as worker


def dispatch(store, root, action, value):
    if not isinstance(value,dict):raise ValueError('editing request must be an object')
    if action=='catalog':return edit.catalog(store,root,value.get('episode_id'))
    if action=='get':return edit.read(store,value['object_id'],value.get('revision_id'))
    if action=='validate':
        edit.validate_project(store,root,value['project'],inspect=True)
        return {'validated':True}
    if action=='save':return edit.save(store,root,value['project'],value['expected_version'])
    if action=='submit':return edit.submit(store,root,value['project_id'],value['expected_version'],value['task_id'],value['request_id'])
    if action=='status':return worker.result(store,root,value['id'])
    if action in ('cancel','retry'):return worker.change_job(store,root,value['id'],action)
    if action=='compare':
        a=edit.read(store,value['source_output']);b=edit.read(store,value['target_output'])
        if a['kind']!='EPISODE_FILM' or b['kind']!='EPISODE_FILM':raise ValueError('compare requires two rendered outputs')
        return edit.compare(a['payload']['project'],b['payload']['project'],edit.integer(value['frame'],'comparison frame'))
    raise ValueError('unknown editing action')
