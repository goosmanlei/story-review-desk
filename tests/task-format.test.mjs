import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {renderTasks,renderStatus,renderDetail,renderAssignments,renderAudit,formatTaskDate,sortTasks,cell,taskLabels} from '../tools/task-format.mjs';
import {main} from '../tools/tasks.mjs';
import {replayTaskNumbers,displayTaskId} from '../tools/task-numbering.mjs';
import {fixture,task,legacy} from './task-numbering/fixture.mjs';

const require=createRequire(import.meta.url),MarkdownIt=require('markdown-it');
const publishedAt='2026-09-14T02:00:00.000Z';
const permanent=n=>`T-20260914-${String(n).padStart(12,'0')}`;
const timestamp=n=>new Date(Date.parse(publishedAt)+n*1000).toISOString();
const display=n=>`T-20260914-${String(n).padStart(3,'0')}`;
const rowFields=line=>line.slice(2,-2).split(' | ');

function formattedTask(n,extra={}) {
  return task(permanent(n),timestamp(n),{displayId:display(n),title:`正式任务 ${n}`,type:n%2?'SYSTEM':'CREATIVE',status:'READY',priority:n%4,...extra});
}

test('shared seven-column GFM source uses raw codes, complete titles and safe per-dependency line breaks',()=>{
  const longTitle='长标题保留完整正式文本 | <tag> [ref] `code` *star* _under_ \\ end';
  const statuses=Object.keys(taskLabels);
  const tasks=statuses.map((status,i)=>formattedTask(i+1,{status,title:i===2?longTitle:`${status} 正式标题`,dependencies:i===1?[permanent(1)]:i===2?[permanent(1),permanent(2)]:[]}));
  tasks.push(formattedTask(8,{type:'OTHER',status:'NOT_A_STATE',title:'无效规范如实展示',dependencies:[]}));
  const data={tasks,asOf:'2026-09-14T03:04:05.000Z',scope:'格式回归'};
  const md=renderTasks(data),rows=md.split('\n').filter(line=>line.startsWith('| T-')).map(rowFields);

  assert.match(md,/^\| 任务编号 \| 任务标题 \| 类别 \| 状态 \| 优先级 \| 发布时间 \| 前置依赖 \|$/m);
  assert.equal(rows.length,tasks.length);
  assert(rows.every(row=>row.length===7));
  assert.deepEqual(rows.map(row=>row[0]),tasks.map(({displayId})=>displayId));
  assert.deepEqual(rows.slice(0,7).map(row=>row[3]),statuses.map(cell));
  assert.deepEqual(rows.slice(0,7).map(row=>row[2]),tasks.slice(0,7).map(({type})=>type));
  assert.equal(rows[7][2],'UNKNOWN');
  assert.equal(rows[7][3],'UNKNOWN');
  assert.equal(rows[0][6],'—');
  assert.equal(rows[1][6],display(1));
  assert.equal(rows[2][6],`${display(1)}<br>${display(2)}`);
  assert.equal(rows[2][1],cell(longTitle));
  assert.match(md,/READY 1、RUNNING 1、BLOCKED 1、WAITING_REVIEW 1、DONE 1、CANCELLED 1、MERGED 1、UNKNOWN 1。/);
  assert.doesNotMatch(md,/（(?:SYSTEM|CREATIVE|READY|RUNNING|BLOCKED|WAITING_REVIEW|DONE|CANCELLED|MERGED)）/);
  assert.doesNotMatch(md,/系统优化|内容创作|待执行|执行中|待验收|已完成|已取消|已合并/);
  assert.doesNotMatch(rows[2][6],/[,，、]/);

  for(const output of [renderStatus(data),renderAudit({...data,events:[]})]) {
    assert(output.includes(cell(longTitle)));
    assert(output.includes(`${display(1)}<br>${display(2)}`));
    assert.match(output,/\| UNKNOWN \| UNKNOWN \|/);
  }
  const detail=renderDetail(tasks[2],{tasks});
  assert.match(detail,new RegExp(`\\| 状态 \\| ${tasks[2].status} \\|`));
  assert.match(detail,new RegExp(`\\| 类型 \\| ${tasks[2].type} \\|`));
  assert(detail.includes(`${display(1)}<br>${display(2)}`));

  // This verifies portable GFM structure only. Current-host width and visual
  // line wrapping remain an explicit presentation acceptance step.
  const html=new MarkdownIt({html:true,linkify:false}).render(md);
  const bodyRows=[...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1);
  assert.equal((html.match(/<th>/g)||[]).length,7);
  assert.equal(bodyRows.length,tasks.length);
  assert(bodyRows.every(row=>(row[1].match(/<td>/g)||[]).length===7));
  assert.match(html,new RegExp(`${display(1)}<br>${display(2)}`));
});

