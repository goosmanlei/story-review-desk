const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const cue={attrs:{},number:null,querySelector(){return this.number},setAttribute(k,v){this.attrs[k]=v}},host={dataset:{reviewKind:'text',productionBlocks:'r'},querySelector:s=>s.includes('review-cue')?cue:null,querySelectorAll:()=>[{dataset:{blockId:'body'}}],closest:()=>null};
 const ctx={state:{comments:[]},document:{addEventListener(){},querySelectorAll:()=>[host]},isProduction:()=>false,commentTarget:()=>({target_revision_id:'r'}),nodeText:(_t,_c,text,c)=>{const n={textContent:text,remove(){c.number=null}};c.number=n;return n}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8'),ctx);return {ctx,cue,host};
}
test('visible block number and its existing list share scope after edits, close/reopen, deletion and revision switch',()=>{
 const {ctx,cue,host}=fixture();const c=(id,r='r',status='OPEN')=>({id,target_revision_id:r,status,anchor:{type:'text',block_id:'body'}});
 ctx.paintReviewCommentCounts();assert.equal(cue.number,null);assert.equal(cue.attrs['aria-label'],'查看此块全部评论');
 ctx.state.comments=[c('one'),c('two','r','CLOSED'),c('one'),c('other','old')];ctx.paintReviewCommentCounts();assert.equal(cue.number.textContent,2);
 assert.equal(ctx.reviewBlockComments(ctx.state.comments,ctx.reviewBlockScope(host,'text')).length,2);
 ctx.state.comments[0].body='edited';ctx.state.comments[0].status='CLOSED';ctx.paintReviewCommentCounts();assert.equal(cue.number.textContent,2);
 ctx.state.comments=ctx.state.comments.filter(c=>c.id!=='one');ctx.paintReviewCommentCounts();assert.equal(cue.number.textContent,1);
 host.dataset.productionBlocks='old';ctx.paintReviewCommentCounts();assert.equal(cue.number.textContent,1);
 host.dataset.productionBlocks='empty';ctx.paintReviewCommentCounts();assert.equal(cue.number,null);
});
test('reference scopes use exactly the quoted revision even when an outer round has carried versions',()=>{
 const {ctx,host}=fixture();ctx.isProduction=()=>true;ctx.isEntityReview=()=>false;ctx.productionTextBlocks=()=>[{id:'body'}];
 ctx.state.productionSelected={id:'r'};ctx.state.materialReview={selectedMaterialRounds:{need:1}};ctx.materialVersions=()=>({need:[{number:1,members:[{id:'r',object_id:'asset'},{id:'other',object_id:'asset'}]}]});
 host.closest=s=>s==='.material-reference-dialog'?{}:null;const scope=ctx.reviewBlockScope(host,'text');assert.deepEqual(Array.from(scope.revisions),['r']);assert.equal(scope.materialId,null);
});
test('nested reference sessions return the panel and outer pending draft without borrowing material context',()=>{
 class N{constructor(){this.children=[];this.listeners={};this.hidden=false}append(n){n.parentNode?.children.splice(n.parentNode.children.indexOf(n),1);this.children.push(n);n.parentNode=this}insertBefore(n,next){this.append(n);if(next){this.children.pop();this.children.splice(this.children.indexOf(next),0,n)}}addEventListener(k,f){this.listeners[k]=f}querySelector(){return null}}
 const root=new N(),outer=new N(),inner=new N(),panel=new N();root.append(panel);panel.hidden=true;
 const old={productionSelected:{id:'outer'},anchor:{type:'time'},pending:{body:'outer draft'},reviewCommentScope:{revision:'outer'}};
 const panelStates=[],saved=[];
 const ctx={state:{...old},document:{querySelector:()=>panel},rememberProductionDraft(){saved.push(ctx.state.productionSelected.id)},paintProductionReview(){},renderComments(){},setPanelOpen(open){panelStates.push(open);panel.hidden=!open}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),ctx);
 const first=ctx.referenceReviewSession(outer,{record:{id:'first'}});first.focus();assert.equal(panel.parentNode,outer);ctx.state.pending={body:'inner draft'};
 const second=ctx.referenceReviewSession(inner,{record:{id:'second'}});second.focus();assert.equal(panel.parentNode,inner);inner.listeners.close();assert.equal(panel.parentNode,outer);assert.equal(ctx.state.productionSelected.id,'first');assert.equal(ctx.state.pending.body,'inner draft');
 outer.listeners.close();assert.equal(panel.parentNode,root);assert.equal(panel.hidden,true);assert.equal(ctx.state.pending,old.pending);assert.equal(ctx.state.anchor,old.anchor);assert.equal(ctx.state.reviewCommentScope,old.reviewCommentScope);assert.deepEqual(panelStates,[false,false]);
 assert.deepEqual(saved,['second','first']);
});
