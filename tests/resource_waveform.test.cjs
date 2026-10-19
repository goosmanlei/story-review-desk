const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8');
function fixture(fetch){
 const context={fetch,URL,location:{href:'https://review.example/project/'},window:{addEventListener(){}}};
 vm.createContext(context);vm.runInContext(source,context);return context;
}
test('waveform uses lightweight JSON without application credentials and retains exact query',async()=>{
 const calls=[],value={duration:2.5,peaks:[0,.5,1]};
 const c=fixture(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>value}});
 const target='https://review.example/project/api/methods/file-media?object_id=exact&version=2';
 assert.equal(await c.reviewWaveform(target),value);assert.equal(await c.reviewWaveform(target),value);
 assert.equal(calls.length,1);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.referrerPolicy,'no-referrer');
 assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams),{object_id:'exact',version:'2',variant:'waveform'});
});
test('a failed waveform is evicted so a corrected exact request can be retried',async()=>{
 let calls=0;const c=fixture(async()=>++calls===1?{ok:false}:{ok:true,json:async()=>({duration:1,peaks:[0]})});
 await assert.rejects(c.reviewWaveform('/api/production/files/exact.wav'));
 assert.equal((await c.reviewWaveform('/api/production/files/exact.wav')).duration,1);assert.equal(calls,2);
});
test('waveform JSON rejects invalid time and unbounded or invalid peaks',async()=>{
 for(const value of [{duration:0,peaks:[0]},{duration:1,peaks:[]},{duration:1,peaks:Array(1601).fill(0)},{duration:1,peaks:[-1]},{duration:1,peaks:[Infinity]}]){
  const c=fixture(async()=>({ok:true,json:async()=>value}));await assert.rejects(c.reviewWaveform('/exact.wav'));
 }
});
test('waveform memory cache keeps at most twelve exact requests',async()=>{
 let calls=0;const c=fixture(async()=>{calls++;return {ok:true,json:async()=>({duration:1,peaks:[0]})}});
 for(let n=0;n<13;n++)await c.reviewWaveform('/exact-'+n+'.wav');
 await c.reviewWaveform('/exact-12.wav');assert.equal(calls,13);
 await c.reviewWaveform('/exact-0.wav');assert.equal(calls,14);
});
