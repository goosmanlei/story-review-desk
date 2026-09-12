import { check, hash, identity } from '../shared/contracts.mjs';
import { PresentationRead, idsFor } from '../presentation/read-unit.mjs';

const fields = {
  SCENE: ['slugline','purpose','storyTime','viewpoint','audienceKnown','audienceWithheld','transition'],
  EPISODE: ['openingHook','coreAdvance','endingCliffhanger','reviewQuestion'],
};
export async function storyEditor(unit, id) {
  const row = await unit.detail(id);
  check(fields[row.kind], 'STORY_EDITOR_KIND', '请选择一集或一场', 400);
  return { objectId:row.id, kind:row.kind, title:row.title, revisionId:row.revision.id,
    expectedVersion:row.version, content:row.revision.content, links:row.links,
    readOnly:row.historical || ['DISABLED','ARCHIVED'].includes(row.state), state:row.state };
}

export async function planStoryEdit(tx, input) {
  const unit = new PresentationRead(tx), row = await unit.detail(input.objectId);
  check(fields[row.kind] && !row.historical && !['DISABLED','ARCHIVED'].includes(row.state), 'STORY_EDITOR_READ_ONLY', '此对象只读，请保留历史并新建草稿', 409);
  check(row.version === input.expectedVersion && row.revision.id === input.revisionId, 'VERSION_CONFLICT', '本稿已改变；你的编辑仍保留，请先核对新版本', 409);
  check(typeof input.title === 'string' && input.title.trim() && input.title.length <= 500, 'TITLE_REQUIRED', '请填写标题');
  check(input.content && typeof input.content === 'object', 'STORY_CONTENT', '缺少正文');
  check(Object.keys(input.content).every(k=>fields[row.kind].includes(k)||row.kind==='SCENE'&&k==='blocks'), 'STORY_EDITOR_FIELD', '此表单只修改标题、正文和所示叙事字段');
  for(const key of fields[row.kind]) if(input.content[key]!==undefined) check(typeof input.content[key]==='string'&&input.content[key].length<=20000, 'STORY_EDITOR_TEXT', '正文说明过长或格式无效');
  const content = {...row.revision.content, ...input.content};
  if(row.kind==='SCENE') {
    delete content.contentHash;
    const blocks = input.content.blocks;
    check(Array.isArray(blocks)&&blocks.length>0&&blocks.length<=1000, 'SCENE_BLOCKS', '一场须包含 1 至 1000 个段落');
    check(new Set(blocks.map(b=>b.id)).size===blocks.length, 'BLOCK_ID_CONFLICT', '段落身份不能重复');
    const original = new Set((row.revision.content.blocks||[{id:row.id+'-body'}]).map(b=>b.id));
    for(const block of blocks) {
      identity(block.id);
      check(original.has(block.id)||/^block:[a-z0-9-]{36}$/i.test(block.id), 'BLOCK_IDENTITY', '新增段落须使用新的永久身份');
      check(['action','dialogue'].includes(block.type)&&['text','speaker','performanceNote'].every(k=>typeof block[k]==='string'&&block[k].length<=50000), 'SCENE_BLOCK', '段落类型或正文格式无效');
      check(Object.keys(block).every(k=>['id','type','text','speaker','performanceNote'].includes(k)), 'SCENE_BLOCK', '段落包含不支持的字段');
    }
    content.blocks = blocks;
    content.text = blocks.map(b=>b.text).join('\n\n');
    if(row.revision.content.runtime&&hash(blocks)!==hash(row.revision.content.blocks||[])){
      const prior=row.revision.content.runtime;
      content.runtime={...prior,compactSec:null,baseSec:null,spaciousSec:null,dialogueSec:null,actionSec:null,reactionSec:null,transitionSec:null,overlapSec:null,confidence:'UNKNOWN',rationale:'正文已修改，需重新核对估时；原估算保留在上一版。',estimateBasisRevisionId:row.revision.id,needsReview:true};
    }
    // Existing comments remain bound to their original revision and block IDs.
  }
  const commands = [], links = row.links;
  if(input.sceneIds!==undefined) {
    check(row.kind==='EPISODE'&&Array.isArray(input.sceneIds)&&input.sceneIds.length>0&&input.sceneIds.length<=200&&new Set(input.sceneIds).size===input.sceneIds.length, 'EPISODE_SCENES', '分集须包含唯一的永久场身份');
    // Moving between episodes is a separate multi-object operation. This form
    // changes the order of this episode's existing members only.
    check(hash([...input.sceneIds].sort())===hash(idsFor(row,'SCENE').sort()), 'EPISODE_MEMBERSHIP', '本表单只调整本集场次顺序，跨集移动须同时核对两集');
    links.splice(0,links.length,...links.filter(l=>l.role!=='SCENE'),...input.sceneIds.map(id=>({id,role:'SCENE'})));
  }
  commands.push({type:'save',id:row.id,expectedVersion:row.version,title:input.title,content,links});
  return {commands,response:results=>({...results.at(-1),formalAdoptionPerformed:false})};
}