test('assignment status cells use legal raw codes and normalize unknown values',()=>{
  const statuses=['RESERVED','RUNNING','WAITING_DECISION','DELIVERED','ACCEPTED','BLOCKED','CLOSED'];
  const assignments=[...statuses,'NOT_A_STATE'].map((status,i)=>({
    id:`A-${i}`,
    status,
    execution:{model:'fixture',effort:'medium',goalMode:'NONE'}
  }));
  const md=renderAssignments([formattedTask(9,{assignments})]);
  const rows=md.split('\n').filter(line=>line.startsWith('| A-')).map(rowFields);
  assert.equal(rows.length,assignments.length);
  assert.deepEqual(rows.map(row=>row[2]),[...statuses,'UNKNOWN'].map(cell));
});

test('dependency identities are escaped individually before the trusted break separator',()=>{
  const unsafe=['legacy<&>|`[]*_\\one','<script>two</script>'];
  const dependent=formattedTask(1,{dependencies:unsafe});
  const md=renderTasks({tasks:[dependent],asOf:publishedAt});
  const dependency=rowFields(md.split('\n').find(line=>line.startsWith('| T-')))[6];
  assert.equal(dependency,unsafe.map(cell).join('<br>'));
  assert.equal((dependency.match(/<br>/g)||[]).length,1);
  assert.doesNotMatch(dependency,/<script>|<\/script>|\|`/);
});

test('empty output, Beijing dates, sorting and legacy display aliases remain compatible',()=>{
  const empty=renderTasks({tasks:[],asOf:null,scope:'空范围'});
  assert.match(empty,/截至 —（北京时间），空范围共 0 项任务；无任务。/);
  assert.equal(empty.split('\n').filter(line=>line.startsWith('| ')).length,2);
  assert.equal(formatTaskDate('2026-09-13T17:01:02.000Z'),'2026-09-14 01:01:02');
  assert.equal(formatTaskDate('invalid'),'UNKNOWN');
  assert.equal(formatTaskDate(null),'—');

  const a=formattedTask(1,{publishedAt:timestamp(2),priority:2,updatedAt:timestamp(1),completedAt:timestamp(3)});
  const b=formattedTask(2,{publishedAt:timestamp(1),priority:0,updatedAt:timestamp(3),completedAt:timestamp(1)});
  const c=formattedTask(3,{publishedAt:timestamp(3),priority:1,updatedAt:timestamp(2),completedAt:timestamp(2)});
  assert.deepEqual(sortTasks([a,b,c]).map(t=>t.id),[b.id,a.id,c.id]);
  assert.deepEqual(sortTasks([a,b,c],'priority').map(t=>t.id),[b.id,c.id,a.id]);
  assert.deepEqual(sortTasks([a,b,c],'updated').map(t=>t.id),[b.id,c.id,a.id]);
  assert.deepEqual(sortTasks([a,b,c],'completed').map(t=>t.id),[a.id,c.id,b.id]);

  const legacyTasks=[
    {...a,displayId:undefined,publishedAt:'2026-09-13T16:00:01.000Z'},
    {...b,displayId:undefined,publishedAt:'2026-09-13T16:00:02.000Z'}
  ];
  const numbering=replayTaskNumbers([{sequence:1,tasks:legacyTasks}]);
  assert.deepEqual(numbering.displayIds,{[a.id]:'T-20260914-001',[b.id]:'T-20260914-002'});
  const index=Object.fromEntries(legacyTasks.map(t=>[t.id,{...t,displayId:numbering.displayIds[t.id]}]));
  assert.equal(displayTaskId(index,a.id),'T-20260914-001');
  assert.equal(displayTaskId(index,'legacy-unmapped'),'legacy-unmapped');
});

test('CLI default, --all, filters and raw-status summaries retain their existing scopes',async t=>{
  const root=await fixture(t),statuses=Object.keys(taskLabels);
  const priorities=[3,2,1,0,3,2,1];
  const tasks=statuses.map((status,i)=>task(permanent(i+1),timestamp(i),{status,type:i===2?'CREATIVE':'SYSTEM',priority:priorities[i]}));
  await legacy(root,[{tasks}]);
  const query=(...args)=>main(['list','--project',root,...args]);
  const pending=await query(),all=await query('--all');
  assert.deepEqual(pending.map(t=>t.status),['READY','RUNNING','BLOCKED','WAITING_REVIEW']);
  assert.deepEqual(all.map(t=>t.status),statuses);
  assert.deepEqual(await query('--status','DONE'),[]);
  assert.deepEqual((await query('--all','--status','DONE')).map(t=>t.status),['DONE']);
  assert.deepEqual((await query('--type','CREATIVE')).map(t=>t.status),['BLOCKED']);
  assert.deepEqual((await query('--all','--sort','priority')).map(t=>t.priority),[0,1,1,2,2,3,3]);
  const markdown=await query('--all','--format','markdown');
  assert.match(markdown,/READY 1、RUNNING 1、BLOCKED 1、WAITING_REVIEW 1、DONE 1、CANCELLED 1、MERGED 1。/);
  assert.match(markdown,/2026-09-14 10:00:00/);
  assert.equal(markdown.split('\n').filter(line=>line.startsWith('| T-')).length,statuses.length);
});
