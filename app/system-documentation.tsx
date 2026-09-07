'use client';
import {useWorkflowProjection,workflowCount} from './workflow-overview';
import './workspace-audit.css';

export type SystemModel = {
  title: string;
  architecture: Array<{ id: string; label: string; description: string; writePolicy: string }>;
  entities: Array<{ name: string; key: string; count: number | null; purpose: string }>;
  relations: string[];
  stateModel: {
    version: string;
    principle: string;
    lifecycleStates: Array<{
      code: string;
      label: string;
      meaning: string;
      tone: 'good' | 'waiting' | 'danger' | 'neutral';
      phase: 'BEFORE_OUTPUT' | 'AFTER_OUTPUT' | 'SPECIAL';
    }>;
    preOutputStates: string[];
    reviewStates: string[];
    specialStates: string[];
    fields: Array<{ field: string; owner: string; values: string[]; note: string }>;
    entityMatrix: Array<{ category: string; entities: string; fields: string[]; note: string }>;
    flow: Array<{ id: string; label: string; note: string }>;
    reviewContract: {
      schemaVersion: string;
      actions: string[];
      removedAction: string;
      draftPolicy: string;
      application: string;
      revalidation: string;
    };
    rightsScope: {
      clear: string;
      unknown: string;
      blocked: string;
      commercial: string;
    };
    separations: string[];
    releaseComplianceStatus: 'UNKNOWN';
  };
  interfaces: Array<{ method: string; path: string; purpose: string; writes: boolean }>;
  writeBoundary: { allowed: string[]; forbidden: string[] };
  integrity: Record<string, boolean>;
  snapshotId: string;
};

export type RecipeSummary = {
  counts: { definitions: number; modelCalls: number; manualEditTasks: number; documents: number; promptRevisions: number; postProductionTasks: number; byStage: Record<string, number> };
  executionDocuments: Array<{ id: string; path: string; title: string; sha256: string; byteSize: number }>;
  sourceCatalog: Array<{ id?: string; path?: string; role?: string; sha256?: string; authority?: string }>;
};


const statusLabels:Record<string,string>={ACTIVE:'正在推进',AVAILABLE_PARALLEL:'可并行推进',WAITING:'等待推进',BLOCKED:'存在阻断',COMPLETE:'当前范围已完成',UNKNOWN:'范围待核',REGISTERED:'设定已登记'};
const operationLabels:Record<string,string>={reviews:'正式审阅',episodePlanSubmissions:'分集审阅输入',candidates:'素材候选',runs:'执行尝试',creativeRevisions:'创作候选',executionRequests:'执行请求',sourceOperations:'源同步操作',verifications:'核验记录',scriptComments:'评论事件',scriptCommentThreads:'评论线程',total:'合计事件'};
export function SystemDocumentation(){
 const {snapshot,error,refresh}=useWorkflowProjection(),audit=snapshot?.workflow.audit;
 if(!audit)return <section className="workspace-audit" aria-label="技术附录与审计依据"><p role={error?'alert':'status'}>{error||'正在读取当前实例的模块与审计依据…'}</p>{error&&<button onClick={refresh}>重新读取</button>}</section>;
 const {freshness}=audit;
 return <section className="workspace-audit" aria-label="技术附录与审计依据" data-projection-version={freshness.projectionVersion}>
  <header><h2>当前模块与数据依据</h2><p>{audit.authority} · {freshness.mode==='PUBLISHED_READ_ONLY'?'此处是发布时快照，不代表本地最新运行进展。':'模块状态、工作单元和事件水位来自同一读取事务；内容与配置变化后自动刷新。'}</p><button onClick={refresh}>刷新依据</button></header>
  <div className="workspace-audit-modules">{audit.modules.map(module=><article key={module.id} data-workspace-module={module.id}><header><a href={module.href}>{module.label} →</a><small>{statusLabels[module.status]||module.status}</small></header><p>{module.responsibility}</p><dl>{module.facts.map(fact=><div key={fact.id}><dt title={fact.boundary}>{fact.label}</dt><dd title={fact.boundary}>{fact.value??'UNKNOWN'}</dd></div>)}</dl><p>{module.headline}</p>{module.work&&<small>可推进 {module.work.ready+module.work.inProgress} · 等待或阻断 {module.work.waiting+module.work.blocked}</small>}{module.nextAction&&<p>下一步：{module.nextAction}</p>}{module.stages.length>0&&<details><summary>阶段状态与真实分母</summary><ul>{module.stages.map(stage=><li key={stage.id}>{stage.label}：{workflowCount(stage)} · {statusLabels[stage.status]||stage.status}</li>)}</ul></details>}</article>)}</div>
  <section><h3>四个创作阶段，共用同一映射</h3><ol className="workspace-audit-stages">{audit.creatorStages.map(stage=><li key={stage.id}><b>{stage.label}</b><p>{stage.purpose}</p></li>)}</ol><p>创作者界面展示四阶段；底层 {audit.configuration.phaseCount} 个 canonical 阶段、{audit.configuration.gateCount} 个对象检查按已发布配置读取。全剧导出仍属于 PROJECT 范围，冻结历史的身份、标准与哈希不随界面调整。</p></section>
  <section><h3>审阅、制作与协作边界</h3><ul>{audit.boundaries.map(boundary=><li key={boundary}>{boundary}</li>)}</ul><p>本地可绑定 Codex 项目；其他 AI API 使用配置中指定的环境变量名读取密钥，不在业务数据、Git 或镜像中保存密钥。</p></section>
  <details><summary>精确水位与事件审计</summary><dl className="workspace-audit-watermark">{Object.entries({发布快照:freshness.snapshotId,业务发布:freshness.releaseId,运行期:freshness.runtimeEpoch,仓库水位:freshness.repositoryRevision,事件水位:freshness.eventSequence,运行投影:freshness.operationRevision,配置修订:freshness.configurationRevisionId,设定修订:freshness.domainRevisionId,准备稿修订:freshness.preparationRevisionId}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value??(freshness.mode==='PUBLISHED_READ_ONLY'?'镜像未包含':'UNKNOWN')}</dd></div>)}</dl><p>下列数量是追加历史事件数，不是当前已通过对象数；有效进展见上方各模块与对象页面。</p><div className="workspace-audit-counts">{audit.operationCounts.map(row=><span key={row.id}>{operationLabels[row.id]||row.id} <b>{row.value}</b></span>)}</div></details>
  <details><summary>读取接口与维护责任</summary><dl className="workspace-audit-interfaces">{audit.interfaces.map(entry=><div key={entry.path}><dt><code>{entry.path}</code></dt><dd>{entry.purpose}</dd></div>)}</dl><p>备份与恢复使用“数据与运行”。完整备份和只读导出用途不同；恢复先进入独立目录与数据库，不能覆盖当前实例。</p></details>
 </section>;
}