export async function episodeOrganization(unit,id){
 const episode=await unit.detail(id);check(episode.kind==='EPISODE'&&!episode.historical,'EPISODE_REQUIRED','请选择当前分集',409);
 const episodes=await unit.rows(['EPISODE']);
 const scenes=await unit.rows(['SCENE'],{ids:idsFor(episode,'SCENE')});
 return {episodeId:id,expectedVersion:episode.version,revisionId:episode.revision.id,episodes:episodes.filter(e=>e.id!==id).map(e=>({id:e.id,title:e.title,displayId:e.displayId,expectedVersion:e.version,revisionId:e.revisionId})),scenes:idsFor(episode,'SCENE').map(id=>{const s=scenes.find(s=>s.id===id);return {id,title:s?.title||id,expectedVersion:s?.version,revisionId:s?.revisionId};})};
}
export async function planEpisodeOrganization(tx,input){
 const unit=new PresentationRead(tx),from=await unit.detail(input.episodeId);
 check(from.kind==='EPISODE'&&!from.historical&&!['DISABLED','ARCHIVED'].includes(from.state),'EPISODE_REQUIRED','请选择可编辑分集',409);
 check(from.version===input.expectedVersion&&from.revision.id===input.revisionId,'VERSION_CONFLICT','原分集已变化，未移动或新增场次',409);
 const fromIds=idsFor(from,'SCENE'),commands=[];
 function membership(row,ids,extra=[]){const oldScenes=new Set(idsFor(row,'SCENE'));return {type:'save',id:row.id,expectedVersion:row.version,content:row.revision.content,links:[...row.links.filter(l=>l.role!=='SCENE'),...ids.map(id=>({id,role:'SCENE'}))],dependencies:[...row.dependencies.filter(d=>!oldScenes.has(d.objectId)),...extra]};}
 if(input.action==='move'){
  const to=await unit.detail(input.targetEpisodeId),scene=await unit.detail(input.sceneId),toIds=idsFor(to,'SCENE');
  check(to.id!==from.id&&to.kind==='EPISODE'&&!to.historical&&!['DISABLED','ARCHIVED'].includes(to.state),'EPISODE_REQUIRED','目标分集不可接收此场',409);
  check(to.version===input.targetExpectedVersion&&to.revision.id===input.targetRevisionId&&scene.version===input.sceneExpectedVersion,'VERSION_CONFLICT','目标分集或所选场已变化，未改动任一对象',409);
  check(fromIds.includes(scene.id)&&!toIds.includes(scene.id)&&fromIds.length>1,'SCENE_MEMBERSHIP','此场归属不符，或原分集只剩一场',409);
  const owners=(await unit.tx.query("SELECT owner_id FROM memberships m JOIN objects o ON o.id=m.owner_id WHERE m.member_id=$1 AND m.role='SCENE' AND o.kind='EPISODE' AND NOT o.historical",[scene.id])).rows;check(owners.length===1&&owners[0].owner_id===from.id,'SCENE_OWNERSHIP','此场存在多个当前归属，须先核对',409);
  commands.push({type:'assert',id:scene.id,expectedVersion:scene.version});
  for(const [row,ids]of [[from,fromIds.filter(id=>id!==scene.id)],[to,[...toIds,scene.id]]]){const rows=await unit.rows(['SCENE'],{ids});commands.push(membership(row,ids,rows.map(r=>({revisionId:r.revisionId,purpose:'CONTENT'}))));}
 }else{
  check(input.action==='create'&&typeof input.title==='string'&&input.title.trim()&&typeof input.text==='string'&&input.text.trim(),'SCENE_CONTENT','请填写新场标题和正文');identity(input.sceneId);identity(input.blockId);
  check(!fromIds.includes(input.sceneId),'SCENE_IDENTITY','新场须使用新的永久身份',409);
  commands.push({type:'save',id:input.sceneId,kind:'SCENE',expectedVersion:0,title:input.title,content:{authority:'A',text:input.text,blocks:[{id:input.blockId,type:'action',speaker:'',performanceNote:'',text:input.text}]}});
  const rows=await unit.rows(['SCENE'],{ids:fromIds});commands.push(membership(from,[...fromIds,input.sceneId],[...rows.map(r=>({revisionId:r.revisionId,purpose:'CONTENT'})),{revisionIdFrom:0,objectId:input.sceneId,purpose:'CONTENT'}]));
 }
 return {commands,response:r=>({sceneId:input.sceneId,state:'DRAFT',changedEpisodes:r.filter(r=>r.id!==input.sceneId).map(r=>r.id),formalAdoptionPerformed:false})};
}
