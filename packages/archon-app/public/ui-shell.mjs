import { clean, translate, overrides } from './ui-copy.mjs';
import { createSelectEnhancer } from './ui-select.mjs';

// Enhance the application chrome only. Never rewrite authored messages, file
// contents, editable values, identifiers or embedded artifact documents.
const excluded = 'script,style,svg,pre,code,textarea,input,[contenteditable="true"],[data-user-content],[data-select-copy],.file-preview-rendered,.file-preview-source';
const icons = {
  '💬':'message-square','🪑':'armchair','📦':'package','🧬':'dna','⏰':'clock','🔗':'link','🔌':'plug','⚙':'settings',
  '👥':'users','🏛':'layers','👑':'shield-check','📜':'history','📰':'newspaper','🗂':'folder-open','🧠':'brain','🎨':'palette',
  '🛡':'shield','🔒':'lock','🔐':'shield-check','🟢':'circle-dot','🟠':'circle-dot','🔴':'circle-dot','📸':'camera',
  '🚀':'play','⬆':'upload','✨':'sparkles','⚡':'activity','📎':'paperclip','🎯':'compass','📡':'git-branch',
  '📊':'chart-column','🌐':'globe','🌊':'anchor','🕸':'network','📄':'file-text','📝':'file-code','✏':'pencil',
  '📂':'folder-open','🖼':'image','🔍':'search','🔄':'refresh-cw','↻':'refresh-cw','🗑':'trash-2','🗜':'archive',
  '🗖':'maximize','🗗':'minimize','📋':'list-checks','▶':'play','⏹':'square','✓':'check','✗':'x','↗':'arrow-up-right',
  '↩':'rotate-ccw','◂':'chevron-left','▸':'chevron-right','🧭':'compass','🔬':'flask-conical','🛠':'settings',
  '🏗':'code','⚓':'anchor','♾':'refresh-cw','➕':'plus','🤖':'cpu','📥':'inbox','📤':'upload','📨':'send',
  '🔑':'key-round','👤':'user-round','📢':'megaphone','💻':'monitor','☁':'cloud','🌙':'moon','☀':'sun',
  '💾':'save','⚠':'triangle-alert','⬇':'download','🔁':'refresh-cw','📈':'chart-no-axes-combined','🕰':'clock',
  '📁':'folder','📚':'book-open','💡':'lightbulb','✅':'circle-check','❌':'circle-x','🔧':'settings','🖥':'monitor',
};
const glyphs = /\p{Extended_Pictographic}(?:[\uFE0F\uFE0E])?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0F\uFE0E])?)*|[✓✗↻↗↩◂▸▶🗖🗗🗜]/gu;
const navIcons = {workbench:'message-square',seats:'armchair',artifacts:'package',skills:'dna',schedules:'clock',architect:'git-branch',mcps:'plug',hands:'settings',mesh:'users'};
const textState = new WeakMap();
const attributeState = new WeakMap();
let language = document.documentElement.lang === 'zh' ? 'zh' : 'en';
let pending = false;
let observer;
const helpEntries = new Map();
let activeHelp = null;
let nextHelpId = 0;
const selects = createSelectEnhancer({
  icon,
  translate: (text) => translate(text, language),
  onOpen: () => {
    closeHelp();
    document.querySelectorAll('.ui-more-actions[open]').forEach((more) => { more.open = false; });
  },
});

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'ui-icon'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `/assets/lucide.svg#${name}`); svg.append(use);
  return svg;
}

function renderText(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(excluded) || !node.data.trim()) return;
  if (parent.closest('.msg-body') && !parent.closest('button,.agy-file-dock')) return;
  const previous = textState.get(node);
  if (previous?.rendered === node.data) return;
  const source = node.data;
  const matches = [...source.matchAll(glyphs)];
  const noIcons = parent.closest('option,optgroup,.nav-label-text,[data-i18n]');
  if (matches.length && !noIcons) {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      if (match.index > offset) fragment.append(document.createTextNode(source.slice(offset, match.index)));
      const key = match[0].replace(/[\uFE0F\uFE0E]/g, '');
      fragment.append(icon(icons[key] || 'circle-dot'));
      offset = match.index + match[0].length;
    }
    if (offset < source.length) fragment.append(document.createTextNode(source.slice(offset)));
    const texts = [...fragment.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
    node.replaceWith(fragment); texts.forEach(renderText);
    return;
  }
  const original = previous?.rendered === source ? previous.source : source;
  const base = matches.length ? original.replace(glyphs, '') : original;
  const value = parent.closest('[data-i18n]') ? base : translate(base, language);
  const rendered = `${base.match(/^\s*/)[0]}${value.trim()}${base.match(/\s*$/)[0]}`;
  node.data = rendered;
  textState.set(node, { source: original, rendered });
}

