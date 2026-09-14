import {AsyncLocalStorage} from 'node:async_hooks';

// Capability scope is local to each asynchronous tool/message invocation. Never
// expose its token in prompts, ledger events, results or attach snapshots.
const scope=new AsyncLocalStorage();
export const executionAuthority=()=>scope.getStore();
export const withExecutionAuthority=(authority,callback)=>scope.run(authority,callback);
