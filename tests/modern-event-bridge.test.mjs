// Tests the actual bridge. Legacy callback spies test dispatch only, not legacy QA semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const moduleUrl=new URL('../host/instance-modern-event-bridge.mjs',import.meta.url);
const {modernEventSemanticSupport}=await import(moduleUrl);
const setup=String.raw`
import ast,hashlib,json,tempfile,types
from pathlib import Path
def stable(v):return json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':'))
def hash(v):return hashlib.sha256((v if isinstance(v,str) else stable(v)).encode()).hexdigest()
def fixture(root):
 rows=[{'eventId':'legacy','eventKind':'review','eventSequence':1,'idempotencyKeyHash':'a'*64},{'eventId':'modern','eventKind':'script-comment','eventSequence':2,'idempotencyKeyHash':'b'*64}]
 manifest_rows=[{**{k:e[k] for k in ['eventId','eventKind','eventSequence']},'sha256':hash(e)} for e in rows]
 manifest={'count':2,'eventSequenceHighWater':2,'events':manifest_rows,'eventsHash':hash(manifest_rows)}
 partition=[{**r,'recordValidator':'LEGACY' if r['eventId']=='legacy' else 'RUNTIME_MODERN','relationValidator':'LEGACY' if r['eventId']=='legacy' else 'RUNTIME_MODERN'} for r in manifest_rows]
 binding={'releaseId':'release:test','snapshotSha256':'c'*64,'eventDirectory':'events','eventManifest':manifest}
 proof={'schemaVersion':'1.0','mode':'VALIDATION_DELEGATION_ONLY','binding':binding,'manifest':manifest,'partition':partition,'partitionHash':hash(partition),'formalModernReviewSupported':False,'formalModernSourceSyncSupported':False,'originalEventsUnchanged':True,'eventsOmitted':0}
 envelope={'proof':proof,'proofSha256':hash(proof)}
 event_dir=root/'events';event_dir.mkdir()
 for e in rows:(event_dir/(e['eventKind']+'-'+e['idempotencyKeyHash']+'.json')).write_text(stable(e),encoding='utf-8')
 return rows,envelope,{'releaseId':'release:test','snapshotSha256':'c'*64}
def install_spies(rows,installer):
 calls=[];module=types.SimpleNamespace()
 def record(kind,event,label):calls.append(('record',event['eventId']));return ['UNFILTERED_LEGACY_RECORD_ERROR']
 def relation(events):calls.append(('relation',[e['eventId'] for rs in events.values() for e in rs]));return ['UNFILTERED_LEGACY_RELATION_ERROR']
 def load():
  events={};errors=[]
  for e in rows:
   errors.extend(module.event_record_errors(e['eventKind'],e,e['eventId']));events.setdefault(e['eventKind'],[]).append(e)
  errors.extend(module.event_relation_errors(events));module.errors=errors;return events
 module.event_record_errors=record;module.event_relation_errors=relation;module.load_operation_events=load;installer(module)
 return module,calls
`;
function run(code){const p=spawnSync('python3',['-B','-I','-c',modernEventSemanticSupport+'\n'+setup+'\n'+code],{encoding:'utf8'});assert.equal(p.status,0,p.stderr||p.stdout);}
test('full event set reaches downstream consumers; every legacy error propagates unchanged',()=>run(String.raw`
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);rows,envelope,published=fixture(root);install,finish=prepare_modern_event_delegation(root,envelope,published)
 module,calls=install_spies(rows,install);result=module.load_operation_events();report=finish()
 assert [e for rs in result.values() for e in rs]==rows
 assert module.errors==['UNFILTERED_LEGACY_RECORD_ERROR','UNFILTERED_LEGACY_RELATION_ERROR']
 assert calls==[('record','legacy'),('relation',['legacy'])]
 assert report['legacyRecordCount']==report['runtimeRecordCount']==1 and report['originalEventBytesPreserved']
`));
const cases={
 'changed event byte':"file=next((root/'events').glob('review-*.json'));file.write_text(file.read_text()+'\\n')",
 'omitted event':"next((root/'events').glob('review-*.json')).unlink()",
 'extra unbound event':"(root/'events'/'unexpected.json').write_text('{}')",
 'directory masquerading as event':"(root/'events'/'extra.json').mkdir()",
 'event path symlink':"file=next((root/'events').glob('review-*.json'));other=root/'copied.json';other.write_bytes(file.read_bytes());file.unlink();file.symlink_to(other)",
 'forged proof hash':"envelope['proofSha256']='d'*64",
 'wrong base release':"published['releaseId']='release:other'",
 'dropped partition entry':"envelope['proof']['partition'].pop();envelope['proof']['partitionHash']=hash(envelope['proof']['partition']);envelope['proofSha256']=hash(envelope['proof'])",
 'unknown delegate':"envelope['proof']['partition'][0]['recordValidator']='SKIP';envelope['proof']['partitionHash']=hash(envelope['proof']['partition']);envelope['proofSha256']=hash(envelope['proof'])",
 'changed partition event digest':"envelope['proof']['partition'][0]['sha256']='e'*64;envelope['proof']['partitionHash']=hash(envelope['proof']['partition']);envelope['proofSha256']=hash(envelope['proof'])",
 'fake formal support':"envelope['proof']['formalModernReviewSupported']=True;envelope['proofSha256']=hash(envelope['proof'])",
 'path traversal':"envelope['proof']['binding']['eventDirectory']='../events';envelope['proofSha256']=hash(envelope['proof'])",
};
for(const[name,change]of Object.entries(cases))test(name+' fails closed',()=>run(`with tempfile.TemporaryDirectory() as temp:\n root=Path(temp);rows,envelope,published=fixture(root)\n ${change}\n try:prepare_modern_event_delegation(root,envelope,published)\n except (ValueError,KeyError):pass\n else:raise AssertionError('mutation accepted')\n`));
test('a file changed after independent proof validation is rejected at finish',()=>run(String.raw`
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);rows,envelope,published=fixture(root);install,finish=prepare_modern_event_delegation(root,envelope,published)
 module,calls=install_spies(rows,install);module.load_operation_events();next((root/'events').glob('review-*.json')).write_text('{}')
 try:finish()
 except ValueError:pass
 else:raise AssertionError('post-validation mutation accepted')
`));
test('missing legacy full-set traversal cannot fabricate completion',()=>run(String.raw`
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);rows,envelope,published=fixture(root);install,finish=prepare_modern_event_delegation(root,envelope,published)
 try:finish()
 except ValueError:pass
 else:raise AssertionError('unexecuted QA accepted')
`));
test('unreviewed legacy function AST cannot enter the dispatcher',()=>run(String.raw`
try:guard_modern_event_delegation_ast(ast.parse('def event_record_errors(kind,event,label):\n return []'))
except ValueError:pass
else:raise AssertionError('unreviewed AST accepted')
`));