function renderAttributes(root) {
  root.querySelectorAll('[title],[placeholder],[aria-label],optgroup[label]').forEach((el) => {
    if (el.closest('[data-user-content],[data-select-copy],.file-preview-rendered,pre,code') || (el.closest('.msg-body') && !el.closest('button'))) return;
    const saved = attributeState.get(el) || {};
    for (const attr of ['title','placeholder','aria-label','label']) {
      if (!el.hasAttribute(attr) || (attr === 'label' && el.tagName !== 'OPTGROUP')) continue;
      const current = el.getAttribute(attr);
      const original = saved[attr]?.rendered === current ? saved[attr].source : current;
      const rendered = translate(original, language);
      if (rendered !== current) el.setAttribute(attr, rendered);
      saved[attr] = { source: original, rendered };
    }
    attributeState.set(el, saved);
  });
}

function closeHelp(restoreFocus = false) {
  if (!activeHelp) return;
  const { button, popup } = activeHelp;
  popup.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  activeHelp = null;
  if (restoreFocus && button.isConnected) button.focus({ preventScroll: true });
}

function positionHelp() {
  if (!activeHelp) return;
  const { button, popup } = activeHelp;
  const anchor = button.getBoundingClientRect();
  const bounds = popup.getBoundingClientRect();
  const edge = 12;
  const below = anchor.bottom + 8;
  const above = anchor.top - bounds.height - 8;
  const top = below + bounds.height <= window.innerHeight - edge || above < edge ? below : above;
  popup.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - bounds.width - edge))}px`;
  popup.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - bounds.height - edge))}px`;
}

function helpPopover(element) {
  if (element.closest('.ui-help-popover')) return;
  const heading = element.parentElement.querySelector(':scope > .card-title, :scope > #safe-mode-drawer-title, :scope > .ui-title-row > .card-title, :scope > .ui-title-row > #safe-mode-drawer-title');
  if (!heading) return;
  let row = heading.closest('.ui-title-row');
  if (!row) {
    row = document.createElement('div'); row.className = 'ui-title-row';
    heading.before(row); row.append(heading);
  }
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'ui-help-trigger'; button.append(icon('circle-help'));
  button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-haspopup', 'dialog');
  const popup = document.createElement('div');
  popup.id = `ui-help-${++nextHelpId}`; popup.className = 'ui-help-popover'; popup.hidden = true;
  popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-modal', 'false'); popup.tabIndex = -1;
  button.setAttribute('aria-controls', popup.id);
  element.classList.add('ui-help-body'); popup.append(element); row.append(button); document.body.append(popup);
  const entry = { button, popup, heading }; helpEntries.set(button, entry);
  button.addEventListener('click', (event) => {
    if (activeHelp === entry) { closeHelp(); return; }
    closeHelp(); activeHelp = entry; popup.hidden = false;
    button.setAttribute('aria-expanded', 'true'); positionHelp();
    if (event.detail === 0) popup.focus({ preventScroll: true });
  });
}

function syncHelp() {
  for (const [button, entry] of helpEntries) {
    if (!button.isConnected) {
      if (activeHelp === entry) closeHelp();
      entry.popup.remove(); helpEntries.delete(button); continue;
    }
    const label = `${language === 'zh' ? '说明' : 'How it works'}: ${entry.heading.textContent.trim()}`;
    button.setAttribute('aria-label', label);
    entry.popup.setAttribute('aria-label', label);
  }
  positionHelp();
}

