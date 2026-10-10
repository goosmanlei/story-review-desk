/* Instance-owned reading material. No production state or progress is stored here. */
let approachDocument = null;
let approachContent = null;
let approachIndexFrame = 0, approachIndexObserver = null;

function approachTabs() {
  return approachContent?.tabs || [{id: 'story', label: '故事创作'}, {id: 'materials', label: '生产制作'}];
}

function approachSelectedTab(params = new URL(location.href).searchParams, hash = location.hash) {
  const tabs = approachTabs();
  // Old default-page links contain only a chapter anchor. Resolve only an
  // anchor actually owned by the document; an explicit tab always takes priority.
  if (params.has('tab')) return tabs.find(tab => tab.id === params.get('tab')) || tabs[0];
  return tabs.find(tab => (tab.sections || []).some(section =>
    hash === `#approach-${tab.id}-${section.id}` || (section.blocks || []).some(block =>
      block.type === 'heading' && block.id && hash === `#approach-${tab.id}-${block.id}`))) || tabs[0];
}

function bindApproachNavigation(link) {
  link.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
    const target = new URL(link.href, location.href);
    if (target.origin !== location.origin || target.pathname !== reviewURL('/') || target.searchParams.get('workspace') !== 'production.approach') return;
    // Only temporary method reading uses the existing in-document router.
    // Explicit work/edition links and modified clicks keep native semantics.
    if (typeof navigateApproachLink !== 'function') return;
    event.preventDefault(); navigateApproachLink(target);
  });
}

