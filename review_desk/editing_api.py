"""The common editing operation surface for the browser and CLI."""
from . import editing as edit
from . import editing_worker as worker


def dispatch(store, root, action, value):
    if not isinstance(value,dict):raise ValueError('editing request must be an object')
    if action=='catalog':return edit.catalog(store,root,value.get('episode_id'))
    if action=='get':return edit.read(store,value['object_id'],value.get('revision_id'))
    if action=='review':
        from .editing_review import review
        return review(store,value['object_id'],value['revision_id'],value.get('association'))
    if action=='associate':
        from .editing_review import append_association
        return append_association(store,value['association'])
    if action=='validate':
        edit.validate_project(store,root,value['project'],inspect=True)
        return {'validated':True}
    if action=='save':return edit.save(store,root,value['project'],value['expected_version'])
    if action=='submit':return edit.submit(store,root,value['project_id'],value['expected_version'],value['task_id'],value['request_id'])
    if action=='status':return worker.result(store,root,value['id'])
    if action in ('cancel','retry'):return worker.change_job(store,root,value['id'],action)
    raise ValueError('unknown editing action')