function disclosure(element, title = 'How it works', advanced = false) {
  if (!element || element.closest('details,.ui-help-popover') || element.querySelector('input,select,textarea,button')) return;
  if (!advanced) { helpPopover(element); return; }
  const details = document.createElement('details'); details.className = advanced ? 'ui-disclosure ui-advanced' : 'ui-disclosure';
  const summary = document.createElement('summary'); summary.append(icon(advanced ? 'chevron-down' : 'circle-help'), document.createTextNode(title));
  element.before(details); details.append(summary, element); element.classList.add('ui-help-body');
}

function structure(root) {
  const toolbar = root.querySelector('.topbar-right');
  if (toolbar && !toolbar.querySelector('.ui-more-actions')) {
    const more = document.createElement('details'); more.className = 'ui-more-actions';
    const summary = document.createElement('summary'); summary.append(icon('chevron-down'), document.createTextNode('More'));
    const menu = document.createElement('div'); menu.className = 'ui-more-menu';
    [...toolbar.children].filter((el) => !el.matches('#btn-toggle-safe-mode,#btn-toggle-prompt-history') && !el.getAttribute('onclick')?.includes("'/briefing'")).forEach((el) => menu.append(el));
    more.append(summary, menu); toolbar.append(more);
    menu.querySelectorAll('button[title]').forEach((button) => { if (!button.textContent.replace(glyphs, '').trim()) button.append(document.createTextNode(button.title)); });
    menu.addEventListener('click', (event) => { if (event.target.closest('[onclick]')) more.open = false; });
  }
  root.querySelectorAll('.card-header > div > div:not(.card-title)').forEach((el) => {
    if (el.textContent.trim().length > 80 && !el.id && !el.querySelector('.card-title')) disclosure(el);
    else if (el.hasAttribute('data-i18n') && /_sub$/.test(el.dataset.i18n)) disclosure(el);
  });
  root.querySelectorAll('[data-ui-explanation]').forEach((el) => disclosure(el));
  const roundTable = root.querySelector('#rsi-rounds-tbody')?.closest('table');
  if (roundTable && !roundTable.closest('details')) {
    const group = document.createElement('div'); roundTable.before(group); group.append(roundTable); disclosure(group, 'Round details', true);
  }
  root.querySelectorAll('[data-ui-disclosure]').forEach((el) => disclosure(el, el.dataset.uiDisclosure, true));
  root.querySelectorAll('table').forEach((table) => {
    if (table.closest('.ui-table-scroll,.msg-body,.file-preview-rendered')) return;
    const scroll = document.createElement('div'); scroll.className = 'ui-table-scroll'; scroll.tabIndex = 0;
    scroll.setAttribute('role','region'); scroll.setAttribute('aria-label', language === 'zh' ? '数据表，可横向滚动' : 'Data table, scroll horizontally');
    table.before(scroll); scroll.append(table);
  });
  root.querySelectorAll('[style*="grid-template-columns"]').forEach((el) => {
    const columns = el.style.gridTemplateColumns;
    if (columns.includes('340px')) el.classList.add('ui-mesh-grid');
    else if (columns.includes('repeat(5')) el.classList.add('ui-stage-grid');
    else if (/^1fr 1fr$/.test(columns)) el.classList.add('ui-two-columns');
    else if (columns.includes('repeat(auto-fit')) el.classList.add('ui-auto-grid');
  });
  root.querySelectorAll('button,.btn,.mini-btn,.chip-btn,.composer-pill-btn,.cos-metric-pill').forEach((button) => {
    if (button.closest('.msg-body,.file-preview-rendered,[data-user-content]')) return;
    const action = button.getAttribute('onclick') || '';
    if (/delete|recover|clearChatHistory|remove/i.test(action)) button.classList.add('ui-danger');
    if (/save|submit|sendMeshTeam|createScheduleFromForm/i.test(action) || button.type === 'submit') button.classList.add('ui-action-primary');
    if (button.matches('.cos-metric-pill[onclick]') && button.tagName !== 'BUTTON') {
      button.setAttribute('role','button'); button.tabIndex = 0;
      if (!button.dataset.keyboardBound) {
        button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); } });
        button.dataset.keyboardBound = 'true';
      }
    }
  });
}