function approachInline(parent, text) {
  // A small text-only format: code, emphasis and explicit links. No HTML,
  // media, or implicit network requests from instance prose. Local media uses
  // explicit validated blocks rather than arbitrary prose URLs.
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^\s)]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    if (match[1]) nodeText('code', null, match[1], parent);
    else if (match[2]) nodeText('strong', null, match[2], parent);
    else {
      let url;
      try { url = new URL(match[4], location.href); } catch (_) { /* Display malformed links as text. */ }
      if (url && (url.protocol === 'https:' || (url.origin === location.origin && match[4].startsWith('/?')))) {
        const link = nodeText('a', null, match[3], parent); link.href = url.origin === location.origin ? reviewURL(url.pathname + url.search + url.hash) : url.href;
        bindApproachNavigation(link);
        if (url.origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      } else parent.append(document.createTextNode(match[0]));
    }
    start = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

function approachTable(content, title, rich = false) {
  const table = el('table', 'approach-table');
  nodeText('caption', 'visually-hidden', title, table);
  const head = el('thead'), tr = el('tr');
  for (const column of content.columns) { const th = nodeText('th', null, column, tr); th.scope = 'col'; }
  head.append(tr); table.append(head);
  const body = el('tbody');
  for (const row of content.rows) {
    const line = el('tr');
    row.forEach((value, i) => {
      const cell = nodeText(i === 0 ? 'th' : 'td', null, rich ? '' : value, line);
      if (rich) approachInline(cell, value);
      cell.dataset.label = content.columns[i]; if (i === 0) cell.scope = 'row';
    });
    body.append(line);
  }
  table.append(body); return table;
}

function renderApproachBlocks(article, blocks, title, tabId) {
  for (const block of blocks) {
    if (block.type === 'media') {
      const figure = el('figure', 'approach-media');
      const media = el(block.kind === 'image' ? 'img' : block.kind);
      if (block.kind !== 'audio') { media.width = block.width; media.height = block.height; }
      media.src = reviewURL('/approach-media/' + encodeURIComponent(block.file));
      if (block.kind === 'image') {
        media.alt = block.caption; media.loading = 'lazy'; media.decoding = 'async';
        media.tabIndex = 0; media.setAttribute('role', 'button'); media.setAttribute('aria-haspopup', 'dialog');
        media.setAttribute('aria-label', '放大查看：' + block.caption);
        const show = () => openStructureImage({file: block.file, title: block.caption}, media, '/approach-media/');
        media.addEventListener('click', show);
        media.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
      }
      else {
        media.controls = true; media.preload = 'metadata';
        media.setAttribute('aria-label', block.caption);
        if (block.kind === 'video') media.playsInline = true;
        media.addEventListener('play', () => {
          for (const other of article.closest('#approach-body')?.querySelectorAll('audio,video') || []) if (other !== media) other.pause();
        });
      }
      media.addEventListener('error', () => {
        media.hidden = true;
        if (!figure.querySelector('.approach-note')) nodeText('p', 'approach-note', '此图文媒体加载失败。请刷新重试；仍失败时需核对文件与正文版本。', figure);
      });
      figure.append(media); nodeText('figcaption', null, block.caption, figure);
      article.append(figure); continue;
    }
    if (block.type === 'table') { article.append(approachTable(block, title, true)); continue; }
    if (block.type === 'code') {
      const pre = el('pre', 'approach-prompt');
      nodeText('code', null, block.text, pre); article.append(pre); continue;
    }
    if (block.type === 'list') {
      const list = el(block.ordered ? 'ol' : 'ul', 'approach-list');
      for (const text of block.items) { const item = el('li'); approachInline(item, text); list.append(item); }
      article.append(list); continue;
    }
    const paragraph = el(block.type === 'heading' ? `h${block.level + 1}` : 'p');
    if (block.type === 'heading' && block.id && tabId) {
      paragraph.id = `approach-${tabId}-${block.id}`;
      paragraph.classList.add('approach-anchor');
    }
    approachInline(paragraph, block.text); article.append(paragraph);
  }
}

function scheduleApproachIndex() {
  if (approachIndexFrame || $('#approach-view').hidden) return;
  approachIndexFrame = requestAnimationFrame(() => { approachIndexFrame = 0; syncApproachIndex(); });
}

function syncApproachIndex() {
  if ($('#approach-view').hidden) return;
  const host = $('#approach-body'), index = $('#approach-index'), sidebar = $('#approach-sidebar');
  const sections = [...host.querySelectorAll('.approach-section')];
  if (!sections.length) return;
  let readingTop = Math.max(0, $('.workspace-topbar').getBoundingClientRect().bottom) + 20;
  // On narrow screens the same menu sits above the text; anchors must clear it.
  if (getComputedStyle(index).display === 'flex') {
    readingTop = Math.max(readingTop, parseFloat(getComputedStyle(sidebar).top) + sidebar.getBoundingClientRect().height + 20);
  }
  host.style.setProperty('--approach-scroll-offset', `${readingTop}px`);
  let current = sections[0];
  for (const section of sections) { if (section.getBoundingClientRect().top <= readingTop + 1) current = section; else break; }
  const page = document.scrollingElement;
  if (page.scrollTop > 0 && page.scrollTop + window.innerHeight >= page.scrollHeight - 2) current = sections.at(-1);
  for (const link of index.querySelectorAll('a')) {
    const active = link.hash === `#${current.id}`, changed = active && !link.classList.contains('active');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    if (changed && getComputedStyle(index).display !== 'flex' && !index.contains(document.activeElement)) {
      const item = link.getBoundingClientRect(), menu = index.getBoundingClientRect();
      if (item.top < menu.top) index.scrollTop += item.top - menu.top;
      else if (item.bottom > menu.bottom) index.scrollTop += item.bottom - menu.bottom;
      if (item.left < menu.left) index.scrollLeft += item.left - menu.left;
      else if (item.right > menu.right) index.scrollLeft += item.right - menu.right;
    }
  }
}

function restoreApproachAnchor() {
  if ($('#approach-view').hidden) return;
  syncApproachIndex();
  const target = document.getElementById(location.hash.slice(1));
  const owned = target && (target.classList.contains('approach-section') || target.classList.contains('approach-anchor')) && $('#approach-body').contains(target);
  if (owned) target.scrollIntoView({block: 'start'});
  scheduleApproachIndex();
  // Workspace/browser scroll restoration runs after rendering. Only rescue a
  // partially covered anchor heading; keep deeper saved reading positions.
  const href = location.href;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (location.href !== href || $('#approach-view').hidden || !owned) return;
    syncApproachIndex();
    const top = target.getBoundingClientRect().top;
    const offset = parseFloat($('#approach-body').style.getPropertyValue('--approach-scroll-offset'));
    if (top >= 0 && top < offset) target.scrollIntoView({block: 'start'});
    scheduleApproachIndex();
  }));
}

