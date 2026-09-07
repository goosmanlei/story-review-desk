import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pageClosedComments,CommentPageError} from '../host/instance-runtime/comment-pagination.mjs';
const rows=Array.from({length:57},(_,index)=>({commentId:'comment-'+String(index).padStart(3,'0'),commentRevisionId:'revision-'+index,latestEventId:'event-'+index,updatedAt:new Date(Date.UTC(2026,0,1,0,index)).toISOString(),commentText:'评论🙂'.repeat(1000)+(index===1?'全文末尾唯一凭据':''),quote:'原圈选'.repeat(1000)+(index===2?'圈选末尾凭据':''),resolutionNote:index===3?'处理说明唯一凭据':'',archived:true,originalTarget:{label:'历史对象 '+index,subjectId:'permanent-'+index}}));
test('default 20, stable order and exact union without duplicates',()=>{
 let cursor='',all=[],pages=0;
 do{const page=pageClosedComments([...rows,rows[0]],{revision:'version-one',cursor});assert.ok(page.items.length<=20);assert.equal(page.total,57);all.push(...page.items.map(item=>item.commentId));cursor=page.nextCursor||'';pages++;}while(cursor);
 assert.equal(pages,3);assert.equal(new Set(all).size,57);assert.equal(all[0],'comment-056');assert.equal(all.at(-1),'comment-000');
});
test('summary has no full comment, anchor, processing note or target body',()=>{
 const page=pageClosedComments(rows,{revision:'one',currentIds:new Set(['comment-056'])});
 assert.equal(page.items[0].isCurrent,true);assert.equal(page.items[1].isCurrent,false);
 for(const item of page.items){assert.ok([...item.preview].length<=140);for(const key of ['commentText','quote','resolutionNote','target','resolutionTarget'])assert.equal(key in item,false);}
 assert.ok(JSON.stringify(page).length<16000);
});
test('full text search reaches comments, original selection, resolution and permanent identity beyond the page',()=>{
 for(const [query,id]of [['全文末尾唯一凭据','comment-001'],['圈选末尾凭据','comment-002'],['处理说明唯一凭据','comment-003'],['permanent-56','comment-056']]){
  const page=pageClosedComments(rows,{revision:'one',query});assert.equal(page.matched,1);assert.equal(page.items[0].commentId,id);
 }
 assert.equal(pageClosedComments(rows,{revision:'one',query:'绝不匹配'}).matched,0);
});
test('cursor binds revision, query and size, rejects stale/malformed cursors',()=>{
 const first=pageClosedComments(rows,{revision:'one'}),cursor=first.nextCursor;
 for(const options of [{revision:'two'},{revision:'one',query:'comment'},{revision:'one',limit:10}]){
  assert.throws(()=>pageClosedComments(rows,{...options,cursor}),e=>e instanceof CommentPageError&&e.status===409);
 }
 assert.throws(()=>pageClosedComments(rows,{revision:'one',cursor:'not-json'}),e=>e.status===400);
 assert.throws(()=>pageClosedComments(rows.filter(row=>row.commentId!==first.items.at(-1).commentId),{revision:'one',cursor}),e=>e.status===409);
 for(const limit of [0,-1,101,'abc',1.5])assert.throws(()=>pageClosedComments(rows,{revision:'one',limit}),e=>e.status===400);
 assert.throws(()=>pageClosedComments(rows,{revision:'one',query:'x'.repeat(501)}),e=>e.status===400);
});
test('duplicate identities retain the newest immutable comment head',()=>{
 const current=rows[0],older={...current,latestEventId:'older',updatedAt:'2020-01-01T00:00:00.000Z'};
 const page=pageClosedComments([older,current],{revision:'one'});assert.equal(page.items.length,1);assert.equal(page.items[0].latestEventId,current.latestEventId);
});
