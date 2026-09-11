import {check} from './shared/contracts.mjs';

// The deployment drain takes the exclusive lock. Short mutations hold a shared
// lock until commit, so the maintenance marker cannot race a successful save.
export async function mutationGate(tx, runtimeEpoch) {
  await tx.query('SELECT pg_advisory_xact_lock_shared(890670314)');
  const project = (await tx.query('SELECT runtime_epoch FROM project')).rows[0];
  check(!runtimeEpoch || project?.runtime_epoch === runtimeEpoch,
    'RUNTIME_CHANGED', '实例已切换；请保留草稿并重新打开当前工作区', 409);
  const marker = (await tx.query("SELECT value FROM runtime_status WHERE name='maintenance'")).rows[0];
  check(!marker?.value?.enabled, 'MAINTENANCE', '实例正在部署维护，草稿已保留，请稍后保存', 503);
}
