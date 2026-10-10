const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// DOM substitute tests the actual locator and leaf wrapping; Chrome acceptance
// separately verifies native selection, visibility, persistence and scrolling.
class Node{
 constructor(tag,text=''){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.ownText=text;this.classes=new Set();this.classList={add:v=>this.classes.add(v),remove:v=>this.classes.delete(v),contains:v=>this.classes.has(v)}}
 append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n)}}
 get textContent(){return this.ownText+this.children.map(n=>n.textContent).join('')}
 all(){return this.children.flatMap(n=>[n,...n.all()])}
 querySelectorAll(selector){return this.all().filter(n=>selector==='[data-production-blocks]'?n.dataset.productionBlocks:selector==='[data-block-id]'?n.dataset.blockId:selector==='[data-production-comment-text]'?'productionCommentText' in n.dataset:selector.includes('.comment-flash')?n.classes.has('comment-flash'):n.classes.has('comment-mark'))}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null}
 getAttribute(){return null}
 removeAttribute(key){if(key==='data-production-comment-text')delete this.dataset.productionCommentText}
 getClientRects(){for(let n=this;n;n=n.parentElement)if(n.hidden||n.tagName==='DETAILS'&&!n.open)return [];return [{}]}
 closest(){return null}
 normalize(){for(const n of this.children)n.normalize();for(let i=this.children.length-1;i>0;i--)if(this.children[i].tagName==='#TEXT'&&this.children[i-1].tagName==='#TEXT'){this.children[i-1].ownText+=this.children[i].ownText;this.children.splice(i,1)}}
 replaceWith(...nodes){const p=this.parentElement,i=p.children.indexOf(this);for(const n of nodes)n.parentElement=p;p.children.splice(i,1,...nodes)}
 scrollIntoView(){this.scrolled=true}
}
function fixture(blocks=[{id:'prompt',text:'前文🐍，No hanging rope, no post bindings. 后文'}]){
 const root=new Node('main'),record={id:'exact',object_id:'call',kind:'CALL',payload:{blocks}},ctx={state:{productionSelected:record,comments:[]},CSS:{escape:s=>s},$:s=>s==='#production-reader'?root:null,isProduction:()=>true,renderComments(){},paintStructureRegions(){},el:(tag,cls,text)=>{const n=new Node(tag);if(cls)for(const c of cls.split(' '))n.classes.add(c);if(text)n.append(new Node('#text',text));return n},document:{querySelector:()=>root,querySelectorAll:s=>root.querySelectorAll(s),createTextNode:s=>new Node('#text',s),createTreeWalker:n=>{const leaves=n.all().filter(x=>x.tagName==='#TEXT');let i=0;return {nextNode:()=>leaves[i++]||null}}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8'),ctx);
 const surface=(revision='exact',values=blocks)=>{const host=new Node('div');host.dataset.productionBlocks=revision;for(const b of values){const p=new Node('pre');p.dataset.blockId=b.id;if(b.offset!==undefined)p.dataset.anchorOffset=b.offset;p.append(new Node('#text',b.text));host.append(p)}root.append(host);return host};
 const comment=(a={})=>({id:'opinion',target_object_id:'call',target_revision_id:'exact',body:'review',status:'OPEN',anchor:{type:'text',block_id:'prompt',start:4,end:38,...a}});
 return {ctx,root,record,surface,comment};
}
test('exact visible card wins over hidden duplicates and another object with the same block name',()=>{
 const f=fixture(),hidden=f.surface(),wrong=f.surface('other'),shown=f.surface();hidden.hidden=true;
 const c=f.comment();f.ctx.state.comments=[c];f.ctx.state.selected=c.id;f.ctx.paintProductionReview();
 assert.equal(shown.querySelector('.comment-mark').textContent,'No hanging rope, no post bindings.');assert.equal(hidden.querySelector('.comment-mark'),null);assert.equal(wrong.querySelector('.comment-mark'),null);assert.equal(shown.textContent,f.record.payload.blocks[0].text);
 f.ctx.locateProductionComment(c,true);assert.equal(shown.querySelector('.comment-mark').scrolled,true);
});
test('a hidden same-block child cannot supply the selected character range',()=>{
 const f=fixture(),host=f.surface();host.children[0].hidden=true;assert.equal(f.ctx.productionCommentTextSurface(f.comment()),null);
});
test('continuous paragraphs paint both ends; valid single-block legacy ranges omit end_block_id',()=>{
 const f=fixture([{id:'a',text:'甲🐍乙'},{id:'b',text:'丙丁戊'}]),host=f.surface(),c=f.comment({block_id:'a',end_block_id:'b',start:1,end:2});f.ctx.paintProductionCommentText(c);
 assert.deepEqual(host.querySelectorAll('.comment-mark').map(n=>n.textContent),['🐍乙','丙丁']);assert.equal(host.textContent,'甲🐍乙丙丁戊');
});
test('segmented opinions paint only their exact passages, including reordered same-block ranges',()=>{
 const f=fixture([{id:'a',text:'甲🐍乙'},{id:'gap',text:'未选拆镜'},{id:'b',text:'丙丁戊'}]),host=f.surface();
 const segments=[{block_id:'b',end_block_id:'b',start:0,end:2,quote:'丙丁'},{block_id:'a',end_block_id:'a',start:1,end:2,quote:'🐍'}];
 const c=f.comment({block_id:'b',end_block_id:'a',start:0,end:2,quote:'丙丁\n🐍',segments});
 f.ctx.paintProductionCommentText(c);assert.deepEqual(host.querySelectorAll('.comment-mark').map(n=>n.textContent),['🐍','丙丁']);
 assert.equal(host.children[1].querySelector('.comment-mark'),null);
});
test('continuous segmented Prompt highlights actual paragraphs; omitted gaps require full Prompt',()=>{
 const f=fixture([{id:'prompt',text:'甲乙\n丙丁\n隐藏\n戊己'}]),excerpt=f.surface('exact',[{id:'prompt',text:'甲乙',offset:0},{id:'prompt',text:'丙丁',offset:3}]),full=f.surface();
 const c=f.comment({start:1,end:5});assert.equal(f.ctx.productionCommentTextSurface(c),excerpt);f.ctx.paintProductionCommentText(c);assert.deepEqual(excerpt.querySelectorAll('.comment-mark').map(n=>n.textContent),['乙','丙丁']);
 assert.equal(f.ctx.productionCommentTextSurface(f.comment({start:1,end:11})),full);
});
test('invalid old character ranges get a block cue without inventing a quoted selection',()=>{
 const f=fixture(),host=f.surface();f.ctx.paintProductionCommentText(f.comment({start:null,end:null}));assert.equal(host.querySelector('.comment-mark'),null);assert.equal(host.children[0].classes.has('comment-flash'),true);
});
test('native saved text anchors without an explicit type remain exact after reopening',()=>{
 const f=fixture(),host=f.surface(),c=f.comment();delete c.anchor.type;delete c.anchor.end_block_id;
 f.ctx.state.comments=[c];f.ctx.paintProductionCommentText(c);assert.equal(host.querySelector('.comment-mark').textContent,'No hanging rope, no post bindings.');f.ctx.locateProductionComment(c,true);assert.equal(host.querySelector('.comment-mark').scrolled,true);
});
test('inline scene action uses the visible production view without a standalone production reader',()=>{
 const f=fixture([{id:'prompt',text:'技术\n接回歌本。'}]),host=f.surface('exact',[{id:'prompt',offset:3,text:'接回歌本。'}]),c=f.comment({type:undefined,start:3,end:8});
 f.ctx.document.querySelector=s=>s==='#production-view'?f.root:null;f.ctx.state.comments=[c];assert.equal(f.ctx.locateProductionComment(c,true),true);assert.equal(host.querySelector('.comment-mark').textContent,'接回歌本。');
});
test('inline reference links retain their identity and handlers across repeated paints',()=>{
 const f=fixture([{id:'prompt',text:'甲参考🐍乙'}]),host=f.surface(),p=host.children[0],link=new Node('a'),handler=()=>{};link.onclick=handler;link.append(new Node('#text','参考🐍'));p.children=[];p.append(new Node('#text','甲'),link,new Node('#text','乙'));
 for(let i=0;i<4;i++)f.ctx.paintProductionCommentText(f.comment({start:1,end:4}));
 assert.equal(p.children.includes(link),true);assert.equal(link.onclick,handler);assert.equal(p.textContent,'甲参考🐍乙');assert.equal(link.querySelector('.comment-mark').textContent,'参考🐍');assert.ok(p.all().length<12);
});
