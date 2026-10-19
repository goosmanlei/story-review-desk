const {test}=require('node:test'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../review_desk/static/');
const sources=Object.fromEntries(['review-ui.js','methods.js'].map(name=>[name,fs.readFileSync(root+name,'utf8')]));
class Element{
 constructor(tag,cls){this.tagName=tag.toUpperCase();this.className=cls;this.children=[];this.dataset={};this.isConnected=true;this.events=new Map();this.failures=[];
  for(const name of ['error','load','loadedmetadata','play','pause','timeupdate'])Object.defineProperty(this,'on'+name,{get:()=>this.events.get(name)?.find(x=>x.property)?.fn,set:fn=>{const list=(this.events.get(name)||[]).filter(x=>!x.property);list.push({fn,property:true});this.events.set(name,list)}});
  if(['AUDIO','VIDEO'].includes(this.tagName)){this.currentTime=0;this.paused=true;this.play=()=>{this.paused=false;this.dispatch('play');return Promise.resolve()};this.pause=()=>{this.paused=true;this.dispatch('pause')};this.load=()=>{this.loadCalls=(this.loadCalls||0)+1;this.error=null;this.currentTime=0;this.paused=true}}
 }
 setConnected(value){this.isConnected=value;for(const child of this.children)child.setConnected(value)}
 remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null}this.setConnected(false)}
 append(...children){for(const child of children){if(child.parentElement)child.remove();child.parentElement=this;child.setConnected(this.isConnected);this.children.push(child)}}
 replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children)}
 addEventListener(name,fn,options={}){const list=this.events.get(name)||[];list.push({fn,once:options.once});this.events.set(name,list)}
 dispatch(name){for(const row of [...(this.events.get(name)||[])]){try{row.fn({type:name,target:this})}catch(e){this.failures.push(e.name+': '+e.message)}if(row.once)this.events.set(name,(this.events.get(name)||[]).filter(x=>x!==row))}}
 all(){return [this,...this.children.flatMap(x=>x.all())]}
}
function fixture(){const ctx={URL,URLSearchParams,location:{href:'https://review.example/lijizhanshe/'},window:{addEventListener(){}},document:{body:{}},state:{},reviewURL:value=>value.startsWith('/')&&!value.startsWith('/lijizhanshe/')?'/lijizhanshe'+value:value,el:(tag,cls)=>new Element(tag,cls)};
 ctx.nodeText=(tag,cls,text,parent)=>{const node=new Element(tag,cls);node.textContent=text;parent?.append(node);return node};
 vm.createContext(ctx);for(const [name,text]of Object.entries(sources))vm.runInContext(text,ctx,{filename:name});return ctx}
function original(mime){const ctx=fixture(),parent=new Element('section');ctx.renderMethodOriginal(parent,{media:{mime},file:'example.'+(mime.startsWith('image')?'png':'mp4'),file_version:{version:1},record:{object_id:'method-id'}});return {ctx,parent,media:parent.children[0]}}
function linked(){const ctx=fixture(),article=new Element('article'),parent=new Element('p');article.append(parent);ctx.methodLink(null,{file:'SKILL.md',record:{object_id:'method-id',revision_id:'exact-r1',payload:{source:{}}}},{href:'example.png',text:'example'},parent);return {ctx,parent:article,media:article.all().find(x=>x.tagName==='IMG')}}

for(const [name,build] of [['image-file',()=>original('image/png')],['image-link',linked],['video-file',()=>original('video/mp4')]])test(name,()=>{
 const f=build(),before=f.media.src;f.media.error={code:2};f.media.dispatch('error');
 assert.equal(f.parent.all().filter(x=>x.className==='production-issue').length,1);
 assert.notEqual(f.media.src,before);f.media.dispatch(f.media.tagName==='IMG'?'load':'loadedmetadata');
 assert.deepEqual(f.media.failures,[]);assert.deepEqual(f.parent.all().filter(x=>x.className==='production-issue'),[]);
 assert.equal(typeof f.media.load==='function',f.media.tagName!=='IMG');
});
test('download retains exact reference query and deployment prefix',()=>{
 const download=fixture().reviewDownloadURL('/api/methods/file-media?object_id=exact&file=example.png&version=2','chosen.png');
 assert.equal(new URL(download).pathname,'/lijizhanshe/api/methods/file-media');
 assert.deepEqual(Object.fromEntries(new URL(download).searchParams),{object_id:'exact',file:'example.png',version:'2',download:'1',filename:'chosen.png'});
});
