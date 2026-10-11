/* Instance-owned reading material. No production state or progress is stored here. */
let approachDocument = null;
let approachContent = null;
let approachIndexFrame = 0, approachIndexObserver = null;
let approachRenderSequence = 0, approachWorkflowObserver = null;

function approachTabs() {
  return approachContent?.tabs || [{id: 'story', label: '故事创作'}, {id: 'materials', label: '生产制作'}];
}

function approachSelectedTab(params = new URL(location.href).searchParams, hash = location.hash) {
  const tabs = approachTabs();
  // Old default-page links contain only a chapter anchor. Resolve only an
  // anchor actually owned by the document; an explicit tab always takes priority.
  if (params.has('tab')) return tabs.find(tab => tab.id === params.get('tab')) || tabs[0];
  return tabs.find(tab => (tab.sections || []).some(section =>
    hash === `#approach-${tab.id}-${section.id}` || (section.diagram?.nodes || []).some(node => hash === `#approach-${tab.id}-${node.id}`) || Object.keys(tab.layout?.anchors || {}).some(alias => hash === `#approach-${tab.id}-${alias}`) || (section.blocks || []).some(block =>
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
  const tab = approachContent?.tabs.find(item => item.id === $('#approach-body').dataset?.tab);
  const anchor = location.hash.slice(1);
  const prefix = tab ? `approach-${tab.id}-` : '';
  const alias = tab && anchor.startsWith(prefix) ? tab.layout?.anchors?.[anchor.slice(prefix.length)] : null;
  const target = document.getElementById(alias ? prefix + alias : anchor);
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

function approachDiagramIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Only fixed, local shapes are executable code. All editorial labels remain
  // instance-owned text nodes; the instance cannot supply markup or SVG paths.
  const shapes = {
    human: [['circle', {cx:32, cy:19, r:10, fill:'currentColor', 'fill-opacity':'.1'}], ['path', {d:'M13 53c0-12 8-21 19-21s19 9 19 21', fill:'currentColor', 'fill-opacity':'.1'}]],
    ai: [['rect', {x:15, y:15, width:34, height:34, rx:8, fill:'currentColor', 'fill-opacity':'.08'}], ['path', {d:'M24 8v7m16-7v7M24 49v7m16-7v7M8 24h7M8 40h7m34-16h7M49 40h7M32 23c1 5 4 8 9 9-5 1-8 4-9 9-1-5-4-8-9-9 5-1 8-4 9-9'}]],
    film: [['rect', {x:7, y:12, width:50, height:40, rx:5, fill:'currentColor', 'fill-opacity':'.04'}], ['path', {d:'M7 21h50M7 43h50M17 12v9m10-9v9m10-9v9m10-9v9M17 43v9m10-9v9m10-9v9m10-9v9M26 26l12 6-12 6z'}]],
    model: [['path', {d:'M21 32h9c8 0 2-17 13-17M30 32c8 0 2 17 13 17M30 32h13'}], ['rect', {x:8,y:25,width:13,height:14,rx:4}], ['rect', {x:43,y:9,width:13,height:12,rx:3}], ['rect', {x:43,y:26,width:13,height:12,rx:3}], ['rect', {x:43,y:43,width:13,height:12,rx:3}]],
    process: [['path', {d:'M15 35V23a9 9 0 019-9h21m-7-7 7 7-7 7M49 29v12a9 9 0 01-9 9H19m7-7-7 7 7 7'}]],
    clock: [['circle', {cx:32,cy:32,r:21}], ['path', {d:'M32 19v14l9 6'}]],
    document: [['path', {d:'M17 8h22l10 10v38H17zM39 8v12h10M24 29h18M24 37h18M24 45h12'}]],
    direction: [['path', {d:'M32 8v48M32 15H12l-7 8 7 8h20m0-2h20l7 8-7 8H32'}]],
    book: [['path', {d:'M32 17c-8-5-17-5-25-2v35c8-3 17-3 25 2 8-5 17-5 25-2V15c-8-3-17-3-25 2zM32 17v35M14 24l10 2m-10 8 10 2m16-10 10-2m-10 12 10-2'}]],
    image: [['rect', {x:8,y:10,width:48,height:44,rx:4}], ['circle', {cx:23,cy:24,r:5}], ['path', {d:'M8 45l15-13 11 8 9-13 13 18'}]],
  };
  for (const [tag, attributes] of shapes[kind]) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}

function renderSupportedCollaboration(diagram) {
  const figure = el('figure', 'approach-foundation');
  nodeText('figcaption', 'visually-hidden', diagram.description, figure);
  const collaboration = el('div', 'approach-foundation-collaboration');
  const participant = (title, icon, className) => {
    const node = el('div', className);
    node.append(approachDiagramIcon(icon));
    nodeText('span', null, title, node);
    return node;
  };
  const exchange = clock => {
    const node = el('div', 'approach-foundation-exchange');
    node.setAttribute('aria-hidden', 'true');
    node.append(el('i', 'approach-foundation-forward'), el('i', 'approach-foundation-return'));
    if (clock) node.append(approachDiagramIcon('clock'));
    return node;
  };
  const [left, right] = diagram.roles;
  collaboration.append(participant(left.title, left.icon, `approach-foundation-role is-${left.icon}`), exchange(false),
    participant(diagram.outcome, 'film', 'approach-foundation-outcome'), exchange(true),
    participant(right.title, right.icon, `approach-foundation-role is-${right.icon}`));
  figure.append(collaboration);
  const support = el('div', 'approach-foundation-support');
  const arrow = el('span', 'approach-foundation-lift'); arrow.setAttribute('aria-hidden', 'true');
  support.append(arrow); nodeText('span', 'approach-foundation-support-label', diagram.support, support);
  figure.append(support);
  const foundation = el('div', 'approach-foundation-base');
  nodeText('strong', 'approach-foundation-title', diagram.foundation.title, foundation);
  const pillars = el('div', 'approach-foundation-pillars');
  for (const pillar of diagram.foundation.pillars) pillars.append(participant(pillar.title, pillar.icon, 'approach-foundation-pillar'));
  foundation.append(pillars); figure.append(foundation);
  return figure;
}

function renderApproachCollaboration(diagram) {
  if (diagram.type === 'workflow') return renderApproachWorkflow(diagram);
  if (diagram.type === 'supported-collaboration') return renderSupportedCollaboration(diagram);
  const host = el('div', 'approach-collaboration');
  const roles = el('div', 'approach-collaboration-roles');
  for (const [index, role] of diagram.roles.entries()) {
    const node = el('div', 'approach-collaboration-role');
    nodeText('b', null, role.title, node);
    nodeText('span', null, role.value, node);
    roles.append(node);
    if (index < diagram.exchanges.length) {
      const exchange = diagram.exchanges[index];
      const link = el('div', 'approach-collaboration-exchange');
      const arrow = nodeText('span', 'approach-collaboration-arrow', '↔', link);
      arrow.setAttribute('aria-hidden', 'true');
      nodeText('span', null, exchange.label, link);
      link.setAttribute('aria-label', `${role.title}与${diagram.roles[index + 1].title}：${exchange.label}，双向`);
      roles.append(link);
    }
  }
  if (diagram.support) {
    host.classList.add('approach-collaboration-supported');
    const platform = el('div', 'approach-collaboration-platform');
    const title = el('p', 'approach-collaboration-support-title');
    nodeText('b', null, diagram.support.title, title);
    nodeText('span', null, diagram.support.value, title);
    platform.append(title, roles);
    nodeText('p', 'approach-collaboration-support-text', diagram.support.text, platform);
    host.append(platform);
  } else {
    host.append(roles);
    nodeText('p', 'approach-collaboration-constraint', diagram.constraint, host);
  }
  nodeText('p', 'approach-collaboration-label', diagram.workflow.label, host);
  const flow = el('ol', 'approach-collaboration-workflow');
  for (const stage of diagram.workflow.stages) nodeText('li', null, stage, flow);
  host.append(flow);
  return host;
}

function renderApproachWorkflow(diagram) {
  const tabId = approachSelectedTab().id;
  const figure = el('figure', 'approach-workflow');
  nodeText('figcaption', 'visually-hidden', diagram.description, figure);
  const graph = el('div', 'approach-workflow-graph');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('approach-workflow-lines'); svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(svg.namespaceURI, 'defs');
  const marker = document.createElementNS(svg.namespaceURI, 'marker');
  const markerId = `approach-${tabId}-arrow`;
  for (const [name, value] of Object.entries({id:markerId, viewBox:'0 0 10 10', refX:9, refY:5, markerWidth:7, markerHeight:7, orient:'auto-start-reverse'})) marker.setAttribute(name, value);
  const head = document.createElementNS(svg.namespaceURI, 'path'); head.setAttribute('d', 'M1 1L9 5L1 9');
  marker.append(head); defs.append(marker); svg.append(defs); graph.append(svg);
  const nodes = new Map(diagram.nodes.map(node => [node.id, node])), elements = new Map(), groups = new Map();
  for (const group of diagram.groups) {
    const panel = el('div', 'approach-workflow-group');
    if (group.title) nodeText('strong', 'approach-workflow-group-title', group.title, panel);
    for (const row of group.rows) {
      const line = el('div', 'approach-workflow-row'); line.style.setProperty('--workflow-columns', row.length);
      for (const id of row) {
        const node = nodes.get(id), card = el('div', `approach-workflow-node is-${node.shape || 'card'}`);
        card.id = `approach-${tabId}-${id}`; card.classList.add('approach-anchor');
        const title = el('div', 'approach-workflow-node-title'); title.append(approachDiagramIcon(node.icon));
        const label = nodeText(node.href ? 'a' : 'strong', null, node.title, title);
        if (node.href) { label.href = reviewURL(node.href); bindApproachNavigation(label); }
        card.append(title); nodeText('p', null, node.text, card);
        if (node.items) {
          const list = el('ul', 'approach-workflow-items');
          for (const item of node.items) nodeText('li', null, item, list);
          card.append(list);
        }
        if (node.cycle) {
          const cycle = el('div', 'approach-workflow-cycle');
          node.cycle.forEach((step, i) => { if (i) nodeText('span', 'approach-workflow-step-arrow', '→', cycle); nodeText('span', null, step, cycle); });
          nodeText('span', 'approach-workflow-cycle-back', '↶', cycle); card.append(cycle);
        }
        elements.set(id, card); groups.set(id, group.id); line.append(card);
      }
      panel.append(line);
    }
    graph.append(panel);
  }
  graph.style.setProperty('--workflow-groups', diagram.groups.length);
  graph.classList.toggle('is-long-flow', diagram.groups.length > 3);
  const paths = diagram.connections.map(edge => {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('marker-end', `url(#${markerId})`);
    if (edge.direction === 'both') path.setAttribute('marker-start', `url(#${markerId})`);
    svg.append(path);
    const label = nodeText('span', 'approach-workflow-edge-label', edge.label, graph);
    label.hidden = !edge.label;
    return {edge, path, label};
  });
  figure.append(graph);
  const feedback = el('div', 'approach-workflow-feedback');
  const flow = el('div', 'approach-workflow-feedback-steps');
  diagram.feedback.steps.forEach((step, i) => { if (i) nodeText('span', null, '→', flow); nodeText('strong', null, step, flow); });
  feedback.append(flow);
  const targets = el('div', 'approach-workflow-feedback-targets');
  nodeText('span', null, '↶ ' + diagram.feedback.label, targets);
  for (const id of diagram.feedback.targets) {
    const link = nodeText('a', null, nodes.get(id).title, targets);
    link.href = `#approach-${tabId}-${id}`; bindApproachNavigation(link);
  }
  feedback.append(targets); figure.append(feedback);
  const returnLines = document.createElementNS(svg.namespaceURI, 'svg');
  returnLines.classList.add('approach-workflow-lines', 'approach-workflow-return-lines');
  returnLines.setAttribute('aria-hidden', 'true');
  const returns = diagram.feedback.targets.map(id => {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('marker-end', `url(#${markerId})`);
    path.dataset.to = id; returnLines.append(path);
    return {id, path};
  });
  figure.append(returnLines);
  nodeText('p', 'approach-workflow-note', diagram.note, figure);
  const methods = el('nav', 'approach-workflow-methods'); methods.setAttribute('aria-label', '专业方法');
  for (const method of diagram.methods) {
    const link = nodeText('a', null, method.label, methods);
    link.href = reviewURL(method.href); bindApproachNavigation(link);
  }
  figure.append(methods);
  const draw = () => {
    if (!graph.isConnected) return;
    const bounds = graph.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    for (const {edge, path, label} of paths) {
      const a = elements.get(edge.from).getBoundingClientRect(), b = elements.get(edge.to).getBoundingClientRect();
      const horizontal = groups.get(edge.from) !== groups.get(edge.to) && b.left > a.right;
      let x1, y1, x2, y2, d, lx, ly;
      if (horizontal) {
        x1 = a.right - bounds.left; y1 = (a.top + a.bottom) / 2 - bounds.top;
        x2 = b.left - bounds.left; y2 = (b.top + b.bottom) / 2 - bounds.top;
        const mid = (x1 + x2) / 2;
        d = `M${x1} ${y1}H${mid}V${y2}H${x2}`;
        lx = mid; ly = (y1 + y2) / 2;
      } else {
        x1 = (a.left + a.right) / 2 - bounds.left; y1 = a.bottom - bounds.top;
        x2 = (b.left + b.right) / 2 - bounds.left; y2 = b.top - bounds.top;
        const mid = (y1 + y2) / 2;
        d = `M${x1} ${y1}V${mid}H${x2}V${y2}`;
        lx = (x1 + x2) / 2; ly = mid;
      }
      path.setAttribute('d', d);
      path.dataset.from = edge.from; path.dataset.to = edge.to;
      label.style.left = `${lx}px`; label.style.top = `${ly}px`;
    }
    const frame = figure.getBoundingClientRect(), back = feedback.getBoundingClientRect();
    returnLines.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
    for (const {id, path} of returns) {
      const target = elements.get(id).getBoundingClientRect();
      const x = target.left - frame.left - 12, y = (target.top + target.bottom) / 2 - frame.top;
      path.setAttribute('d', `M${x} ${back.top - frame.top}V${y}H${target.left - frame.left}`);
    }
  };
  approachWorkflowObserver = new ResizeObserver(draw);
  approachWorkflowObserver.observe(graph);
  approachWorkflowObserver.observe(figure);
  for (const node of elements.values()) approachWorkflowObserver.observe(node);
  return figure;
}

async function renderApproach() {
  const sequence = ++approachRenderSequence;
  const host = $('#approach-body');
  const requested = new URL(location.href).searchParams.get('tab') || 'story';
  const selected = approachContent ? approachSelectedTab().id : requested;
  if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs();
  host.setAttribute('aria-labelledby', `approach-tab-${selected}`);
  // Hash navigation must keep the mounted text and its browser reading position.
  if (host.dataset.tab === selected) { restoreApproachAnchor(); return; }
  delete host.dataset.tab;
  host.classList.remove('approach-cycle', 'approach-diagram');
  approachIndexObserver?.disconnect();
  approachWorkflowObserver?.disconnect();
  const index = $('#approach-index'), sidebar = $('#approach-sidebar');
  index.replaceChildren(); sidebar.hidden = true;
  host.textContent = '正在读取制作方法…';
  try {
    if (!approachDocument) approachDocument = api('/api/production-approach').catch(error => { approachDocument = null; throw error; });
    const guide = await approachDocument;
    // A fast tab switch must not let the previous request replace the selected text.
    const current = new URL(location.href).searchParams.get('tab') || 'story';
    if (sequence !== approachRenderSequence || current !== requested || $('#approach-view').hidden) return;
    approachContent = guide;
    host.replaceChildren();
    if (!guide) { nodeText('p', 'approach-note', '本实例尚未提供制作方法文档。已有故事与审阅功能可继续使用。', host); return; }
    const tab = approachSelectedTab();
    if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs();
    host.setAttribute('aria-labelledby', `approach-tab-${tab.id}`);
    if (!tab.layout) nodeText('h2', null, tab.title, host);
    if (tab.lead) nodeText('p', 'approach-lead', tab.lead, host);
    $('#approach-index-title').textContent = tab.label;
    index.setAttribute('aria-label', `${tab.label}阅读目录`);
    for (const section of tab.sections) {
      const a = nodeText('a', 'source-chapter-button', section.title, index); a.href = `#approach-${tab.id}-${section.id}`;
      bindApproachNavigation(a);
    }
    sidebar.hidden = !!tab.layout || !tab.sections.length;
    host.classList.toggle('approach-cycle', tab.layout?.type === 'cycle');
    host.classList.toggle('approach-diagram', tab.layout?.type === 'diagram');
    let content = host;
    if (tab.layout?.type === 'cycle') {
      content = el('div', 'approach-cycle-rows');
      const back = el('div', 'approach-cycle-return');
      nodeText('span', null, tab.layout.return_label, back);
      content.append(back); host.append(content);
    }
    for (const section of tab.sections) {
      const article = el('section', 'approach-section'); article.id = `approach-${tab.id}-${section.id}`;
      const diagramOnly = section.diagram && section.blocks?.length === 0;
      if (diagramOnly) {
        article.setAttribute('aria-label', section.title);
      } else if (tab.layout?.type === 'cycle') {
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
      if (section.diagram) {
        article.classList.add('approach-section-expanded');
        article.append(renderApproachCollaboration(section.diagram));
      }
      content.append(article);
    }
    host.dataset.tab = tab.id;
    approachIndexObserver = new ResizeObserver(scheduleApproachIndex);
    for (const node of [host, sidebar, $('.workspace-topbar')]) approachIndexObserver.observe(node);
    restoreApproachAnchor();
  } catch (error) {
    if (sequence === approachRenderSequence && !$('#approach-view').hidden)
      host.textContent = `制作方法加载失败：${error.message}。刷新可重试；已有故事与审阅数据不受影响。`;
  }
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