function syncSidebar() {
  const shell = document.getElementById('os-shell-grid');
  const toggle = document.getElementById('rail-toggle-btn');
  if (!shell || !toggle) return;
  const collapsed = shell.classList.contains('rail-collapsed');
  const name = collapsed ? 'panel-left-open' : 'panel-left-close';
  if (!toggle.querySelector('[data-rail-icon="open"]')) {
    const open = icon('panel-left-open'); open.setAttribute('data-rail-icon', 'open');
    const close = icon('panel-left-close'); close.setAttribute('data-rail-icon', 'close');
    toggle.replaceChildren(open, close);
  }
  toggle.dataset.icon = name;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? (language === 'zh' ? '展开导航' : 'Expand sidebar') : (language === 'zh' ? '收起导航' : 'Collapse sidebar'));
}

function update() {
  pending = false; observer?.disconnect();
  const root = document.body;
  structure(root);
  root.querySelectorAll('.nav-btn').forEach((button) => {
    const target = button.querySelector('.nav-icon'); const name = navIcons[button.id.replace('nav-','')];
    if (target && name && !target.querySelector('svg')) target.replaceChildren(icon(name));
    button.setAttribute('aria-current', button.classList.contains('active') ? 'page' : 'false');
  });
  syncSidebar();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode); nodes.forEach(renderText);
  renderAttributes(root);
  syncHelp();
  selects.sync();
  root.querySelectorAll('button,[role="button"]').forEach((button) => {
    if (!button.textContent.trim() && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title || (language === 'zh' ? '操作' : 'Action'));
  });
  observe();
}
function scheduleUpdate() { if (!pending) { pending = true; requestAnimationFrame(update); } }
function observe() { observer?.observe(document.body, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['title','placeholder','class','disabled','hidden','required','label','style'] }); }
function changeLanguage(lang) {
  language = lang === 'zh' ? 'zh' : 'en'; document.documentElement.lang = language;
  try { localStorage.setItem('archon-language', language); } catch {}
  // Restore canonical source text before translating, including attached drawers.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const state = textState.get(walker.currentNode);
    if (state && walker.currentNode.data === state.rendered && !walker.currentNode.parentElement.closest('[data-i18n]')) {
      walker.currentNode.data = state.source; textState.delete(walker.currentNode);
    }
  }
  update();
}

document.addEventListener('click', (event) => {
  if (activeHelp && !activeHelp.button.contains(event.target) && !activeHelp.popup.contains(event.target)) closeHelp();
  document.querySelectorAll('.ui-more-actions[open]').forEach((more) => { if (!more.contains(event.target)) more.open = false; });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activeHelp) { closeHelp(true); event.preventDefault(); }
  if (event.key === 'Escape') document.querySelectorAll('.ui-more-actions[open]').forEach((more) => { more.open = false; more.querySelector('summary').focus(); });
});
document.addEventListener('pointerdown', (event) => {
  if (activeHelp && !activeHelp.button.contains(event.target) && !activeHelp.popup.contains(event.target)) closeHelp();
}, true);
document.addEventListener('scroll', (event) => {
  if (activeHelp && !activeHelp.popup.contains(event.target)) closeHelp();
}, true);
window.addEventListener('resize', positionHelp);
for (const name of ['alert', 'confirm', 'prompt']) {
  const nativeDialog = window[name].bind(window);
  window[name] = (message, ...args) => nativeDialog(translate(String(message), language), ...args);
}
window.ArchonUI = { icon, syncSidebar, translate: (text) => translate(text, language), refresh: scheduleUpdate };
window.addEventListener('archon:language', (event) => changeLanguage(event.detail));
const legacy = window.ArchonLegacyCopy;
if (legacy) for (const [key, [en, zh]] of Object.entries(overrides)) { legacy.en[key] = en; legacy.zh[key] = zh; }
observer = new MutationObserver((records) => {
  // Native select visibility can change independently of the surrounding form.
  // Other inline styling (popup positioning, charts, animations) needs no scan.
  if (records.some((record) => record.attributeName !== 'style' || record.target.tagName === 'SELECT')) scheduleUpdate();
});
let initial = 'en'; try { initial = localStorage.getItem('archon-language') || 'en'; } catch {}
window.setLanguage(initial);
