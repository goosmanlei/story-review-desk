const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const ctx={document:{addEventListener(){}},console};vm.createContext(ctx);
for(const name of ['app.js','production.js','review-ui.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),ctx);
const blocks=[{id:'a',text:'甲𪎊乙。\n隐藏字\n后段。'},{id:'gap',text:'不应引用的拆镜'},{id:'b',text:'米铺😀空间。'},{id:'c',text:'连续末段。'}];
const part=(id,start,end)=>({id,start,end,text:Array.from(blocks.find(b=>b.id===id).text).slice(start,end).join('')});
const anchor=parts=>ctx.anchorFromPassages(parts,blocks),plain=v=>JSON.parse(JSON.stringify(v));
test('different-block omission preserves both selected passages in one opinion',()=>{
 const a=anchor([part('a',0,4),part('b',0,6)]);
 assert.equal(a.quote,'甲𪎊乙。\n米铺😀空间。');assert.equal(a.segments.length,2);
 assert.deepEqual(plain(ctx.textAnchorBlockRanges(a,blocks,1)),[]);
 assert.deepEqual(plain(ctx.textAnchorBlockRanges(a,blocks,2)),[{start:0,end:6}]);
 const c={id:'opinion',target_revision_id:'r',anchor:{type:'text',...a}},scope={kind:'text',revision:'r',orderedBlockIds:blocks.map(b=>b.id)};
 assert.equal(ctx.reviewBlockComments([c],{...scope,blockIds:['gap']}).length,0);
 assert.equal(ctx.reviewBlockComments([c],{...scope,blockIds:['b']}).length,1);
});
test('same-block omissions and reordered passages retain reading order',()=>{
 const a=anchor([part('a',0,4),part('a',9,12)]);assert.equal(a.segments.length,2);assert.equal(a.quote,'甲𪎊乙。\n后段。');
 const reversed=anchor([part('b',0,6),part('a',0,4)]);assert.equal(reversed.quote,'米铺😀空间。\n甲𪎊乙。');
 assert.deepEqual(plain(ctx.textAnchorBlockRanges(reversed,blocks,0)),[{start:0,end:4}]);
});
test('a genuine continuous selection keeps the historical single-range format',()=>{
 const a=anchor([part('b',2,6),part('c',0,3)]);assert.equal(a.segments,undefined);assert.equal(a.quote,'😀空间。\n连续末');
 const same=anchor([part('a',0,4),part('a',5,8)]);assert.equal(same.segments,undefined);assert.equal(same.quote,'甲𪎊乙。\n隐藏字');
});
test('Unicode boundaries, invalid mappings and overlapping passages cannot produce a quote',()=>{
 assert.equal(anchor([part('b',2,3)]).quote,'😀');
 for(const bad of [{...part('b',0,3),text:'米铺\ud83d'},part('b',0,99),{...part('b',0,3),start:-1},{...part('b',0,3),id:'other'}])assert.equal(anchor([bad]),null);
 assert.equal(anchor([part('a',0,4),part('a',1,3)]),null);
});
test('production locator checks all selected passages without requiring hidden middle blocks',()=>{
 const a={type:'text',...anchor([part('a',0,4),part('b',0,6)])};
 vm.runInContext('state.productionSelected={object_id:"o",id:"r",payload:{blocks:[]}}',ctx);
 ctx.productionTextBlocks=()=>blocks;
 const r=ctx.productionCommentTextRange({target_object_id:'o',target_revision_id:'r',anchor:a});
 assert.equal(r.valid,true);assert.equal(r.segments.length,2);
 const nodes=[{dataset:{blockId:'a',anchorOffset:'0'},textContent:'甲𪎊乙。'},{dataset:{blockId:'b',anchorOffset:'0'},textContent:'米铺😀空间。'}];
 ctx.productionTextHidden=()=>false;const surface={querySelectorAll:()=>nodes};
 assert.equal(ctx.productionTextSurfaceContainsRange(r,surface),true);
 assert.equal(ctx.productionTextSurfaceContainsRange(r,{querySelectorAll:()=>nodes.slice(0,1)}),false);
 assert.equal(ctx.productionCommentTextRange({target_object_id:'another',target_revision_id:'r',anchor:a}),null);
});
test('returning to a draft keeps the composed reader for continuous or segmented visible ranges',()=>{
 const row={payload:{},review_composition:{sections:[{parts:[
   {block_id:'a',start:0,end:4,text:'甲𪎊乙。'},
   {block_id:'b',start:0,end:6,text:'米铺😀空间。'},
   {block_id:'c',start:0,end:5,text:'连续末段。'}]}]}};
 ctx.productionTextBlocks=()=>blocks;
 assert.equal(ctx.compositionContainsTextAnchor(row,anchor([part('a',0,4),part('b',0,6)])),true);
 assert.equal(ctx.compositionContainsTextAnchor(row,anchor([part('b',0,6),part('c',0,3)])),true);
 assert.equal(ctx.compositionContainsTextAnchor(row,{block_id:'a',end_block_id:'b',start:0,end:6}),false);
});
