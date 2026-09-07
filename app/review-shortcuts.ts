/** Draft-only shortcut: fill the current criteria, never replace prior judgments or notes. */
export function fillUnansweredWithPass<T extends {verdict:string;note:string}>(findings:Record<string,T>,ids:string[]):Record<string,T>{
 const next={...findings};
 for(const id of ids)if(!findings[id]?.verdict)next[id]={...findings[id],verdict:'PASS',note:findings[id]?.note||''} as T;
 return next;
}
