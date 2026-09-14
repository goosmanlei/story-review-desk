// Only isolated test subprocesses import this clock; production has no clock flag.
import assert from 'node:assert/strict';
if(process.env.TASK_NUMBERING_NOW) {
  assert(process.env.REVIEW_TASK_DIR,'编号测试须经受管阶段执行');
  const NativeDate=Date,now=NativeDate.parse(process.env.TASK_NUMBERING_NOW);
  assert(Number.isFinite(now));
  globalThis.Date=class extends NativeDate {
    constructor(...args) {super(...(args.length?args:[now]));}
    static now() {return now;}
  };
}
