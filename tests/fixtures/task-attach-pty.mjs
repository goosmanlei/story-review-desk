import {runAttach} from '../../tools/task-attach.mjs';

const sent=[];let answers=0,closed=0;
const snapshot={task:{id:'pty-task',displayId:'T-20260915-999',title:'PTY 隔离任务',status:'RUNNING'},nodes:[{id:'pty-worker',parentAssignmentId:null,role:'worker',title:'PTY 节点',status:'RUNNING',model:'fixture',effort:'medium',canSend:true,reason:null,messages:[]}],decisions:[],connection:{status:'CONNECTED',reason:null}};
const client={
 async snapshot(){return structuredClone(snapshot);},
 async send(request){sent.push({assignmentId:request.assignmentId,text:request.text});return {status:'SENT'};},
 async showDecision(){throw Error('PTY fixture has no decisions');},
 async answer(){answers++;return {status:'ANSWERED'};},
 async close(){closed++;},
};
process.stdout.write('PTY_READY\n');
await runAttach('/fixture','pty-task',{openClient:async()=>client,pollIntervalMs:25});
process.stdout.write(`\nPTY_RESULT=${JSON.stringify({sent,answers,closed})}\n`);
