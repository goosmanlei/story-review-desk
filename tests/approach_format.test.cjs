const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Node{
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.events={};this.attributes={}}
 append(node){this.children.push(node)}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,fn){this.events[name]=fn}
}
function fixture(){
 const context={URL,location:{href:'http://fixture/?workspace=production.approach'},document:{addEventListener(){},createTextNode:text=>new Node('#text',text)},window:{addEventListener(){}},el:(tag,cls)=>new Node(tag),nodeText:(tag,cls,text,parent)=>{const n=new Node(tag,text);parent.append(n);return n}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/approach.js'),'utf8'),context);return context;
}
function text(node){return node.textContent+node.children.map(text).join('')}
test('rich text never interprets HTML, loads media or creates executable links',()=>{
 const c=fixture(),p=new Node('p');
 c.approachInline(p,'<img src="https://private.invalid/a"> **强调** `原样` [危险](javascript:alert) [安全](https://example.org/method)');
 assert.equal(text(p),'<img src="https://private.invalid/a"> 强调 原样 [危险](javascript:alert) 安全');
 const links=p.children.filter(n=>n.tag==='a');assert.equal(links.length,1);assert.equal(links[0].href,'https://example.org/method');assert.equal(links[0].rel,'noopener noreferrer');assert.equal(p.children.some(n=>n.tag==='img'),false);
});
test('prompts preserve newlines and literal syntax while tables retain labelled cells',()=>{
 const c=fixture(),root=new Node('section'),prompt='0—2 秒：原样\n  <speaker> "$value"\n**不是强调**';
 c.renderApproachBlocks(root,[{type:'code',text:prompt},{type:'list',ordered:true,items:['第一项','第二项']},{type:'table',columns:['条件','选择'],rows:[['图 1','`输入`']]}],'完整示例');
 assert.equal(root.children[0].tag,'pre');assert.equal(text(root.children[0]),prompt);assert.equal(root.children[1].tag,'ol');
 const row=root.children[2].children.at(-1).children[0];assert.equal(row.children[1].dataset.label,'选择');assert.equal(text(row.children[1]),'输入');
});
test('declared media uses local controls and pauses other method playback',()=>{
 const c=fixture(),root=new Node('section');let pauses=0;
 root.closest=()=>({querySelectorAll:()=>[root.children[1].children[0],{pause(){pauses++}}]});
 c.renderApproachBlocks(root,[{type:'media',kind:'image',file:'reference.png',caption:'<reference>',width:1672,height:941},{type:'media',kind:'video',file:'demo.mp4',caption:'动作示例',width:1280,height:720}],'示例');
 const image=root.children[0].children[0],video=root.children[1].children[0];
 assert.equal(image.src,'/approach-media/reference.png');assert.equal(image.alt,'<reference>');
 assert.equal(image.width,1672);assert.equal(image.height,941);assert.equal(video.width,1280);assert.equal(video.height,720);
 assert.equal(text(root.children[0]),'<reference>');assert.equal(video.controls,true);assert.equal(video.preload,'metadata');assert.equal(video.autoplay,undefined);
 video.events.play();assert.equal(pauses,1);
});
