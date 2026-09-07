import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url)),softwareRoot=path.resolve(here,'..');
const require=createRequire(path.join(softwareRoot,'package.json')),ts=require('typescript');
let store=await readFile(path.join(softwareRoot,'app/api/v8/_store.ts'),'utf8');
let unit=store.slice(store.indexOf('export function errorResponse'));unit=unit.slice(0,unit.indexOf('\n}\n')+3);
assert(unit.includes("reason.code === 'MEDIA_PURGED'"), 'Actual installed source must implement retirement response mapping');
const transpile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
class HttpError extends Error{constructor(status,message,details){super(message);this.status=status;this.details=details;}}
const jsonResponse=(value,init={})=>Response.json(value,{...init,headers:{'Cache-Control':'no-store',...(init.headers||{})}});
const unitExports={};new Function('exports','HttpError','jsonResponse','console',transpile(unit))(unitExports,HttpError,jsonResponse,{error(){}});
const errorResponse=unitExports.errorResponse,privateSentinel='PRIVATE:/instance/media/blobs/secret-media-sha-and-path';
const repositoryError=code=>Object.assign(new Error(privateSentinel),{code,details:{httpStatus:410,retirement:{state:'PURGED',media:{relativePath:privateSentinel},tombstone:{private:privateSentinel}}}});
const cases=[];
async function safeResult(response,expected,label){
 assert.equal(response.status,expected,label);const text=await response.text();assert(!text.includes(privateSentinel),'private retirement details leaked');assert(!text.includes('retirement'),'retirement object leaked');assert(!text.includes('relativePath'),'private path field leaked');cases.push(label);
}
await safeResult(errorResponse(repositoryError('MEDIA_PURGED'),'generic failure'),410,'unit exact PURGED');
await safeResult(errorResponse(repositoryError('MEDIA_RETIRED'),'generic failure'),409,'unit pending or quarantined');
await safeResult(errorResponse(repositoryError('UNEXPECTED_FAILURE'),'generic failure'),500,'unit unrelated exception not retired');
await safeResult(errorResponse({code:'MEDIA_PURGED',details:{privateSentinel}},'generic failure'),500,'unit non-error object not retired');
await safeResult(errorResponse(new HttpError(404,'Not found')),404,'unit unknown identity');
await safeResult(errorResponse(new SyntaxError('bad')),400,'unit syntax remains400');
async function route(relative,behavior){
 const source=await readFile(path.join(softwareRoot,relative),'utf8'),module={exports:{}};
 const forbidden=()=>{throw Error('Actual media bytes must never be read in these error-path fixtures');};
 const mockedStore={errorResponse,HttpError,jsonResponse,hostedReadOnlyMode:()=>false,instanceMode:()=>true,
 instanceRepository:async()=>({resolveMedia:async()=>{if(behavior==='unknown')return null;throw repositoryError(behavior);}}),
 safeGeneratedPath:forbidden,hashStableFile:forbidden,
 reviewData:async()=>({productionModel:{assetVersions:[]}}),listAllEvents:async()=>[],
 mediaToken:id=>'m_'+createHash('sha256').update(id).digest('base64url').slice(0,28)};
 const mockedRequire=specifier=>{
  if(specifier.endsWith('/_store'))return mockedStore;
  if(specifier.endsWith('/_media-read'))return{withInstanceMediaRead:async operation=>operation()};
  if(specifier==='node:fs')return{createReadStream:forbidden};
  if(specifier==='node:fs/promises')return{stat:forbidden};
  if(specifier==='node:stream')return{Readable:{toWeb:forbidden}};
  if(specifier==='node:path')return path;
  throw Error('Unexpected module '+specifier);
 };
 new Function('require','module','exports',transpile(source))(mockedRequire,module,module.exports);return module.exports;
}
for(const [relative,params]of [
 ['app/media/[...path]/route.ts',{path:['audio','retired.mp3']}],
 ['app/review-audio/[filename]/route.ts',{filename:'retired.mp3'}]
]){
 for(const [behavior,status]of [['unknown',404],['MEDIA_PURGED',410],['MEDIA_RETIRED',409],['DATABASE_UNAVAILABLE',500]]){
  const api=await route(relative,behavior);
  for(const method of ['GET','HEAD'])await safeResult(await api[method](new Request('http://localhost:3000/test',{method}),{params:Promise.resolve(params)}),status,relative+' '+method+' '+behavior);
 }
}
const tokenApi=await route('app/api/v8/media/[token]/route.ts','unknown');
for(const token of ['invalid','m_0000000000000000000000000000'])for(const method of ['GET','HEAD'])await safeResult(await tokenApi[method](new Request('http://localhost:3000/test',{method}),{params:Promise.resolve({token})}),404,'v8 '+method+' unknown token');
console.log(JSON.stringify({status:'PASS',unitAndApiCases:cases.length,mediaByteReads:0,networkRequests:0,databaseWrites:0,filesystemWrites:0}));
