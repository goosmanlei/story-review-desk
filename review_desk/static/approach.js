/* Instance-owned reading material. No production state or progress is stored here. */
let approachDocument = null;

async function renderApproach() {
  const host = $('#approach-body');
  const selected = new URL(location.href).searchParams.get('tab') === 'materials' ? 'materials' : 'story';
  for (const button of document.querySelectorAll('[data-approach-tab]')) {
    const active = button.dataset.approachTab === selected;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    button.classList.toggle('active', active);
  }
  host.setAttribute('aria-labelledby', `approach-tab-${selected}`);
  host.textContent = '正在读取制作方法…';
  try {
    if (!approachDocument) approachDocument = api('/api/production-approach').catch(error => { approachDocument = null; throw error; });
    const document = await approachDocument;
    // A fast tab switch must not let the previous request replace the selected text.
    const current = new URL(location.href).searchParams.get('tab') === 'materials' ? 'materials' : 'story';
    if (current !== selected) return;
    host.replaceChildren();
    if (!document) { nodeText('p', 'approach-note', '本实例尚未提供制作方法文档。已有故事与审阅功能可继续使用。', host); return; }
    const tab = document.tabs.find(item => item.id === selected);
    nodeText('h2', null, tab.title, host);
    nodeText('p', 'approach-lead', tab.lead, host);
    const index = el('nav', 'approach-index'); index.setAttribute('aria-label', `${tab.label}阅读目录`);
    for (const section of tab.sections) {
      const a = nodeText('a', null, section.title, index); a.href = `#approach-${tab.id}-${section.id}`;
    }
    host.append(index);
    for (const section of tab.sections) {
      const article = el('section', 'approach-section'); article.id = `approach-${tab.id}-${section.id}`;
      nodeText('h3', null, section.title, article);
      for (const text of section.paragraphs || []) nodeText('p', null, text, article);
      if (section.flow) {
        const flow = el('ol', 'approach-flow'); flow.setAttribute('aria-label', section.title + '：顺序流程');
        for (const step of section.flow) { const item = el('li'); nodeText('b', null, step.title, item); nodeText('span', null, step.text, item); flow.append(item); }
        article.append(flow);
      }
      if (section.table) {
        const table = el('table', 'approach-table');
        nodeText('caption', 'visually-hidden', section.title, table);
        const head = el('thead'), tr = el('tr');
        for (const column of section.table.columns) { const th = nodeText('th', null, column, tr); th.scope = 'col'; }
        head.append(tr); table.append(head);
        const body = el('tbody');
        for (const row of section.table.rows) {
          const line = el('tr');
          row.forEach((value, i) => { const cell = nodeText(i === 0 ? 'th' : 'td', null, value, line); cell.dataset.label = section.table.columns[i]; if (i === 0) cell.scope = 'row'; });
          body.append(line);
        }
        table.append(body); article.append(table);
      }
      if (section.note) nodeText('p', 'approach-note', section.note, article);
      if (section.links) {
        const links = el('ul', 'approach-links');
        for (const ref of section.links) {
          if (ref.workspace && !state.framework.workspaces.some(item => item.id === ref.workspace && item.implemented)) continue;
          const row = el('li'), url = new URL(ref.href, location.href);
          // Editorial text cannot inject markup or executable URL schemes.
          if (url.protocol !== 'https:' && !(url.origin === location.origin && ref.href.startsWith('/?'))) continue;
          const a = nodeText('a', null, ref.label, row); a.href = url.href;
          if (url.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          links.append(row);
        }
        article.append(links);
      }
      host.append(article);
    }
  } catch (error) { host.textContent = `制作方法加载失败：${error.message}。刷新可重试；已有故事与审阅数据不受影响。`; }
}

function selectApproachTab(tab, focus = false) {
  const url = new URL(location.href); url.searchParams.set('workspace', 'production.approach'); url.searchParams.set('tab', tab); url.hash = '';
  if (url.href !== location.href) history.pushState(null, '', url);
  renderApproach();
  if (focus) $(`#approach-tab-${tab}`).focus();
}

for (const button of document.querySelectorAll('[data-approach-tab]')) {
  button.onclick = () => selectApproachTab(button.dataset.approachTab);
  button.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'story' : event.key === 'End' ? 'materials' : button.dataset.approachTab === 'story' ? 'materials' : 'story';
    selectApproachTab(tab, true);
  };
}
