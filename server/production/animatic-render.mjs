import {spawn} from 'node:child_process';
import {copyFile,lstat,mkdir,mkdtemp,readFile,realpath,writeFile,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {hash as sha256} from '../shared/contracts.mjs';
import {fileSha} from '../transfer.mjs';
import {animaticSchedule,validateAnimaticTimeline} from './animatic-model.mjs';

export function animaticProcess(command,args,{timeout=10*60*1000}={}){return new Promise((resolve,reject)=>{
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});const out=[],err=[];let size=0,settled=false;const timer=setTimeout(()=>{child.kill('SIGKILL');settled=true;reject(Error('预演渲染超时；未自动重试'));},timeout);
 child.stdout.on('data',b=>{size+=b.length;if(size>4*1024*1024)child.kill('SIGKILL');else out.push(b);});child.stderr.on('data',b=>{if(err.reduce((n,x)=>n+x.length,0)<16384)err.push(b);});child.once('error',e=>{clearTimeout(timer);settled=true;reject(e);});child.once('exit',code=>{clearTimeout(timer);if(settled)return;if(code!==0)return reject(Error(`${command} 未完成（${code}）：${Buffer.concat(err).toString('utf8').slice(-2000)}`));resolve(Buffer.concat(out).toString('utf8'));});
 });}
const filterPath=value=>value.replaceAll('\\','\\\\').replaceAll(':','\\:').replaceAll("'","\\'");
/** Deterministic rendering is called only inside a managed worker process. */
export async function renderAnimatic({request,object,inputs,outputDirectory,run=animaticProcess}){
 const content=validateAnimaticTimeline(object.revision.content.timeline);
 if(content.shots.some(s=>!s.panels.length))throw Error('缺少粗分镜');
 const work=await mkdtemp(path.join(outputDirectory,'render-')),files=new Map();
 const assertHeld=async()=>{for(const input of inputs)for(const media of input.media||[])if(await fileSha(media.filename)!==media.sha256)throw Error('渲染输入原件 SHA 已变化');};
 try{
 if(content.cards.length&&!/\bdrawtext\b/.test(await run('ffmpeg',['-hide_banner','-filters'])))throw Error('FFmpeg 缺少 drawtext 字体排版能力');
 for(const [index,input] of inputs.entries()){
  const media=(input.media||[]).filter(m=>m.availability==='PRESENT');
  if(media.length!==1)throw Error('每个预演素材版本须有一份精确原件');
  const source=media[0];const ext=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','audio/wav':'.wav','audio/x-wav':'.wav','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/flac':'.flac','font/ttf':'.ttf','font/otf':'.otf','application/x-font-ttf':'.ttf','application/vnd.ms-opentype':'.otf'})[source.mime_type];
  if(!ext)throw Error('预演输入格式不在白名单');
  const info=await lstat(source.filename);if(!info.isFile()||info.isSymbolicLink()||await fileSha(source.filename)!==source.sha256)throw Error('预演原件 SHA 不符');
  const file=path.join(work,`input-${index}${ext}`);await copyFile(source.filename,file,constants.COPYFILE_EXCL);files.set(input.id,file);
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
  const source=files.get(clip.media.versionId);if(!source)throw Error('声音输入未冻结');const probe=JSON.parse(await run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',source]));if(!Number.isFinite(Number(probe.format?.duration))||Number(probe.format.duration)+1/24<(clip.sourceInFrames+clip.durationFrames)/24)throw Error('声音片段超过实际源文件时长或时长无法核验');
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
 await assertHeld();
 const destination=path.join(outputDirectory,'preview.mp4');await copyFile(rendered,destination,constants.COPYFILE_EXCL);
 return {outputs:[{file:'preview.mp4',sha256:await fileSha(destination),mimeType:'video/mp4',title:'场级预演候选',description:'由精确时间线和已核验原件渲染，尚未观察或采用。'}],frameCount:schedule.totalFrames,fps:24,width:1920,height:1080,renderer:'ffmpeg',renderPurpose:'REVIEW_PREVIEW',observed:false};
 }finally{await rm(work,{recursive:true,force:true});}
}
