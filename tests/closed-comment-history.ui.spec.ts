import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {pageClosedComments} from '../host/instance-runtime/comment-pagination.mjs';
import type {ClosedCommentHistoryEntry} from '../app/closed-comment-history';

const base=JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8'));
const closedHistory:ClosedCommentHistoryEntry[]=[
 {commentId:'closed-legacy-scene',commentRevisionId:'closed-edit-1',latestEventId:'closed-event-1',commentText:"请明确原稿人物来访的原因。完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；完整评论保留，折叠行只展示摘要；来访动机全文定位",quote:"旧版保留的精确圈选文字。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。这部分原文不能因单行摘要而被截断。圈选末尾搜索凭据甲",createdAt:'2026-01-01T01:00:00Z',updatedAt:'2026-01-03T02:00:00Z',resolutionNote:"已在新稿说明原因；不把旧场号重绑到当前场。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。保留处理依据的完整内容与旧版本身份。处理末尾搜索凭据甲",resolvedBy:'USER',archived:true,readOnly:true,originalTarget:{kind:'SCENE_SCRIPT',subjectId:'S14',label:'旧快照 · S14',revisionId:null,snapshotId:'historical-snapshot',contentHash:'a'.repeat(64)},resolutionTarget:{candidateRevisionId:'historical-resolution-candidate',sceneBindings:[{sceneId:'permanent-historical-resolution-scene',contentHash:'b'.repeat(64)}]}},
 {commentId:'closed-episode-design',commentRevisionId:'closed-edit-2',latestEventId:'closed-event-2',commentText:'前一方案的本集回报需要更明确。',quote:'原分集说明的完整圈选。',createdAt:'2026-02-01T01:00:00Z',updatedAt:'2026-02-03T02:00:00Z',resolutionNote:'已补充可见结果，保留原集永久身份。',resolvedBy:'AI',archived:true,readOnly:true,originalTarget:{kind:'EPISODE_DESIGN',subjectId:'permanent-retired-episode',label:'原方案 · E01',revisionId:'historical-plan-revision',snapshotId:'historical-snapshot',contentHash:'c'.repeat(64)},resolutionTarget:null},
];
async function fixture(page:Page,{currentResolved=false,many=false}={}){
 const capture=structuredClone(base),plan=capture.responses.episodePlan.plan;
 const snapshot=capture.responses.bootstrap.data,configuration=snapshot.productionModel.systemConfiguration,ref=capture.responses.runtime.configurationRef;
 const sceneDocument=capture.responses.sceneReviewContext.context.sceneDocument,episodeUid=plan.content.episodes[0].episodeUid;
 const contextBinding={revisionId:plan.revisionId,planContentHash:plan.contentHash,contentHash:sceneDocument.contentHash,kind:'SCENE_SCRIPT',subjectId:sceneDocument.id,episodeUid};
 const currentTarget={...contextBinding,label:'当前集精确评论标签丙',contextHash:createHash('sha256').update(JSON.stringify(contextBinding)).digest('hex'),blocks:sceneDocument.scriptBlocks.map((block:{id:string;text:string})=>({id:block.id,text:block.text}))};
 const currentThread={commentId:'closed-current-exact',commentRevisionId:'current-closed-rev',latestEventId:'current-closed-event',target:currentTarget,anchor:{blockId:currentTarget.blocks[0].id,startOffset:0,endOffset:currentTarget.blocks[0].text.length,quote:currentTarget.blocks[0].text},commentText:'当前正文的关闭意见：本集来访动机已补明，当前意见检索凭据丙。',status:'RESOLVED',updatedAt:'2026-03-03T02:00:00Z',anchorMatchesCurrentText:true,applicabilityState:'CURRENT'};
 const currentClosure:ClosedCommentHistoryEntry={commentId:currentThread.commentId,commentRevisionId:currentThread.commentRevisionId,latestEventId:currentThread.latestEventId,commentText:currentThread.commentText,quote:currentThread.anchor.quote,createdAt:'2026-03-01T01:00:00Z',updatedAt:currentThread.updatedAt,resolutionNote:'当前处理说明：用动作交代来意，精确处理检索凭据丙。',resolvedBy:'USER',archived:false,readOnly:true,originalTarget:{kind:'SCENE_SCRIPT',subjectId:sceneDocument.id,label:currentTarget.label,revisionId:plan.revisionId,snapshotId:plan.snapshotId,contentHash:sceneDocument.contentHash},resolutionTarget:{candidateRevisionId:plan.revisionId,sceneBindings:[{sceneId:sceneDocument.id,contentHash:sceneDocument.contentHash}]}};
 const historyRows=[...closedHistory,...(currentResolved?[currentClosure]:[]),...(many?Array.from({length:43},(_,index)=>({...closedHistory[1],commentId:'pagination-'+index,latestEventId:'pagination-event-'+index,updatedAt:new Date(Date.UTC(2026,3,1,0,index)).toISOString(),commentText:'分页意见 '+index})):[])];
 let detailReads=0;
 const errors:string[]=[],writes:string[]=[],unexpected:string[]=[],commentReads:Array<{revisionId:string|null;sceneId:string|null;episodeUid:string|null}>=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/assistant/v1/context'&&req.method()==='POST')return json({context:{focus:req.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(req.method()!=='GET'){writes.push(req.method()+' '+url.pathname);return route.fulfill({status:405,json:{error:'History fixture is read-only'}});}
  if(url.pathname==='/api/instance/profile')return json(capture.responses.bootstrap.data.instance);
  if(url.pathname==='/api/instance/configuration')return json({configuration:configuration.config,defaults:configuration.defaults,releaseId:capture.responses.runtime.releaseId,revisionId:ref.revisionId,sha256:ref.sha256,history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null,readOnly:true});
  if(url.pathname==='/api/v8/snapshot')return json({snapshotId:plan.snapshotId,executionRecipes:{...blankSnapshot(snapshot.instance).recipes,snapshotId:plan.snapshotId}});
  if(url.pathname==='/api/v8/script-comments'){
   commentReads.push({revisionId:url.searchParams.get('revisionId'),sceneId:url.searchParams.get('sceneId'),episodeUid:url.searchParams.get('episodeUid')});
   if(url.searchParams.get('history')==='page')return json({closedPage:pageClosedComments(historyRows,{revision:'test-history-v1',query:url.searchParams.get('q')||'',cursor:url.searchParams.get('cursor')||'',limit:url.searchParams.get('limit')||20,currentIds:new Set(currentResolved?[currentThread.commentId]:[])})});
   if(url.searchParams.get('history')==='detail'){
    detailReads++;const item=historyRows.find(row=>row.commentId===url.searchParams.get('commentId'));
    if(url.searchParams.get('historyRevision')!=='test-history-v1'||!item)return route.fulfill({status:409,json:{error:'评论已变化'}});
    return json({historyRevision:'test-history-v1',item,thread:item.commentId===currentThread.commentId?currentThread:null});
   }
   return json({snapshotId:plan.snapshotId,revisionId:plan.revisionId,planContentHash:plan.contentHash,targets:currentResolved?[currentTarget]:[],threads:[],closedCount:historyRows.length});
  }
  if(url.pathname==='/api/instance/sources')return json({...capture.responses.sources,readOnly:true});
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(['/api/v8/creative-revisions','/api/v8/reviews','/api/v8/episode-plan-reviews','/api/v8/source-operations'].includes(url.pathname))return json({events:[],revisions:[],submissions:[],operations:[]});
  for(const[key,path]of Object.entries(capture.routes))if(url.pathname===String(path).split('?')[0])return json(capture.responses[key]);
  unexpected.push(req.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'Unexpected history fixture request'}});
 });
 return {capture,plan,errors,writes,unexpected,commentReads,currentThread,currentClosure,historyRows,detailReads:()=>detailReads};
}

