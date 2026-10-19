const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/editing.js'),'utf8');
const plain=v=>JSON.parse(JSON.stringify(v));
function helpers(){const c={};vm.createContext(c);vm.runInContext(source,c);return c;}
const project={spec:{fps:{num:24,den:1},duration_frames:6838}};
test('integer frames survive millisecond round trips, including the real end and fractional frame rates',()=>{
 const c=helpers();assert.equal(c.editTime(project,492),'0:20.500');assert.equal(c.editTime(project,714),'0:29.750');assert.equal(c.editTime(project,6838),'4:44.917');
 for(const fps of [{num:24,den:1},{num:30000,den:1001},{num:24000,den:1001}]){
  const p={spec:{...project.spec,fps}};for(let i=0;i<=6838;i++)assert.equal(c.editParseTime(p,c.editTime(p,i)),i);
 }
 for(const text of ['', 'NaN','-1','1:60','1.1234','1x'])assert.equal(c.editParseTime(project,text),null);
});
test('half-open intersections keep track and element type identity, and reject empty/invalid selections',()=>{
 const c=helpers(),review={tracks:[{key:'track:picture',title:'画面'},{key:'text:subtitles',title:'字幕'}],elements:[
  {track_key:'track:picture',element_type:'clip',element_id:'same',start_frame:0,end_frame:492},
  {track_key:'track:picture',element_type:'clip',element_id:'next',start_frame:492,end_frame:714},
  {track_key:'text:subtitles',element_type:'subtitle',element_id:'same',start_frame:492,end_frame:714}]};
 assert.deepEqual(plain(c.editIntersections(review,{start:492,end:714,tracks:['text:subtitles']})).map(e=>e.element_type),['subtitle']);
 assert.equal(c.editRangeIssue(project,review,{start:492,end:714,tracks:['track:picture','text:subtitles']}),'');
 for(const range of [{start:0,end:0,tracks:['track:picture']},{start:null,end:492,tracks:['track:picture']},{start:-1,end:492,tracks:['track:picture']},{start:0,end:6839,tracks:['track:picture']},{start:0,end:10,tracks:[]},{start:714,end:715,tracks:['track:picture']}])assert.ok(c.editRangeIssue(project,review,range));
});
test('review reload never reads, applies, removes or overwrites legacy engineering drafts',async()=>{
 const oldKey='episode-edit:/:episode',storage=new Map([[oldKey,'{"basis":"old","draft":{"title":"unsaved work"}}']]),reads=[],writes=[];
 const host={querySelector:()=>null,replaceChildren(){}},c={URL,location:{href:'http://fixture/?edit_episode=episode',pathname:'/'},state:{workspace:'settings.workspace'},productionReadEpoch:0,productionTab:()=> 'editing',renderComments(){},productionTabs(){},nodeText(){},$:()=>host,toast(){},api:async()=>({episodes:[{id:'episode'}],projects:[],outputs:[]}),document:{querySelector:()=>null},localStorage:{getItem:k=>{reads.push(k);return storage.get(k)||null},setItem:(k,v)=>{writes.push(k);storage.set(k,v)}}};
 c.history={replaceState:(_a,_b,url)=>{c.location.href=String(url)}};vm.createContext(c);vm.runInContext(source,c);vm.runInContext('renderEpisodeEditing=ctx=>editRemember(ctx)',c);
 for(let i=0;i<3;i++)await c.loadEpisodeEditing();assert.equal(storage.get(oldKey),'{"basis":"old","draft":{"title":"unsaved work"}}');assert.ok(!reads.includes(oldKey));assert.ok(!writes.includes(oldKey));
});
