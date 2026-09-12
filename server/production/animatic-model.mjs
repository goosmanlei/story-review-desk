import {canonical as canonicalJson,hash as sha256} from '../shared/contracts.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_INVALID'});};
const object=(v,name,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail(`${name}含不支持的字段`);};
const id=(v,name)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,299}$/.test(v))fail(`${name}身份无效`);};
const integer=(v,name,min=0,max=24*3600)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(`${name}必须是范围内的整数帧`);};
const rows=(v,name,max=1000)=>{if(!Array.isArray(v)||v.length>max)fail(`${name}列表无效`);};
const text=(v,name,max=1000)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))fail(`${name}文本无效`);};
export const animaticHash=value=>sha256(canonicalJson(value));
/** Locks are applicable per shot; a newer local edit must not erase another shot's proof. */
export function selectAnimaticLockForShot(locks,{sceneId,shotPlanRevisionId,shotId}){
 const matches=(locks||[]).filter(lock=>lock.scopeRole==='CURRENT'&&lock.sceneId===sceneId&&lock.shotPlanRevisionId===shotPlanRevisionId&&(!Array.isArray(lock.applicableShotIds)||lock.applicableShotIds.includes(shotId))&&lock.shotSlices?.filter(slice=>slice.shotId===shotId).length===1);
 matches.sort((a,b)=>String(b.lockedAt||'').localeCompare(String(a.lockedAt||''))||Number(b.eventSequence||0)-Number(a.eventSequence||0)||String(b.reviewEventId||b.timelineRevisionId||'').localeCompare(String(a.reviewEventId||a.timelineRevisionId||'')));
 const lock=matches[0];return lock?{lock,slice:lock.shotSlices.find(slice=>slice.shotId===shotId)}:null;
}
export function validateAnimaticMedia(v){object(v,'媒体绑定',['familyId','versionId','sha256']);id(v.familyId,'素材族');id(v.versionId,'版本');if(!/^[a-f0-9]{64}$/.test(v.sha256))fail('媒体必须绑定精确 SHA-256');return v;}
export function validateAnimaticTimeline(input,basis={}){
 const v=structuredClone(input);object(v,'时间线',['schemaVersion','sceneId','shotPlanRevisionId','fps','width','height','shots','audio','cards']);
 if(v.schemaVersion!=='1.0'||v.fps!==24||v.width!==1920||v.height!==1080)fail('预演使用已确认的 1920×1080、24fps 内部制作基线');id(v.sceneId,'场');id(v.shotPlanRevisionId,'镜头计划');
 if(basis.sceneId&&basis.sceneId!==v.sceneId||basis.shotPlanRevisionId&&basis.shotPlanRevisionId!==v.shotPlanRevisionId)fail('时间线必须绑定当前场和镜头计划修订');
 rows(v.shots,'镜头',500);rows(v.audio,'声音');rows(v.cards,'人物卡');if(!v.shots.length)fail('正式镜头计划尚未建立');
 const ids=new Set(),unique=(key,name)=>{id(key,name);if(ids.has(key))fail(`${name}身份重复`);ids.add(key);};
 for(const s of v.shots){object(s,'镜头片段',['shotId','durationFrames','panels','beats']);unique(s.shotId,'镜头');integer(s.durationFrames,'镜长',1,24*600);rows(s.panels,'粗分镜',100);rows(s.beats,'动作点',100);
  let cursor=0;for(const p of s.panels){object(p,'粗分镜',['id','media','startFrame','endFrame','motion']);unique(p.id,'粗分镜');validateAnimaticMedia(p.media);integer(p.startFrame,'粗分镜入点');integer(p.endFrame,'粗分镜出点',1);if(p.startFrame!==cursor||p.endFrame<=p.startFrame||p.endFrame>s.durationFrames)fail('已选粗分镜必须顺序连续覆盖本镜');if(!['STILL','PUSH_IN','PULL_OUT'].includes(p.motion))fail('仅支持固定、缓推和缓拉');cursor=p.endFrame;}
  if(s.panels.length&&cursor!==s.durationFrames)fail('粗分镜必须覆盖本镜完整时长');for(const b of s.beats){object(b,'动作点',['id','frame','label']);unique(b.id,'动作点');integer(b.frame,'动作点位置');if(b.frame>=s.durationFrames)fail('动作点超出镜长');text(b.label,'动作描述');}
 }
 const shotIds=v.shots.map(s=>s.shotId);if(basis.shotIds&&(shotIds.length!==basis.shotIds.length||basis.shotIds.some(key=>!shotIds.includes(key))))fail('预演必须一次覆盖本场全部当前镜头；增删或拆并镜头请修改镜头设计');
 const schedule=animaticSchedule(v);if(schedule.totalFrames>24*3600)fail('单场预演超过一小时');
 for(const a of v.audio){object(a,'音轨片段',['id','anchorShotId','offsetFrames','sourceInFrames','durationFrames','media','role','temporary','volume','muted','lineIds']);unique(a.id,'音轨片段');if(!shotIds.includes(a.anchorShotId))fail('音轨必须绑定本场镜头');integer(a.offsetFrames,'声音偏移',-24*3600);integer(a.sourceInFrames,'声音源入点');integer(a.durationFrames,'声音长度',1);validateAnimaticMedia(a.media);if(!['DIALOGUE','MUSIC','SFX'].includes(a.role)||typeof a.temporary!=='boolean'||typeof a.muted!=='boolean'||typeof a.volume!=='number'||!Number.isFinite(a.volume)||a.volume<0||a.volume>1)fail('音轨用途、临时状态或音量无效');rows(a.lineIds,'台词引用',500);a.lineIds.forEach(line=>id(line,'台词'));const start=schedule.shots.find(s=>s.shotId===a.anchorShotId).startFrame+a.offsetFrames;if(start<0||start+a.durationFrames>schedule.totalFrames)fail('声音片段超出场时间线');}
 for(const c of v.cards){object(c,'人物卡',['id','shotId','startFrame','endFrame','textLines','fontMedia','style','specRevisionId','specHash']);unique(c.id,'人物卡');const shot=v.shots.find(s=>s.shotId===c.shotId);if(!shot)fail('人物卡必须属于本场镜头');integer(c.startFrame,'人物卡入点');integer(c.endFrame,'人物卡出点',1);if(c.endFrame<=c.startFrame||c.endFrame>shot.durationFrames)fail('人物卡超出镜头');rows(c.textLines,'人物卡文字',2);if(c.textLines.length!==2)fail('人物卡必须是已规定的两行文字');c.textLines.forEach(line=>text(line,'人物卡文字',80));validateAnimaticMedia(c.fontMedia);id(c.specRevisionId,'人物卡规格');if(!/^[a-f0-9]{64}$/.test(c.specHash))fail('人物卡必须绑定冻结规格哈希');object(c.style,'人物卡样式',['fontSize','x','y','color']);integer(c.style.fontSize,'字号',16,120);integer(c.style.x,'横向位置',96,1728);integer(c.style.y,'纵向位置',54,864);if(!/^#[0-9a-fA-F]{6}$/.test(c.style.color))fail('人物卡颜色无效');}
 return v;
}
export function animaticSchedule(v){let cursor=0;const shots=v.shots.map(s=>{const startFrame=cursor;cursor+=s.durationFrames;return{shotId:s.shotId,startFrame,endFrame:cursor};});return{shots,totalFrames:cursor};}
export function animaticMediaBindings(v){return [...v.shots.flatMap(s=>s.panels.map(p=>p.media)),...v.audio.map(a=>a.media),...v.cards.map(c=>c.fontMedia)];}
/** Local slices omit accumulated scene starts and whole-scene hashes. */
export function animaticHashes(v){const schedule=animaticSchedule(v);return{timelineHash:animaticHash(v),totalFrames:schedule.totalFrames,shotSlices:v.shots.map((s,index)=>{
 const at=schedule.shots[index];const audio=v.audio.flatMap(a=>{const start=schedule.shots.find(row=>row.shotId===a.anchorShotId).startFrame+a.offsetFrames,end=start+a.durationFrames,from=Math.max(start,at.startFrame),to=Math.min(end,at.endFrame);return to<=from?[]:[{id:a.id,media:a.media,role:a.role,temporary:a.temporary,muted:a.muted,volume:a.volume,lineIds:a.lineIds,startFrame:from-at.startFrame,endFrame:to-at.startFrame,sourceInFrames:a.sourceInFrames+from-start}];});
 return{shotId:s.shotId,durationFrames:s.durationFrames,timingHash:animaticHash({durationFrames:s.durationFrames,beats:s.beats,audio}),visualHash:animaticHash(s.panels),overlayHash:animaticHash(v.cards.filter(c=>c.shotId===s.shotId)),boundaryHash:animaticHash({previousShotId:v.shots[index-1]?.shotId||null,nextShotId:v.shots[index+1]?.shotId||null})};})};}
export function animaticImpact(previous,next){const old=new Map((previous?animaticHashes(previous).shotSlices:[]).map(s=>[s.shotId,s]));return animaticHashes(next).shotSlices.map(s=>({shotId:s.shotId,timingChanged:old.get(s.shotId)?.timingHash!==s.timingHash,visualChanged:old.get(s.shotId)?.visualHash!==s.visualHash,overlayChanged:old.get(s.shotId)?.overlayHash!==s.overlayHash,boundaryChanged:old.get(s.shotId)?.boundaryHash!==s.boundaryHash})).filter(s=>s.timingChanged||s.visualChanged||s.overlayChanged||s.boundaryChanged);}