async function openHistory(page:Page,width:number,options:{currentResolved?:boolean;many?:boolean}={}){
 await page.setViewportSize({width,height:1000});
 const f=await fixture(page,options),episodeUid=f.plan.content.episodes[0].episodeUid;
 await page.goto('/?view=story&storyMode=logic&episodePlanRevision='+encodeURIComponent(f.plan.revisionId)+'&episode='+encodeURIComponent(episodeUid));
 await page.getByRole('button',{name:`查看评论 · 0 待处理 · ${f.historyRows.length} 已关闭`,exact:true}).click();
 const history=page.getByRole('region',{name:'全剧已关闭评论历史',exact:true});
 await expect(history).toBeVisible();await expect(history.locator('article[data-comment-id]')).toHaveCount(Math.min(20,f.historyRows.length));
 return {...f,history};
}
for(const width of [1440,390]){
 test(width+'：历史分页默认20条、翻页不加载正文、展开按需读取、搜索覆盖全历史',async({page})=>{
  const f=await openHistory(page,width,{many:true}),rows=f.history.locator('article[data-comment-id]');
  expect(f.detailReads()).toBe(0);await expect(f.history.locator('.closed-comment-body')).toHaveCount(0);
  const firstIds=await rows.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-comment-id')));
  await f.history.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(f.history.getByText('第 2 页',{exact:true})).toBeVisible();await expect(rows).toHaveCount(20);
  const secondIds=await rows.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-comment-id')));
  expect(secondIds.some(id=>firstIds.includes(id))).toBe(false);expect(f.detailReads()).toBe(0);
  await f.history.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(f.history.getByText('第 3 页',{exact:true})).toBeVisible();await expect(rows).toHaveCount(5);
  await expect(f.history.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
  const search=f.history.getByRole('searchbox',{name:'查找已关闭评论',exact:true});
  for(const query of ['来访动机全文定位','圈选末尾搜索凭据甲','处理末尾搜索凭据甲','旧快照 · S14']){
   await search.fill(query);await expect(rows).toHaveCount(1);await expect(rows.first()).toHaveAttribute('data-comment-id','closed-legacy-scene');
   await expect(f.history.locator('.closed-comment-body')).toHaveCount(0);
  }
  expect(f.detailReads()).toBe(0);
  const disclosure=rows.first().locator(':scope > .closed-comment-disclosure'),summary=disclosure.locator(':scope > summary');
  await summary.focus();await summary.press('Enter');await expect(disclosure).toHaveAttribute('open','');
  await expect(disclosure.locator('.closed-comment-text')).toHaveText(closedHistory[0].commentText);
  await expect(disclosure.locator('blockquote p')).toHaveText(closedHistory[0].quote);
  await expect(disclosure.locator('.closed-comment-resolution p')).toHaveText(closedHistory[0].resolutionNote);
  expect(f.detailReads()).toBe(1);await expect(rows.locator('button,textarea,input')).toHaveCount(0);
  await summary.press('Enter');await expect(f.history.locator('.closed-comment-body')).toHaveCount(0);
  await search.fill('绝不匹配的凭据');await expect(rows).toHaveCount(0);await expect(f.history.getByText('没有匹配的已关闭评论。',{exact:true})).toBeVisible();
  await search.fill('');await expect(rows).toHaveCount(20);await expect(f.history.getByText('第 1 页',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)).toBe(false);
  expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
 });
 test(width+'：当前关闭与历史只列一次，原圈选定位和重新打开在完整详情内',async({page})=>{
  const f=await openHistory(page,width,{currentResolved:true}),id=f.currentThread.commentId;
  const row=f.history.locator('article[data-comment-id="'+id+'"]');
  await expect(row).toHaveCount(1);await expect(row).toHaveAttribute('data-history-only','false');
  await expect(row.locator('button')).toHaveCount(0);expect(f.detailReads()).toBe(0);
  const search=f.history.getByRole('searchbox',{name:'查找已关闭评论'});
  await search.fill('精确处理检索凭据丙');await expect(f.history.locator('article')).toHaveCount(1);
  await row.locator(':scope > details > summary').click();
  await expect(row.locator('.closed-comment-text')).toHaveText(f.currentThread.commentText);
  await expect(row.getByRole('button',{name:'定位原圈选',exact:true})).toBeVisible();
  await expect(row.getByRole('button',{name:'重新打开',exact:true})).toBeVisible();
  await expect(row.getByRole('button',{name:'编辑',exact:true})).toHaveCount(0);
  await row.locator(':scope > details > summary').click();await expect(row.locator('button')).toHaveCount(0);
  expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
 });
}
