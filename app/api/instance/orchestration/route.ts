import {readOrchestrationDashboard} from '../../../../host/instance-runtime/orchestration-dashboard.mjs';
import {readOrchestrationHeartbeat} from '../../../../host/instance-runtime/orchestration-dashboard-runtime.mjs';
import {hostedReadOnlyMode, instanceRepository, jsonResponse} from '../../v8/_store';

export async function GET(request: Request) {
  // Hosted must reject before opening the repository or touching runtime files.
  if (hostedReadOnlyMode()) return jsonResponse({error:'多 Agent 协作状态仅在本地实例可用'}, {status:405});
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => key !== 'completedPage') || params.getAll('completedPage').length > 1 ||
      (params.has('completedPage') && !/^\d{1,7}$/.test(params.get('completedPage')!)) || Number(params.get('completedPage')) > 1000000) {
    return jsonResponse({error:'无效的已完成任务页码'}, {status:400});
  }
  try {
    const repo = await instanceRepository();
    if (!repo) return jsonResponse({error:'当前入口未绑定实例'}, {status:503});
    const heartbeat = await readOrchestrationHeartbeat(process.env.REVIEW_INSTANCE_ROOT);
    return jsonResponse(await repo.readTransaction(tx => readOrchestrationDashboard(tx, {heartbeat, completedPage:Number(params.get('completedPage') || 0)})));
  } catch {
    // Raw repository/transport errors can contain private paths or credentials.
    return jsonResponse({error:'协作状态暂时无法读取，请稍后手动刷新'}, {status:503});
  }
}
