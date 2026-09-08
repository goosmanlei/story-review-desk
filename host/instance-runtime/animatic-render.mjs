import {spawn} from 'node:child_process';
import {copyFile,lstat,mkdir,mkdtemp,readFile,realpath,writeFile,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {sha256} from './bytes.mjs';
import {readRegisteredMediaBytes} from './media-read-lease.mjs';
import {animaticSchedule,validateAnimaticTimeline} from './animatic-model.mjs';

export function animaticProcess(command,args,{timeout=10*60*1000}={}){return new Promise((resolve,reject)=>{
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});const out=[],err=[];let size=0,settled=false;const timer=setTimeout(()=>{child.kill('SIGKILL');settled=true;reject(Error('预演渲染超时；未自动重试'));},timeout);
 child.stdout.on('data',b=>{size+=b.length;if(size>4*1024*1024)child.kill('SIGKILL');else out.push(b);});child.stderr.on('data',b=>{if(err.reduce((n,x)=>n+x.length,0)<16384)err.push(b);});child.once('error',e=>{clearTimeout(timer);settled=true;reject(e);});child.once('exit',code=>{clearTimeout(timer);if(settled)return;if(code!==0)return reject(Error(`${command} 未完成（${code}）：${Buffer.concat(err).toString('utf8').slice(-2000)}`));resolve(Buffer.concat(out).toString('utf8'));});
 });}
