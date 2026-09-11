import {check} from '../shared/contracts.mjs';
export const kinds=['COMMENT','JUDGMENT'];
export function validate(kind,content){
  if(kind==='COMMENT')check(typeof content.text==='string'&&content.text.trim(),'COMMENT_REQUIRED','评论正文不能为空');
  if(content.status!==undefined)check(['OPEN','RESOLVED','CLOSED'].includes(content.status),'COMMENT_STATUS','评论状态无效');
}
