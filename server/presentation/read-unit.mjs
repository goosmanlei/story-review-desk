import { hash, check } from '../shared/contracts.mjs';
import { summaries, objectDetail } from '../repository.mjs';
import { configurationDefaults, modelArrayKeys, productionGraphDefaults } from './defaults.mjs';

// A request-local view of object revisions. These structures are UI projections,
// never another store or a published whole-story snapshot.
export class PresentationRead {
  constructor(tx) { this.tx = tx; this.basis = new Map(); this.loaded = new Map(); }
  bind(row) {
    this.basis.set(row.id, { objectId: row.id, revisionId: row.revisionId, expectedVersion: row.version, sha256: row.sha256 });
    return row;
  }
  async rows(kinds, { historical = false, content = true, ids, roles, excludeRoles } = {}) {
    const key = JSON.stringify([kinds, historical, content, ids, roles, excludeRoles]);
    if (this.loaded.has(key)) return this.loaded.get(key);
    const result = await this.tx.query(`SELECT ${summaries},r.id AS "revisionId",r.sha256,
      ${content ? 'r.content' : "jsonb_build_object('slugline',r.content->'slugline','runtime',r.content->'runtime','type',r.content->'type') AS content"},
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.member_id,'role',m.role,'position',m.position) ORDER BY m.position,m.member_id)
        FROM revision_memberships m WHERE m.revision_id=r.id),'[]'::jsonb) AS links
      FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
      WHERE o.kind=ANY($1::text[]) AND ($2 OR NOT o.historical) AND ($3::text[] IS NULL OR o.id=ANY($3))
      AND ($4::text[] IS NULL OR r.content->>'role'=ANY($4))
      AND ($5::text[] IS NULL OR NOT COALESCE(r.content->>'role','')=ANY($5))
      ORDER BY o.position,o.id LIMIT 5001`, [kinds, historical, ids || null, roles || null, excludeRoles || null]);
    check(result.rows.length <= 5000, 'WORKSPACE_LIMIT', '此工作区需要进一步按对象范围读取', 413);
    const value = result.rows.map(row => this.bind(row)); this.loaded.set(key, value); return value;
  }
  async detail(id, revisionId) {
    const detail = await objectDetail(this.tx, id, { revisionId });
    this.bind({ ...detail, revisionId: detail.revision.id, sha256: detail.revision.sha256 });
    return detail;
  }
  async configuration() {
    if (this.config) return this.config;
    const rows = (await this.tx.query('SELECT scope,version,content FROM configurations ORDER BY scope')).rows;
    this.configurationVersions = Object.fromEntries(rows.map(r => [r.scope, r.version]));
    const system = rows.find(r => r.scope === 'system')?.content || {}, project = rows.find(r => r.scope === 'project')?.content || {};
    const defaults = structuredClone(configurationDefaults);
    this.projectConfiguration = project; this.systemConfiguration = system;
    this.config = {
      ...defaults,
      template: system.template || defaults.template,
      domain: { ...defaults.domain, ...system.entityTypes },
      taxonomy: { ...defaults.taxonomy, ...system.materialTypes },
      workflow: { ...defaults.workflow, ...system.productionStages },
      technical: { ...defaults.technical, ...system.technicalStandards, picture: project.pictureBaseline || defaults.technical.picture },
      sources: { ...defaults.sources, continuity:system.sourceRules || defaults.sources.continuity, ...(project.sourcePriority ? { order: project.sourcePriority } : {}) },
      reviewProfiles: system.reviewStandards || defaults.reviewProfiles,
      presentation: { ...defaults.presentation, storyTitle: project.title || defaults.presentation.storyTitle, ...(project.branding || {}), ...(project.candidateOptions||{}), landingView: project.defaultWorkspace || defaults.presentation.landingView },
      collaboration: { ...defaults.collaboration, ...system.assistant, assistantEnabled: system.assistant?.enabled !== false },
    };
    return this.config;
  }
  async profile() {
    if (this.identity) return this.identity;
    const p = (await this.tx.query('SELECT instance_id AS "instanceId",runtime_epoch AS "runtimeEpoch",title FROM project')).rows[0];
    const config = await this.configuration();
    const story = (await this.rows(['STORY'], { content: false }))[0];
    const project = this.projectConfiguration;
    this.identity = {
      schemaVersion: '1.0', instanceId: p.instanceId, projectId: p.instanceId, episodePlanId: story?.id || 'episode-plan:' + p.instanceId,
      title: project.branding?.title || p.title + ' · 审阅台', storyTitle: p.title, locale: project.locale || 'zh-CN',
      branding: project.branding || { mark: '阅', title: p.title + ' · 审阅台', description: '故事创作、素材审阅与全剧制作。' },
      assistant: { scopeKey: p.instanceId, contextMode: 'OBJECT_SERVICES', schedulerProtocol: 'REVIEW_CONTROLLED_ACTIONS_V1' },
      sourceBindings: { creativeRevisionPaths: {}, derivedRegistryPaths: [] },
      capabilities: { assistantEnabled: config.collaboration.assistantEnabled, landingView: project.defaultWorkspace || 'overview', preferredCollaborator: project.preferredCollaborator || 'HUMAN_AI', instanceAuthoring: 'OBJECT_SERVICES' },
      deployment: { mode: 'LOCAL', deploymentId: process.env.REVIEW_SOFTWARE_COMMIT || 'DEVELOPMENT', runtimeEpoch: p.runtimeEpoch, basePath: '' },
    };
    return this.identity;
  }
  async namespace() { const p = await this.profile(); return p.instanceId + ':' + p.deployment.runtimeEpoch; }
  finish(value) { return { ...value, _basis: [...this.basis.values()], _configurationVersions: this.configurationVersions || {} }; }
  version() { return hash({ objects: [...this.basis.values()].sort((a,b) => a.objectId.localeCompare(b.objectId)), configurations: this.configurationVersions || {} }); }
  async blankModel() { return { schemaVersion: '1.0', instance: await this.profile(), ...Object.fromEntries(modelArrayKeys.map(k => [k, []])), ...structuredClone(productionGraphDefaults), policy: {}, counts: {}, reviewContextCatalog: {}, systemModel: {}, revisionPointers: {}, systemConfiguration: { reference:{revisionId:hash(this.configurationVersions),sha256:hash(await this.configuration())}, config: await this.configuration(), defaults: structuredClone(configurationDefaults) } }; }
}

export const idsFor = (row, role) => (row.links || []).filter(l => l.role === role).map(l => l.id);
export const idFor = (row, role) => idsFor(row, role)[0] || null;
export const present = row => ({ ...row.content, id: row.id, title: row.title, displayId: row.displayId, revisionId: row.revisionId, objectVersion: row.version, revisionSha256: row.sha256 });
export const stateLabel = state => ({ DRAFT:'PENDING_REVIEW', SUBMITTED:'PENDING_REVIEW', ADOPTED:'RELEASED', CHANGES_REQUESTED:'REVISION_REQUIRED', DISABLED:'DO_NOT_USE', ARCHIVED:'HISTORICAL' })[state] || 'UNKNOWN';
export function paragraphs(text, prefix = 'paragraph') { return String(text || '').split(/\n\s*\n/).filter(Boolean).map((value, i) => ({ id: prefix + '-' + (i + 1), type: /^#{1,6} /.test(value) ? 'heading' : 'paragraph', text: value.replace(/^#{1,6} /, ''), level: value.match(/^#+/)?.[0].length || 0 })); }
