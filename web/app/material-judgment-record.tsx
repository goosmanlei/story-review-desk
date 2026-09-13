type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) => typeof value === 'string' ? value : '';

/** The recorded criteria remain visible even when the next review uses new criteria. */
export function MaterialJudgmentRecord({head}: {head: RecordValue}) {
  const decision = head.decision ? record(head.decision) : head;
  const criteria = rows(record(head.reviewSpec).criteria);
  const findings = rows(decision.criterionFindings);
  const observation = record(head.observation);
  return <details><summary>查看已登记的判断与依据</summary>
    {text(head.purposeNote) && <p>{text(head.purposeNote)}</p>}
    {text(observation.note) && <p style={{whiteSpace:'pre-wrap'}}>{text(observation.note)}</p>}
    {findings.map((finding, index) => <section key={text(finding.criterionId) || index}>
      <strong>{text(record(finding.criterion).label) || text(criteria.find(c => c.id === finding.criterionId)?.label) || text(finding.criterionId)} · {({PASS:'通过',FAIL:'不通过',NA:'不适用'} as Record<string,string>)[text(finding.verdict)] || '未记录'}</strong>
      <p style={{whiteSpace:'pre-wrap'}}>{text(finding.note)}</p>
    </section>)}
    {text(decision.note) && <p>{text(decision.note)}</p>}
    {Object.entries(record(head.revisionInstructions)).map(([key,value])=><p key={key}>{({preserve:'必须保留',change:'必须修改',mustNotRegress:'不得退化'} as Record<string,string>)[key]||key}：{Array.isArray(value)?value.map(text).join('；'):text(value)}</p>)}
    {text(record(head.authorization).basis) && <p>{text(record(head.authorization).basis)}</p>}
  </details>;
}
