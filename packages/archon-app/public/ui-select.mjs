// Custom select presentation, backed by the original native form control.
// Existing value/selectedIndex setters, onchange handlers and form submission
// keep working; the popup renders labels as text, never as authored HTML.
export function createSelectEnhancer({ icon, translate, onOpen = () => {} }) {
  const entries = new Map();
  const resetForms = new WeakSet();
  let active = null;
  let nextId = 0;

  function close(restoreFocus = false) {
    if (!active) return;
    const entry = active;
    entry.panel.hidden = true;
    entry.button.setAttribute('aria-expanded', 'false');
    entry.button.removeAttribute('aria-activedescendant');
    active = null;
    if (restoreFocus && entry.button.isConnected) entry.button.focus({ preventScroll: true });
  }

  function records(entry) {
    return [...entry.select.options].filter((option) => !option.hidden).map((option) => ({
      option,
      index: option.index,
      label: option.textContent.trim(),
      group: option.parentElement.tagName === 'OPTGROUP' ? option.parentElement : null,
      disabled: option.disabled || (option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled),
    }));
  }

  function position(entry) {
    if (active !== entry) return;
    const anchor = entry.button.getBoundingClientRect();
    const edge = 12;
    const below = window.innerHeight - anchor.bottom - 8 - edge;
    const above = anchor.top - 8 - edge;
    const upwards = below < 220 && above > below;
    const room = Math.max(70, upwards ? above : below);
    entry.panel.style.width = `${Math.min(window.innerWidth - edge * 2, Math.max(anchor.width, 260))}px`;
    entry.panel.style.maxHeight = `${Math.min(340, room)}px`;
    const box = entry.panel.getBoundingClientRect();
    entry.panel.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - box.width - edge))}px`;
    entry.panel.style.top = `${Math.max(edge, Math.min(upwards ? anchor.top - box.height - 8 : anchor.bottom + 8, window.innerHeight - box.height - edge))}px`;
  }

  function highlight(entry, index, scroll = false) {
    entry.highlighted = index;
    for (const item of entry.list.querySelectorAll('[role="option"]')) {
      item.classList.toggle('is-active', Number(item.dataset.index) === index);
    }
    if (index < 0) { entry.button.removeAttribute('aria-activedescendant'); return; }
    const id = `${entry.id}-option-${index}`;
    entry.button.setAttribute('aria-activedescendant', id);
    if (scroll) entry.list.querySelector(`[id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(entry, index) {
    const option = records(entry).find((item) => item.index === index);
    if (!option || option.disabled || entry.select.disabled) return;
    entry.select.selectedIndex = index;
    entry.button.removeAttribute('aria-invalid');
    entry.select.dispatchEvent(new Event('input', { bubbles: true }));
    entry.select.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
    syncEntry(entry);
  }

  function renderOptions(entry, preserveHighlight = false) {
    const query = entry.search.value.trim().toLocaleLowerCase();
    const items = records(entry).filter((item) => !query || item.label.toLocaleLowerCase().includes(query));
    entry.visibleItems = items;
    const fragment = document.createDocumentFragment();
    let previousGroup;
    for (const item of items) {
      if (item.group && item.group !== previousGroup) {
        const heading = document.createElement('div');
        heading.className = 'ui-select-group'; heading.textContent = item.group.label;
        fragment.append(heading);
      }
      previousGroup = item.group;
      const option = document.createElement('div');
      option.id = `${entry.id}-option-${item.index}`; option.className = 'ui-select-option';
      option.dataset.index = item.index; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.option.selected));
      if (item.disabled) option.setAttribute('aria-disabled', 'true');
      const label = document.createElement('span'); label.textContent = item.label;
      option.append(label, icon('check'));
      option.addEventListener('pointermove', () => {
        if (!item.disabled && entry.highlighted !== item.index) highlight(entry, item.index);
      });
      option.addEventListener('click', () => choose(entry, item.index));
      fragment.append(option);
    }
    if (!items.length) {
      const empty = document.createElement('div'); empty.className = 'ui-select-empty';
      empty.textContent = translate('No matching options'); fragment.append(empty);
    }
    entry.list.replaceChildren(fragment);
    const enabled = items.filter((item) => !item.disabled);
    const previous = preserveHighlight && enabled.find((item) => item.index === entry.highlighted);
    highlight(entry, previous?.index ?? enabled.find((item) => item.option.selected)?.index ?? enabled[0]?.index ?? -1);
    position(entry);
  }

  function open(entry) {
    if (entry.select.disabled || !entry.select.isConnected) return;
    close(); onOpen(); active = entry;
    entry.search.value = ''; entry.searchRow.hidden = records(entry).length < 8;
    entry.panel.hidden = false; entry.button.setAttribute('aria-expanded', 'true');
    renderOptions(entry); position(entry);
    highlight(entry, entry.highlighted, true);
  }

  function onKeyDown(entry, event) {
    const inSearch = event.target === entry.search;
    if (event.key === 'Escape' && active === entry) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { if (active === entry) close(inSearch); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (active !== entry) { open(entry); return; }
      const available = entry.visibleItems.filter((item) => !item.disabled);
      if (!available.length) return;
      let index = available.findIndex((item) => item.index === entry.highlighted);
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = available.length - 1;
      else index = (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
      highlight(entry, available[index].index, true); return;
    }
    if (event.key === 'Enter' || (!inSearch && event.key === ' ')) {
      event.preventDefault();
      if (active === entry) choose(entry, entry.highlighted); else open(entry);
      return;
    }
    if (!inSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (active !== entry) open(entry);
      const now = Date.now();
      entry.typeahead = now - entry.lastTyped < 700 ? entry.typeahead + event.key : event.key;
      entry.lastTyped = now;
      const match = entry.visibleItems.find((item) => !item.disabled && item.label.toLocaleLowerCase().startsWith(entry.typeahead.toLocaleLowerCase()));
      if (match) highlight(entry, match.index, true);
    }
  }

  function fieldLabel(select) {
    const label = select.labels?.[0] || select.closest('.form-field')?.querySelector(':scope > label');
    return select.getAttribute('aria-label') || label?.textContent.trim() || select.title || translate('Select an option');
  }

  function syncEntry(entry) {
    const { select, wrapper, button } = entry;
    if (!select.isConnected) return;
    wrapper.hidden = select.hidden || select.style.display === 'none';
    button.disabled = select.disabled;
    button.setAttribute('aria-label', fieldLabel(select));
    button.setAttribute('aria-required', String(select.required));
    entry.list.setAttribute('aria-label', fieldLabel(select));
    entry.search.setAttribute('aria-label', translate('Search options...'));
    entry.search.placeholder = translate('Search options...');
    const option = select.options[select.selectedIndex];
    const label = option?.textContent.trim() || translate('Select an option');
    entry.label.textContent = label; button.title = label;
    button.dataset.placeholder = String(!select.value);
    const signature = JSON.stringify([select.selectedIndex, [...select.options].map((item) => [item.value, item.textContent, item.disabled, item.hidden, item.parentElement.label, item.parentElement.disabled])]);
    if (signature !== entry.signature) {
      entry.signature = signature;
      if (active === entry) renderOptions(entry, true);
    }
    if (select.disabled && active === entry) close();
  }

  function enhance(select) {
    const id = `ui-select-${++nextId}`;
    const wrapper = document.createElement('span'); wrapper.className = 'ui-select';
    wrapper.dataset.selectId = select.id || id;
    for (const property of ['width', 'maxWidth', 'minWidth', 'flex', 'flexBasis']) {
      if (select.style[property]) wrapper.style[property] = select.style[property];
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-select-trigger';
    button.dataset.selectCopy = ''; button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${id}-list`);
    const label = document.createElement('span'); label.className = 'ui-select-value';
    const chevron = icon('chevron-down'); chevron.classList.add('ui-select-chevron'); button.append(label, chevron);
    const panel = document.createElement('div'); panel.className = 'ui-select-panel'; panel.hidden = true; panel.dataset.selectCopy = '';
    const searchRow = document.createElement('div'); searchRow.className = 'ui-select-search'; searchRow.append(icon('search'));
    const search = document.createElement('input'); search.type = 'search'; search.autocomplete = 'off'; searchRow.append(search);
    const list = document.createElement('div'); list.id = `${id}-list`; list.className = 'ui-select-options'; list.setAttribute('role', 'listbox');
    panel.append(searchRow, list);
    select.before(wrapper); wrapper.append(select, button); document.body.append(panel);
    select.classList.add('ui-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    const entry = { id, select, wrapper, button, label, panel, searchRow, search, list, highlighted:-1, visibleItems:[], typeahead:'', lastTyped:0 };
    entries.set(select, entry);
    button.addEventListener('click', () => { if (active === entry) close(); else open(entry); });
    button.addEventListener('keydown', (event) => onKeyDown(entry, event));
    search.addEventListener('keydown', (event) => onKeyDown(entry, event));
    search.addEventListener('input', () => renderOptions(entry));
    select.addEventListener('change', () => syncEntry(entry));
    select.addEventListener('focus', () => button.focus({ preventScroll:true }));
    select.addEventListener('invalid', (event) => {
      event.preventDefault(); button.setAttribute('aria-invalid', 'true'); button.focus();
    });
    // These controllers also change selection programmatically, without firing
    // change events. Delegate the native setters and update only the proxy UI.
    for (const property of ['value', 'selectedIndex']) {
      const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
      Object.defineProperty(select, property, {
        configurable:true,
        get() { return native.get.call(this); },
        set(value) { native.set.call(this, value); syncEntry(entry); },
      });
    }
    if (select.form && !resetForms.has(select.form)) {
      resetForms.add(select.form);
      select.form.addEventListener('reset', () => queueMicrotask(sync));
    }
    syncEntry(entry);
  }

  function sync() {
    for (const [select, entry] of entries) {
      if (!select.isConnected) {
        if (active === entry) close();
        entry.panel.remove(); entries.delete(select);
      }
    }
    document.querySelectorAll('select:not([multiple])').forEach((select) => {
      if (!select.closest('.msg-body,.file-preview-rendered,[data-user-content]') && !entries.has(select)) enhance(select);
    });
    entries.forEach(syncEntry);
  }

  function outside(event) {
    if (active && !active.wrapper.contains(event.target) && !active.panel.contains(event.target)) close();
  }
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('click', outside);
  document.addEventListener('scroll', (event) => {
    if (active && !active.panel.contains(event.target)) close();
  }, true);
  window.addEventListener('resize', () => { if (active) position(active); });
  return { sync, close };
}
