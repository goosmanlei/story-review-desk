import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {formatTaskTerminal,wrapTerminalText} from '../tools/task-terminal-format.mjs';
import {renderTasks,cell} from '../tools/task-format.mjs';
import {main} from '../tools/tasks.mjs';
import {fixture,task,legacy} from './task-numbering/fixture.mjs';
const base={id:'T-20260914-aaaaaaaaaaaa',displayId:'T-20260914-001',title:'完整正式标题：人物、场景和组合素材关系',type:'SYSTEM',status:'RUNNING',priority:2,publishedAt:'2026-09-14T02:00:00Z',dependencies:[]};
const data={tasks:[base,{...base,id:'T-20260914-bbbbbbbbbbbb',displayId:'T-20260914-002',type:'CREATIVE',status:'WAITING_REVIEW',dependencies:[base.id,'T-20260914-003']}],asOf:base.publishedAt};
const physical=out=>out.split('\n').filter(l=>l.startsWith('| '));
test('terminal uses real row continuation, keeps all seven columns and full dependencies',()=>{
  const md=renderTasks(data),out=formatTaskTerminal(md,{width:160});
  assert(!out.includes('<br>'));assert(!out.includes('&#95;'));
  const rows=physical(out);assert(rows.every(l=>l.split(' | ').length===7));
  const firstDep=rows.find(l=>l.startsWith('| T-20260914-002'));
  const next=rows[rows.indexOf(firstDep)+1];
  assert(firstDep.includes('T-20260914-001'));assert(next.includes('T-20260914-003'));
  assert(next.startsWith('| '+ ' '.repeat(14)+' |'));
  assert(out.includes('WAITING_REVIEW'));assert(out.includes('CREATIVE'));
  assert(!out.includes('tasks/items/'));
});
test('CJK, combining text and emoji align without losing graphemes at narrow widths',()=>{
  const title='甲乙 Á 👩‍💻 🧑🏽‍🚀 🇨🇳 全角Ａ与繁體字';
  for(const width of [80,100,120,160]) {
    const out=formatTaskTerminal(renderTasks({...data,tasks:[{...base,title}]}),{width});
    const lines=out.split('\n').filter(l=>l.startsWith('|')||l.startsWith('+'));
    assert(lines.every(l=>stringWidth(l)===width),width);
    const body=physical(out).slice(1),parts=body.map(l=>l.slice(2,-2).split(' | ')[1].trimEnd()).join('');
    assert.equal(parts,title);
  }
  assert.deepEqual(wrapTerminalText('甲👩‍💻乙',2),['甲','👩‍💻','乙']);
});
test('trusted breaks are distinct from literal HTML and terminal controls stay visible',()=>{
  const title='<br> &lt;br&gt; | [x] \\ `literal` \u001b[31m红色\u0007';
  const md=renderTasks({...data,tasks:[{...base,title}]});
  const out=formatTaskTerminal(md,{width:240});
  assert(out.includes('<br> &lt;br&gt; | [x] \\ `literal`'));
  assert(out.includes('\\u001b[31m红色\\u0007'));
  assert(!/[\u001b\u0007]/.test(out));
  assert.equal(cell('<br>'),'&lt;br&gt;');
});
test('empty tables retain seven headers and width is explicit and bounded',()=>{
  const out=formatTaskTerminal(renderTasks({tasks:[],asOf:null}),{width:80});
  assert(out.includes('共 0 项'));assert.equal(physical(out).length,1);
  for(const width of [NaN,39,401,100.5])assert.throws(()=>formatTaskTerminal('',{width}),/40到400/);
});
test('CLI text is an adapter of the same filtered, numbered shared result',async t=>{
  const root=await fixture(t),a=task('T-20260914-aaaaaaaaaaaa',base.publishedAt,{title:'完整甲',status:'READY'}),b=task('T-20260914-bbbbbbbbbbbb','2026-09-14T02:00:01Z',{title:'完整乙',status:'DONE',dependencies:[a.id]});
  await legacy(root,[{tasks:[a,b]}]);const query=(...args)=>main(['list','--project',root,...args]);
  const terminal=await query('--all','--format','text','--width','120');
  assert(terminal.includes('完整甲'));assert(terminal.includes('完整乙'));assert(terminal.includes('DONE'));
  assert(!(await query('--format','text')).includes('完整乙'));
  assert.equal((await query('--all')).length,2);
  assert((await query('--all','--format','markdown')).includes('| 任务编号 |'));
  assert((await main(['show','T-20260914-001','--project',root,'--format','text'])).includes('完整甲'));
  assert((await main(['audit','--project',root,'--format','text'])).includes('完整甲'));
  assert((await main(['status','--project',root,'--format','text'])).includes('执行者'));
  await assert.rejects(query('--format','markdown','--width','100'),/width/);
});

import {cp,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import portableWidth from '../tools/vendor/terminal-width/string-width.mjs';
test('carried width implementation agrees with pinned upstream across Unicode clusters',()=>{
  for(const value of ['Latin 正式标题','Á ë','👩‍💻 🧑🏽‍🚀 🇨🇳','각 가','한글 ㄱ','ｶﾞ カナ あ','กํา क्षि','𠀀 〇 Ａ','1️⃣ 1⃣','\u200b\u2060\u0301','\x1b[31m红色\x1b[0m'])
    assert.equal(portableWidth(value),stringWidth(value),JSON.stringify(value));
});
test('installed CLI runs without node_modules or source-checkout resolution',async t=>{
  const project=await fixture(t);
  const a=task('T-20260914-aaaaaaaaaaaa',base.publishedAt,{title:'独立项目完整标题',status:'READY'});
  await legacy(project,[{tasks:[a]}]);
  const software=path.join(project,'review-software');
  const source=fileURLToPath(new URL('../',import.meta.url));
  await mkdir(software,{recursive:true});
  for(const dir of ['tools','server','web/presentation'])await cp(path.join(source,dir),path.join(software,dir),{recursive:true});
  const cli=path.join(software,'tools/tasks.mjs');
  const run=(...args)=>execFileSync(process.execPath,[cli,...args,'--project',project],{cwd:project,encoding:'utf8',env:{...process.env,NODE_PATH:''}});
  const text=run('list','--format','text','--width','120');
  assert(text.includes('独立项目完整标题'));
  assert(text.includes('T-20260914-001'));
  assert(run('show','T-20260914-001','--format','text').includes('独立项目完整标题'));
  assert(run('status','--format','text').includes('执行者'));
  assert(run('audit','--format','text').includes('独立项目完整标题'));
  assert.equal(JSON.parse(run('list')).length,1);
  assert(run('--help').includes('heartbeat'));
});