const filterPath=value=>value.replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'","\\'");
async function confinedOutput(root,relative){if(!relative.startsWith('media/_review_pending/')||!relative.endsWith('.mp4')||/[\\\0]/.test(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('预演输出路径未通过白名单');const canonical=await realpath(root);if(canonical!==path.resolve(root))throw Error('实例根目录不是规范路径');let cursor=canonical;for(const part of relative.split('/').slice(0,-1)){cursor=path.join(cursor,part);await mkdir(cursor,{recursive:true});const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(cursor)!==cursor)throw Error('输出目录必须为实例内普通目录');}return path.join(canonical,relative);}
/** Invoked exclusively by the controlled worker while holding a shared media lease. */
export async function renderAnimatic({repository,instanceRoot,job,content,assertHeld=async()=>{},run=animaticProcess}){
 content=validateAnimaticTimeline(content);if(content.shots.some(s=>!s.panels.length))throw Error('缺少粗分镜');if(!/^animatic_render_[A-Za-z0-9-]+$/.test(job.jobId||''))throw Error('渲染任务身份无效');const root=await realpath(instanceRoot);if(root!==path.resolve(instanceRoot))throw Error('实例根目录不规范');let scratch=root;for(const part of ['scratch','animatic']){scratch=path.join(scratch,part);await mkdir(scratch,{recursive:true});if((await lstat(scratch)).isSymbolicLink()||await realpath(scratch)!==scratch)throw Error('渲染缓存目录不能经过符号链接');}const work=await mkdtemp(path.join(scratch,job.jobId+'-')),files=new Map();
 try{
 for(const [index,binding] of job.inputBindings.entries()){
  await assertHeld();const media=await repository.readTransaction(tx=>tx.getMedia(binding.familyId,binding.versionId));if(!media||media.sha256!==binding.sha256||media.relativePath!==binding.relativePath)throw Error('渲染输入版本已变化');const bytes=await readRegisteredMediaBytes(instanceRoot,media);const ext=path.extname(media.relativePath).toLowerCase();if(!['.png','.jpg','.jpeg','.webp','.wav','.mp3','.m4a','.flac','.ttf','.otf'].includes(ext))throw Error('预演输入格式不在白名单');const file=path.join(work,`input-${index}${ext}`);await writeFile(file,bytes,{flag:'wx'});files.set(binding.versionId,file);
 }
 const schedule=animaticSchedule(content),segments=[];let segmentIndex=0;
 for(const shot of content.shots)for(const panel of shot.panels){
  await assertHeld();const source=files.get(panel.media.versionId);if(!source)throw Error('粗分镜输入未冻结');const frames=panel.endFrame-panel.startFrame,file=path.join(work,`panel-${segmentIndex++}.mp4`);
  const zoom=panel.motion==='PUSH_IN'?`1+0.08*on/${Math.max(1,frames-1)}`:panel.motion==='PULL_OUT'?`1.08-0.08*on/${Math.max(1,frames-1)}`:'1';
  const filter=`scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x1080:fps=24,setsar=1,format=yuv420p`;
  await run('ffmpeg',['-nostdin','-v','error','-loop','1','-i',source,'-vf',filter,'-frames:v',String(frames),'-r','24','-an','-c:v','libx264','-preset','veryfast','-crf','23','-n',file]);segments.push(file);
 }
 const list=path.join(work,'cuts.txt');await writeFile(list,segments.map(file=>`file '${filterPath(file)}'`).join('\n')+'\n',{flag:'wx'});const base=path.join(work,'cuts.mp4');await run('ffmpeg',['-nostdin','-v','error','-f','concat','-safe','0','-i',list,'-c','copy','-n',base]);
 const args=['-nostdin','-v','error','-i',base],filters=[],audioLabels=[];let audioIndex=1;
 for(const clip of content.audio.filter(a=>!a.muted&&a.volume>0)){
  const source=files.get(clip.media.versionId);if(!source)throw Error('声音输入未冻结');const probe=JSON.parse(await run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',source]));if(Number(probe.format?.duration)+1/24<(clip.sourceInFrames+clip.durationFrames)/24)throw Error('声音片段超过实际源文件时长');
  args.push('-i',source);const start=schedule.shots.find(s=>s.shotId===clip.anchorShotId).startFrame+clip.offsetFrames,label=`a${audioIndex}`;
  filters.push(`[${audioIndex}:a]atrim=start=${clip.sourceInFrames/24}:duration=${clip.durationFrames/24},asetpts=PTS-STARTPTS,volume=${clip.volume},adelay=${Math.round(start*1000/24)}:all=1[${label}]`);audioLabels.push(`[${label}]`);audioIndex++;
 }
 let video='0:v';for(const [index,card] of content.cards.entries()){
  const font=files.get(card.fontMedia.versionId);if(!font)throw Error('人物卡字体未冻结');const file=path.join(work,`card-${index}.txt`);await writeFile(file,card.textLines.join('\n'),{flag:'wx'});const start=schedule.shots.find(s=>s.shotId===card.shotId).startFrame+card.startFrame,end=start+card.endFrame-card.startFrame,label=`v${index}`;
  filters.push(`[${video}]drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(file)}':expansion=none:fontsize=${card.style.fontSize}:fontcolor=${card.style.color}:x=${card.style.x}:y=${card.style.y}:line_spacing=8:enable='gte(n,${start})*lt(n,${end})'[${label}]`);video=label;
 }
 if(audioLabels.length)filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,apad,atrim=duration=${schedule.totalFrames/24}[audio]`);
 if(filters.length)args.push('-filter_complex',filters.join(';'));args.push('-map',video==='0:v'?'0:v':`[${video}]`);if(audioLabels.length)args.push('-map','[audio]','-c:a','aac','-ar','48000');else args.push('-an');
 const rendered=path.join(work,'render.mp4');args.push('-frames:v',String(schedule.totalFrames),'-r','24','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart','-t',String(schedule.totalFrames/24),'-n',rendered);await run('ffmpeg',args);await assertHeld();
 const probe=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=width,height,r_frame_rate,nb_read_frames','-of','json',rendered])),stream=probe.streams?.[0];if(stream?.width!==1920||stream?.height!==1080||stream?.r_frame_rate!=='24/1'||Number(stream?.nb_read_frames)!==schedule.totalFrames)throw Error('渲染成片尺寸、帧率或帧数不匹配');
 for(const binding of job.inputBindings){const media=await repository.readTransaction(tx=>tx.getMedia(binding.familyId,binding.versionId));if(!media||media.sha256!==binding.sha256)throw Error('渲染期间输入登记已变化');await readRegisteredMediaBytes(instanceRoot,media);await assertHeld();}
 const destination=await confinedOutput(instanceRoot,job.expectedOutput.targetPath);await copyFile(rendered,destination,constants.COPYFILE_EXCL);const bytes=await readFile(destination);if(sha256(bytes)!==sha256(await readFile(rendered)))throw Error('渲染候选落盘 SHA 不匹配');await assertHeld();
 return{relativePath:job.expectedOutput.targetPath,sha256:sha256(bytes),byteSize:bytes.length,frameCount:schedule.totalFrames,fps:24,width:1920,height:1080,renderer:'ffmpeg',renderPurpose:'REVIEW_PREVIEW',observed:false};
 }finally{if(await realpath(work)===work&&path.dirname(work)===scratch)await rm(work,{recursive:true,force:true});}
}