async function renderApproach() {
  const host = $('#approach-body');
  const requested = new URL(location.href).searchParams.get('tab') || 'story';
  const selected = approachContent ? approachSelectedTab().id : requested;
  if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs();
  host.setAttribute('aria-labelledby', `approach-tab-${selected}`);
  // Hash navigation must keep the mounted text and its browser reading position.
  if (host.dataset.tab === selected) { restoreApproachAnchor(); return; }
  delete host.dataset.tab;
  host.classList.remove('approach-cycle');
  approachIndexObserver?.disconnect();
  const index = $('#approach-index'), sidebar = $('#approach-sidebar');
  index.replaceChildren(); sidebar.hidden = true;
  host.textContent = '正在读取制作方法…';
  try {
    if (!approachDocument) approachDocument = api('/api/production-approach').catch(error => { approachDocument = null; throw error; });
    const guide = await approachDocument;
    approachContent = guide;
    // A fast tab switch must not let the previous request replace the selected text.
    const current = new URL(location.href).searchParams.get('tab') || 'story';
    if (current !== requested) return;
    host.replaceChildren();
    if (!guide) { nodeText('p', 'approach-note', '本实例尚未提供制作方法文档。已有故事与审阅功能可继续使用。', host); return; }
    const tab = approachSelectedTab();
    if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs();
    host.setAttribute('aria-labelledby', `approach-tab-${tab.id}`);
    if (!tab.layout) nodeText('h2', null, tab.title, host);
    nodeText('p', 'approach-lead', tab.lead, host);
    $('#approach-index-title').textContent = tab.label;
    index.setAttribute('aria-label', `${tab.label}阅读目录`);
    for (const section of tab.sections) {
      const a = nodeText('a', 'source-chapter-button', section.title, index); a.href = `#approach-${tab.id}-${section.id}`;
      bindApproachNavigation(a);
    }
    sidebar.hidden = !!tab.layout || !tab.sections.length;
    host.classList.toggle('approach-cycle', tab.layout?.type === 'cycle');
    let content = host;
    if (tab.layout?.type === 'cycle') {
      content = el('div', 'approach-cycle-rows');
      const back = el('div', 'approach-cycle-return');
      nodeText('span', null, tab.layout.return_label, back);
      content.append(back); host.append(content);
    }
    for (const section of tab.sections) {
      const article = el('section', 'approach-section'); article.id = `approach-${tab.id}-${section.id}`;
      if (tab.layout?.type === 'cycle') {
        const frame = el('div', 'approach-cycle-node');
        nodeText('h3', null, section.title, frame); article.append(frame);
      } else nodeText('h3', null, section.title, article);
      const prose = tab.layout?.type === 'cycle' ? el('div', 'approach-cycle-prose') : article;
      if (section.blocks) renderApproachBlocks(prose, section.blocks, section.title, tab.id);
      for (const text of section.paragraphs || []) nodeText('p', null, text, article);
      if (section.flow) {
        const flow = el('ol', 'approach-flow'); flow.setAttribute('aria-label', section.title + '：顺序流程');
        for (const step of section.flow) { const item = el('li'); nodeText('b', null, step.title, item); nodeText('span', null, step.text, item); flow.append(item); }
        article.append(flow);
      }
      if (section.table) {
        article.append(approachTable(section.table, section.title));
      }
      if (section.note) nodeText('p', 'approach-note', section.note, article);
      if (section.links) {
        const links = el('ul', 'approach-links');
        for (const ref of section.links) {
          if (ref.workspace && !state.framework.workspaces.some(item => item.id === ref.workspace && item.implemented)) continue;
          const row = el('li'), url = new URL(ref.href, location.href);
          // Editorial text cannot inject markup or executable URL schemes.
          if (url.protocol !== 'https:' && !(url.origin === location.origin && ref.href.startsWith('/?'))) continue;
          const a = nodeText('a', null, ref.label, row); a.href = url.origin === location.origin ? reviewURL(url.pathname + url.search + url.hash) : url.href;
          bindApproachNavigation(a);
          if (url.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          links.append(row);
        }
        article.append(links);
      }
      if (prose !== article) article.append(prose);
      content.append(article);
    }
    host.dataset.tab = tab.id;
    approachIndexObserver = new ResizeObserver(scheduleApproachIndex);
    for (const node of [host, sidebar, $('.workspace-topbar')]) approachIndexObserver.observe(node);
    restoreApproachAnchor();
  } catch (error) { host.textContent = `制作方法加载失败：${error.message}。刷新可重试；已有故事与审阅数据不受影响。`; }
}

document.addEventListener('scroll', event => {
  // Moving the horizontal directory is navigation intent, not reading progress.
  if (!$('#approach-index').contains(event.target)) scheduleApproachIndex();
}, {capture: true, passive: true});
window.addEventListener('resize', scheduleApproachIndex);
window.addEventListener('hashchange', () => {
  if (!$('#approach-view').hidden && approachContent && $('#approach-body').dataset.tab !== approachSelectedTab().id) renderApproach();
  else restoreApproachAnchor();
});

function selectApproachTab(tab, focus = false) {
  if(typeof rememberWorkspacePosition==='function')rememberWorkspacePosition();
  const url = new URL(location.href); url.searchParams.set('workspace', 'production.approach'); url.searchParams.set('tab', tab); url.hash = '';
  if (url.href !== location.href) typeof pushWorkspaceNavigation==='function'?pushWorkspaceNavigation(url):history.pushState(null, '', url);
  if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs();
  renderApproach().then(()=>{if(typeof restoreWorkspacePosition==='function')restoreWorkspacePosition()});
  if (focus) $(`#approach-tab-${tab}`).focus();
}
