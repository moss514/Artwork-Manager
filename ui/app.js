/* =====================================================================
 * Tauri API 初始化
 * ===================================================================== */
const { convertFileSrc } = window.__TAURI__.core;
const { open, save, ask } = window.__TAURI__.dialog;
const { readTextFile, writeTextFile, mkdir, copyFile, exists, remove } = window.__TAURI__.fs;
const { openPath } = window.__TAURI__.opener;

/* =====================================================================
 * 数据层（真正落盘，自动同步 + 防抖）
 * ===================================================================== */
let APP_DIR = localStorage.getItem('moss_app_dir') || null;

const Store = (() => {
  let works = [];
  let listeners = [];
  let saveTimeout = null;

  const emit = () => listeners.forEach(fn => fn());

  function reorder() {
    works.forEach((w, i) => { w.order = i; });
  }

  function saveToDisk() {
    if (!APP_DIR) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const data = JSON.stringify(works, null, 2);
        const filePath = `${APP_DIR}/library.json`.replace(/\\/g, '/');
        await writeTextFile(filePath, data);
      } catch (e) {
        console.error('保存数据失败详情:', e);
        showToast('保存数据失败: ' + e);
      }
    }, 500);
  }

  return {
    all: () => works.slice(),
    get: id => works.find(w => w.id === id),
    subscribe: fn => listeners.push(fn),
    notify: () => { emit(); saveToDisk(); },

    seed(list) {
      works = list.slice();
      reorder();
    },
    add(work) {
      works.unshift(work);
      reorder();
      emit();
      saveToDisk();
    },
    update(id, patch) {
      const w = works.find(x => x.id === id);
      if (!w) return;
      Object.assign(w, patch, { updatedAt: Date.now() });
      emit();
      saveToDisk();
    },
    remove(id) {
      works = works.filter(w => w.id !== id);
      reorder();
      emit();
      saveToDisk();
    },
    move(fromId, toId, position) {
      if (fromId === toId) return;
      const from = works.findIndex(w => w.id === fromId);
      if (from < 0) return;
      const [item] = works.splice(from, 1);
      let to = works.findIndex(w => w.id === toId);
      if (to < 0) { works.splice(from, 0, item); return; }
      if (position === 'after') to++;
      works.splice(to, 0, item);
      reorder();
      emit();
      saveToDisk();
    }
  };
})();

/* =====================================================================
 * 常量与工具
 * ===================================================================== */
const TAG_COLORS = [
  '#e76f51', '#f4a261', '#d4a017', '#2a9d8f', '#457b9d',
  '#7b5ea7', '#b56576', '#6b705c', '#c1666b', '#3d7ea6'
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const escText = escapeHtml(text);
  const escQ = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return escText.replace(new RegExp(escQ, 'gi'), m => `<mark>${m}</mark>`);
  } catch {
    return escText;
  }
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ];
}

function tagColors(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [dr, dg, db] = [r, g, b].map(v => Math.round(v * 0.55));
  return {
    bg: `rgba(${r},${g},${b},0.13)`,
    border: `rgba(${r},${g},${b},0.35)`,
    text: `rgb(${dr},${dg},${db})`
  };
}

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

function formatDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function uid() {
  return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function getFileName(path) {
  return path.split(/[/\\]/).pop();
}

function getImageUrl(path) {
  if (!path) return '';
  if (path.startsWith('data:') || path.startsWith('http')) return path;
  return convertFileSrc(path);
}

/* =====================================================================
 * 页面状态
 * ===================================================================== */
const state = {
  query: '',
  sort: 'created-desc',
  dragMode: false
};

/* =====================================================================
 * DOM 引用
 * ===================================================================== */
const appMain = $('#app-main');
const listBar = $('#list-bar');
const dragToggle = $('#drag-toggle');
const searchInput = $('#search-input');
const sortSelect = $('#sort-select');
const lightbox = $('#lightbox');
const toastEl = $('#toast');
const tooltipEl = $('#tooltip');
const newWorkBtn = $('#new-work-btn');
const backBtn = $('#back-btn');

/* =====================================================================
 * 路由
 * ===================================================================== */
function parseHash() {
  const m = location.hash.match(/^#\/work\/(.+)$/);
  if (m) return { view: 'detail', workId: m[1] };
  return { view: 'grid', workId: null };
}

let lastView = null;
let savedGridScroll = 0;

function handleRouteChange() {
  const route = parseHash();
  if (lastView === 'grid' && route.view === 'detail') {
    savedGridScroll = window.scrollY;
  }
  render();
  if (lastView === 'detail' && route.view === 'grid') {
    window.scrollTo(0, savedGridScroll);
  }
  lastView = route.view;
}

window.addEventListener('hashchange', handleRouteChange);

/* =====================================================================
 * 标签颜色查找 / 全局操作
 * ===================================================================== */
function findTagColor(name) {
  for (const w of Store.all()) {
    const t = w.tags.find(t => t.name === name);
    if (t) return t.color;
  }
  return null;
}

function setTagColor(name, color) {
  let touched = false;
  Store.all().forEach(w => {
    const t = w.tags.find(t => t.name === name);
    if (t && t.color !== color) {
      t.color = color;
      w.updatedAt = Date.now();
      touched = true;
    }
  });
  if (touched) Store.notify();
}

function removeTagEverywhere(name) {
  let touched = false;
  Store.all().forEach(w => {
    const idx = w.tags.findIndex(t => t.name === name);
    if (idx >= 0) {
      w.tags.splice(idx, 1);
      w.updatedAt = Date.now();
      touched = true;
    }
  });
  if (touched) Store.notify();
}

/* =====================================================================
 * 筛选 / 排序 / 渲染
 * ===================================================================== */
function matchesQuery(w, q) {
  if (!q) return true;
  const lq = q.toLowerCase();
  return w.title.toLowerCase().includes(lq) ||
         w.notes.toLowerCase().includes(lq) ||
         w.tags.some(t => t.name.toLowerCase().includes(lq));
}

function sortWorks(list, sortKey) {
  switch (sortKey) {
    case 'created-desc': return list.sort((a, b) => b.createdAt - a.createdAt);
    case 'created-asc':  return list.sort((a, b) => a.createdAt - b.createdAt);
    case 'updated-desc': return list.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'title-asc':    return list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    case 'manual':       return list.sort((a, b) => a.order - b.order);
    default:             return list;
  }
}

function getVisibleWorks() {
  let list = Store.all();
  if (state.query) list = list.filter(w => matchesQuery(w, state.query));
  return sortWorks(list, state.sort);
}

function renderTopbar(route) {
  const isDetail = route.view === 'detail';
  document.body.classList.toggle('view-detail', isDetail);
  document.body.classList.toggle('view-grid', !isDetail);
  newWorkBtn.hidden = isDetail;
  backBtn.hidden = !isDetail;
}

function updateListBar(route) {
  if (route.view !== 'grid' || state.sort !== 'manual') {
    listBar.hidden = true;
    return;
  }
  listBar.hidden = false;
  dragToggle.textContent = state.dragMode ? '🔒 拖拽模式：开' : '🔓 拖拽模式：关';
  dragToggle.classList.toggle('on', state.dragMode);
}

function renderGridItem(w) {
  const q = state.query;

  const titleHtml = w.title
    ? highlight(w.title, q)
    : '<span class="placeholder">未命名画作</span>';

  const thumbHtml = w.work
    ? `<img src="${getImageUrl(w.work.path)}" alt="" draggable="false">`
    : `<div class="grid-thumb-empty">＋</div>`;

  const maxTags = 3;
  const visibleTags = w.tags.slice(0, maxTags);
  const hiddenTags = w.tags.slice(maxTags);
  const extraTip = hiddenTags.map(t => t.name).join(' · ');

  const tagsHtml = visibleTags.map(t => {
    const c = tagColors(t.color);
    const hit = q && t.name.toLowerCase().includes(q.toLowerCase());
    return `<button class="tag${hit ? ' tag-hit' : ''}"
      data-action="search-tag" data-tag="${escapeHtml(t.name)}"
      style="background:${c.bg};border-color:${c.border};color:${c.text}"
      title="左键搜索 · 右键改色">${escapeHtml(t.name)}</button>`;
  }).join('') +
    (hiddenTags.length > 0
      ? `<span class="tag-more" data-tooltip="${escapeHtml(extraTip)}">+${hiddenTags.length}</span>`
      : '');

  return `
    <article class="grid-item" data-id="${w.id}" draggable="${state.dragMode && state.sort === 'manual'}">
      <div class="grid-title">${titleHtml}</div>
      <div class="grid-thumb">
        ${thumbHtml}
        <div class="grid-hover" data-action="noop">
          <button class="grid-menu-btn" data-action="menu" title="更多操作">⋯</button>
        </div>
      </div>
      <div class="grid-tags">${tagsHtml}</div>
    </article>
  `;
}

function renderCard(w) {
  const q = state.query;

  const titleHtml = w.title
    ? highlight(w.title, q)
    : '<span class="placeholder">未命名画作</span>';

  const refsHtml =
    w.refs.map((r, i) => `
      <div class="ref-thumb" data-action="view" data-src="${getImageUrl(r.path)}" title="${escapeHtml(r.name)}">
        <img src="${getImageUrl(r.path)}" alt="" draggable="false">
        <div class="ref-tools" data-action="noop">
          <button class="img-tool" data-action="img-download" data-path="${r.path}" data-name="${escapeHtml(r.name)}" title="导出这张参考图">⤓</button>
        </div>
      </div>
    `).join('') +
    `<button class="ref-add" data-action="import-refs" title="添加参考图">＋</button>`;

  const workHtml = w.work
    ? `<img class="work-img" src="${getImageUrl(w.work.path)}" alt="${escapeHtml(w.work.name)}"
         data-action="view" data-src="${getImageUrl(w.work.path)}" draggable="false">
       <div class="work-tools" data-action="noop">
         <button class="img-tool" data-action="img-download" data-path="${w.work.path}" data-name="${escapeHtml(w.work.name)}" title="导出画作">⤓</button>
       </div>`
    : `<button class="empty-add" data-action="import-work">＋<span>添加画作</span></button>`;

  const notesHtml = w.notes
    ? `<div class="note-text" data-action="edit-notes">${highlight(w.notes, q)}</div>`
    : `<div class="note-text placeholder" data-action="edit-notes">点击添加笔记</div>`;

  const tagsHtml = w.tags.map(t => {
    const c = tagColors(t.color);
    const hit = q && t.name.toLowerCase().includes(q.toLowerCase());
    return `<button class="tag${hit ? ' tag-hit' : ''}"
      data-action="search-tag" data-tag="${escapeHtml(t.name)}"
      style="background:${c.bg};border-color:${c.border};color:${c.text}"
      title="左键搜索 · 右键改色">${escapeHtml(t.name)}</button>`;
  }).join('');

  const copyHtml = w.copy
    ? `<span class="copy-item" data-action="copy-click" title="点击另存为并打开">
         📎 ${escapeHtml(w.copy.name)}
         <button class="copy-remove" data-action="remove-copy" title="移除">×</button>
       </span>`
    : `<button class="copy-add" data-action="import-copy">📎 ＋ 复印件</button>`;

  return `
    <article class="card" data-id="${w.id}">
      <header class="card-head">
        <h2 class="card-title" data-action="edit-title">${titleHtml}</h2>
        <span class="card-time">导入于 ${formatDate(w.createdAt)}</span>
        <div class="card-copy">${copyHtml}</div>
        <button class="card-menu-btn" data-action="menu" title="更多操作">⋯</button>
      </header>

      <div class="card-body">
        <aside class="refs-col">${refsHtml}</aside>
        <div class="work-col">${workHtml}</div>
        <aside class="notes-col">${notesHtml}</aside>
      </div>

      <footer class="card-tags">
        ${tagsHtml}
        <button class="tag-add" data-action="add-tag">＋ 标签</button>
      </footer>
    </article>
  `;
}

function renderGrid() {
  const all = Store.all();
  const visible = getVisibleWorks();

  if (all.length === 0) {
    appMain.innerHTML = `
      <div class="empty-state">
        <p>还没有画作</p>
        <button class="primary-btn" data-action="new-work">＋ 新建画作</button>
      </div>`;
    return;
  }

  if (visible.length === 0) {
    appMain.innerHTML = `
      <div class="empty-state">
        <p>没有匹配「${escapeHtml(state.query)}」的画作</p>
      </div>`;
    return;
  }

  appMain.innerHTML = `<div class="card-grid">${visible.map(renderGridItem).join('')}</div>`;
}

function renderDetail(workId) {
  const w = Store.get(workId);
  if (!w) {
    location.hash = '';
    return;
  }

  const q = state.query;
  let html = renderCard(w);

  if (q) {
    const others = Store.all().filter(x => x.id !== workId && matchesQuery(x, q));
    html += `
      <div class="related-bar">
        <span class="related-title">「<b>${escapeHtml(q)}</b>」的相关内容 · ${others.length} 幅</span>
        <button class="related-clear" data-action="clear-search">清空搜索</button>
      </div>`;

    if (others.length > 0) {
      html += sortWorks(others.slice(), state.sort).map(renderCard).join('');
    } else {
      html += `<div class="related-empty">没有其他画作匹配「${escapeHtml(q)}」</div>`;
    }
  }

  appMain.innerHTML = html;
}

function commitActiveEditors() {
  const active = document.activeElement;
  if (!active) return;
  if (active.classList.contains('note-editor')) {
    const card = active.closest('.card');
    if (card) {
      const w = Store.get(card.dataset.id);
      if (w) { w.notes = active.value; w.updatedAt = Date.now(); }
    }
  } else if (active.classList.contains('title-editor')) {
    const container = active.closest('.card') || active.closest('.grid-item');
    if (container) {
      const w = Store.get(container.dataset.id);
      if (w) { w.title = active.value.trim(); w.updatedAt = Date.now(); }
    }
  }
}

function render() {
  commitActiveEditors();
  const route = parseHash();
  renderTopbar(route);
  updateListBar(route);
  if (route.view === 'detail') {
    renderDetail(route.workId);
  } else {
    renderGrid();
  }
}

/* =====================================================================
 * 弹大图 / Toast / Tooltip
 * ===================================================================== */
function openLightbox(src) {
  lightbox.querySelector('img').src = src;
  lightbox.hidden = false;
  document.body.classList.add('no-scroll');
}

function closeLightbox() {
  lightbox.hidden = true;
  lightbox.querySelector('img').src = '';
  document.body.classList.remove('no-scroll');
}

lightbox.addEventListener('click', e => {
  if (e.target === lightbox) closeLightbox();
});

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2800);
}

let tooltipTimer = null;
function positionTooltip(target) {
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  let top = rect.top - tipRect.height - 6;
  if (top < 8) top = rect.bottom + 6;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}
function showTooltip(target, text) {
  if (!text) return;
  tooltipEl.textContent = text;
  tooltipEl.hidden = false;
  positionTooltip(target);
}
function hideTooltip() { tooltipEl.hidden = true; }

appMain.addEventListener('mouseover', e => {
  const host = e.target.closest('[data-tooltip]');
  if (!host) return;
  clearTimeout(tooltipTimer);
  const text = host.dataset.tooltip;
  tooltipTimer = setTimeout(() => showTooltip(host, text), 150);
});

appMain.addEventListener('mouseout', e => {
  const host = e.target.closest('[data-tooltip]');
  if (!host) return;
  if (e.relatedTarget && host.contains(e.relatedTarget)) return;
  clearTimeout(tooltipTimer);
  hideTooltip();
});

window.addEventListener('scroll', hideTooltip, true);

/* =====================================================================
 * 弹出层管理
 * ===================================================================== */
let activeMenu = null;
let colorPanel = null;

function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
}
function closeColorPanel() {
  if (colorPanel) { colorPanel.remove(); colorPanel = null; }
}

document.addEventListener('click', e => {
  if (activeMenu && !activeMenu.contains(e.target) && !e.target.closest('[data-action="menu"]')) {
    closeMenu();
  }
  if (colorPanel && !colorPanel.contains(e.target)) {
    closeColorPanel();
  }
});

/* =====================================================================
 * 本地文件操作核心
 * ===================================================================== */
async function copyFileToRepo(sourcePath, workId, subDir, originalName) {
  const ext = originalName.includes('.') ? originalName.split('.').pop() : 'png';
  const newName = `${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
  const targetDir = `${APP_DIR}/${subDir}/${workId}`.replace(/\\/g, '/');
  const targetPath = `${targetDir}/${newName}`.replace(/\\/g, '/');
  
  await mkdir(targetDir, { recursive: true });
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

async function exportImage(srcPath, defaultName) {
  try {
    const savePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (savePath) {
      await copyFile(srcPath, savePath);
      showToast('已成功导出到：' + savePath);
    }
  } catch (err) {
    showToast('导出失败：' + err);
    console.error(err);
  }
}

async function exportAndOpenCopy(srcPath, defaultName) {
  try {
    const savePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'SAI2 File', extensions: ['sai2'] }]
    });
    if (savePath) {
      await copyFile(srcPath, savePath);
      showToast('已另存为，正在尝试打开...');
      try {
        await openPath(savePath);
      } catch (err) {
        console.warn('自动打开被拦截，请手动去文件夹中双击打开', err);
      }
    }
  } catch (err) {
    showToast('另存为失败：' + err);
    console.error(err);
  }
}

async function importFileAction(workId, field, extra) {
  const isCopy = field === 'copy';
  const filters = isCopy
    ? [{ name: 'SAI2 File', extensions: ['sai2'] }, { name: 'All Files', extensions: ['*'] }]
    : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }];

  const selected = await open({
    multiple: field === 'refs',
    filters
  });

  if (!selected) return;
  const files = Array.isArray(selected) ? selected : [selected];
  const w = Store.get(workId);
  if (!w) return;

  try {
    if (field === 'work') {
      const path = await copyFileToRepo(files[0], workId, 'works', getFileName(files[0]));
      Store.update(workId, { work: { name: getFileName(files[0]), path } });
    } else if (field === 'refs') {
      const newRefs = [...w.refs];
      for (const f of files) {
        const path = await copyFileToRepo(f, workId, 'refs', getFileName(f));
        newRefs.push({ name: getFileName(f), path });
      }
      Store.update(workId, { refs: newRefs });
    } else if (field === 'copy') {
      const path = await copyFileToRepo(files[0], workId, 'copies', getFileName(files[0]));
      Store.update(workId, { copy: { name: getFileName(files[0]), path } });
    }
  } catch (err) {
    showToast('文件操作失败：' + err);
    console.error(err);
  }
}

/* =====================================================================
 * 就地编辑：笔记 / 标题
 * ===================================================================== */
function startEditNotes(el, workId) {
  const w = Store.get(workId);
  if (!w) return;
  const col = el.closest('.notes-col');
  if (!col) return;

  const textarea = document.createElement('textarea');
  textarea.className = 'note-editor';
  textarea.value = w.notes;
  textarea.placeholder = '记录这幅画作的笔记…';
  el.remove();
  col.appendChild(textarea);
  textarea.focus();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const val = textarea.value;
    if (w.notes !== val) {
      w.notes = val;
      Store.update(workId, { notes: val });
    }
    const div = document.createElement('div');
    div.className = 'note-text' + (val ? '' : ' placeholder');
    div.dataset.action = 'edit-notes';
    div.innerHTML = val ? highlight(val, state.query) : '点击添加笔记';
    textarea.replaceWith(div);
  };

  textarea.addEventListener('blur', finish);
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      textarea.value = w.notes;
      textarea.blur();
    }
  });
}

function startEditTitle(el, workId) {
  const w = Store.get(workId);
  if (!w) return;

  const originalTag = el.tagName.toLowerCase();
  const originalClass = el.className;
  const originalAction = el.dataset.action || '';

  const input = document.createElement('input');
  input.className = 'title-editor';
  input.value = w.title;
  input.placeholder = '未命名画作';
  el.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const val = input.value.trim();
    if (w.title !== val) {
      Store.update(workId, { title: val });
    }
    const newEl = document.createElement(originalTag);
    newEl.className = originalClass;
    if (originalAction) newEl.dataset.action = originalAction;
    newEl.innerHTML = val
      ? highlight(val, state.query)
      : '<span class="placeholder">未命名画作</span>';
    input.replaceWith(newEl);
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = w.title; input.blur(); }
  });
}

/* =====================================================================
 * 标签：添加 / 搜索 / 改色
 * ===================================================================== */
function startAddTag(btn, workId) {
  const footer = btn.closest('.card-tags');
  if (!footer || footer.querySelector('.tag-input-wrap')) return;

  const wrap = document.createElement('span');
  wrap.className = 'tag-input-wrap';
  wrap.innerHTML = `<input class="tag-input" placeholder="标签名" autocomplete="off">
                    <div class="tag-suggest" hidden></div>`;
  btn.after(wrap);
  btn.hidden = true;

  const input = wrap.querySelector('.tag-input');
  const suggest = wrap.querySelector('.tag-suggest');
  input.focus();

  const allTagNames = () => {
    const set = new Set();
    Store.all().forEach(w => w.tags.forEach(t => set.add(t.name)));
    return [...set];
  };

  let finished = false;
  const finish = (add) => {
    if (finished) return;
    finished = true;
    const val = input.value.trim();
    wrap.remove();
    btn.hidden = false;

    if (add && val) {
      const w = Store.get(workId);
      if (w && !w.tags.some(t => t.name === val)) {
        const color = findTagColor(val) || hashColor(val);
        w.tags.push({ name: val, color });
        Store.update(workId, { tags: w.tags });
      }
    }
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) { suggest.hidden = true; return; }
    const matches = allTagNames().filter(t => t.includes(q) && t !== q).slice(0, 6);
    if (!matches.length) { suggest.hidden = true; return; }
    suggest.innerHTML = matches
      .map(t => `<div class="tag-suggest-item">${escapeHtml(t)}</div>`)
      .join('');
    suggest.hidden = false;
  });

  suggest.addEventListener('mousedown', e => {
    const item = e.target.closest('.tag-suggest-item');
    if (!item) return;
    e.preventDefault();
    input.value = item.textContent;
    finish(true);
  });

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
}

function searchTag(name) {
  searchInput.value = name;
  state.query = name;
  render();
}

function openTagColorPanel(x, y, name) {
  closeColorPanel();
  const panel = document.createElement('div');
  panel.className = 'popover tag-color-panel';
  panel.innerHTML = `
    <div class="swatches">
      ${TAG_COLORS.map(c => `<button class="swatch" data-color="${c}" style="background:${c}"></button>`).join('')}
    </div>
    <button data-del="1">删除此标签</button>
  `;
  document.body.appendChild(panel);
  const pw = panel.offsetWidth;
  panel.style.left = Math.max(8, Math.min(x, window.innerWidth - pw - 8)) + 'px';
  panel.style.top = Math.min(y + 8, window.innerHeight - panel.offsetHeight - 8) + 'px';
  colorPanel = panel;

  panel.addEventListener('click', e => {
    const sw = e.target.closest('.swatch');
    if (sw) {
      setTagColor(name, sw.dataset.color);
      closeColorPanel();
      return;
    }
    if (e.target.closest('[data-del]')) {
      removeTagEverywhere(name);
      closeColorPanel();
    }
  });
}

/* =====================================================================
 * 卡片菜单 / 导出
 * ===================================================================== */
function openCardMenu(btn, workId, context) {
  closeMenu();
  const w = Store.get(workId);
  if (!w) return;

  const menu = document.createElement('div');
  menu.className = 'popover card-menu';
  menu.innerHTML = `
    <button data-menu="rename">重命名</button>
    <button data-menu="time">修改导入时间</button>
    <button data-menu="delete" class="danger">删除画作</button>
  `;
  document.body.appendChild(menu);

  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
  activeMenu = menu;

  menu.addEventListener('click', async e => {
    const item = e.target.closest('[data-menu]');
    if (!item) return;
    const action = item.dataset.menu;

    if (action === 'rename') {
      closeMenu();
      const sel = context === 'grid'
        ? `.grid-item[data-id="${workId}"] .grid-title`
        : `.card[data-id="${workId}"] .card-title`;
      const titleEl = $(sel);
      if (titleEl) startEditTitle(titleEl, workId);
    } else if (action === 'time') {
      showTimeEditor(menu, workId);
    } else if (action === 'delete') {
      closeMenu();
      
      // 使用 Tauri 原生 ask，避免被 WebView 静默拦截
      const isConfirmed = await ask(`确定删除「${w.title || '未命名画作'}」？\n\n注意：这会同时删除本地文件夹中的所有源文件！`, {
        title: '确认删除',
        kind: 'warning',
        okLabel: '确认删除',
        cancelLabel: '取消'
      });

      if (isConfirmed) {
        const title = w.title || '未命名画作';
        
        let dirs = [];
        if (APP_DIR) {
          dirs = [
            `${APP_DIR}/works/${workId}`,
            `${APP_DIR}/refs/${workId}`,
            `${APP_DIR}/copies/${workId}`
          ].map(d => d.replace(/\\/g, '/'));
        }

        Store.remove(workId);
        if (context === 'detail') location.hash = '';
        
        setTimeout(async () => {
          let failed = false;
          for (const dir of dirs) {
            try {
              if (await exists(dir)) {
                await remove(dir, { recursive: true });
              }
            } catch (err) {
              failed = true;
              console.error(`删除失败: ${dir}`, err);
            }
          }
          
          if (failed) {
            showToast(`「${title}」数据已删，但部分源文件被系统占用，请手动清理。`);
          } else {
            showToast(`「${title}」及本地源文件已彻底删除`);
          }
        }, 500);
      }
    }
  });
}

function showTimeEditor(menu, workId) {
  const w = Store.get(workId);
  if (!w) return;
  const d = new Date(w.createdAt);
  const p = n => String(n).padStart(2, '0');
  const val = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;

  menu.innerHTML = `
    <div class="time-editor">
      <input type="datetime-local" value="${val}">
      <button data-menu="save-time">确定</button>
    </div>
  `;
  menu.querySelector('[data-menu="save-time"]').addEventListener('click', () => {
    const v = menu.querySelector('input').value;
    if (v) {
      const ts = new Date(v).getTime();
      if (!isNaN(ts)) Store.update(workId, { createdAt: ts });
    }
    closeMenu();
  });
}

/* =====================================================================
 * 主事件委托
 * ===================================================================== */
appMain.addEventListener('click', e => {
  const actionEl = e.target.closest('[data-action]');
  const action = actionEl ? actionEl.dataset.action : null;

  if (action === 'new-work') { newWork(); return; }
  if (action === 'noop') return;

  const route = parseHash();

  /* ---------- 网格视图 ---------- */
  if (route.view === 'grid') {
    if (action === 'menu') {
      e.stopPropagation();
      const item = e.target.closest('.grid-item');
      if (item) openCardMenu(actionEl, item.dataset.id, 'grid');
      return;
    }
    if (state.dragMode) return;

    if (action === 'search-tag') {
      e.stopPropagation();
      searchTag(actionEl.dataset.tag);
      return;
    }

    const item = e.target.closest('.grid-item');
    if (item) location.hash = `#/work/${item.dataset.id}`;
    return;
  }

  /* ---------- 详情视图 ---------- */
  if (action === 'clear-search') {
    searchInput.value = '';
    state.query = '';
    render();
    return;
  }

  const card = e.target.closest('.card');
  const workId = card ? card.dataset.id : null;
  if (!workId || !action) return;

  switch (action) {
    case 'view': {
      const src = actionEl.dataset.src;
      if (src) openLightbox(src);
      break;
    }
    case 'img-download':
      exportImage(actionEl.dataset.path, actionEl.dataset.name);
      break;
    case 'import-work': importFileAction(workId, 'work'); break;
    case 'import-refs': importFileAction(workId, 'refs'); break;
    case 'import-copy': importFileAction(workId, 'copy'); break;
    case 'edit-notes': startEditNotes(actionEl, workId); break;
    case 'edit-title': startEditTitle(actionEl, workId); break;
    case 'search-tag':
      e.stopPropagation();
      searchTag(actionEl.dataset.tag);
      break;
    case 'add-tag': startAddTag(actionEl, workId); break;
    case 'menu':
      e.stopPropagation();
      openCardMenu(actionEl, workId, 'detail');
      break;
    case 'copy-click': {
      const w = Store.get(workId);
      if (w && w.copy && w.copy.path) {
        exportAndOpenCopy(w.copy.path, w.copy.name);
      }
      break;
    }
    case 'remove-copy':
      e.stopPropagation();
      Store.update(workId, { copy: null });
      break;
  }
});

appMain.addEventListener('contextmenu', e => {
  const tag = e.target.closest('.tag');
  if (!tag) return;
  e.preventDefault();
  openTagColorPanel(e.clientX, e.clientY, tag.dataset.tag);
});

/* =====================================================================
 * 拖拽排序
 * ===================================================================== */
let draggingId = null;

appMain.addEventListener('dragstart', e => {
  const item = e.target.closest('.grid-item');
  if (!item || !state.dragMode || state.sort !== 'manual') return;
  if (parseHash().view !== 'grid') return;
  draggingId = item.dataset.id;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', draggingId); } catch (_) {}
});

appMain.addEventListener('dragend', e => {
  const item = e.target.closest('.grid-item');
  if (item) item.classList.remove('dragging');
  $$('.grid-item').forEach(c => c.classList.remove('drop-before', 'drop-after'));
  draggingId = null;
});

appMain.addEventListener('dragover', e => {
  if (!state.dragMode || !draggingId) return;
  const item = e.target.closest('.grid-item');
  if (!item || item.dataset.id === draggingId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = item.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  $$('.grid-item').forEach(c => {
    if (c !== item) c.classList.remove('drop-before', 'drop-after');
  });
  item.classList.toggle('drop-after', after);
  item.classList.toggle('drop-before', !after);
});

appMain.addEventListener('dragleave', e => {
  const item = e.target.closest('.grid-item');
  if (item) item.classList.remove('drop-before', 'drop-after');
});

appMain.addEventListener('drop', e => {
  if (!state.dragMode || !draggingId) return;
  const item = e.target.closest('.grid-item');
  if (!item || item.dataset.id === draggingId) return;
  e.preventDefault();
  const rect = item.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  Store.move(draggingId, item.dataset.id, after ? 'after' : 'before');
  draggingId = null;
});

/* =====================================================================
 * 顶部栏事件
 * ===================================================================== */
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = searchInput.value.trim();
    render();
  }, 200);
});

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  if (state.sort !== 'manual') state.dragMode = false;
  render();
});

dragToggle.addEventListener('click', () => {
  state.dragMode = !state.dragMode;
  render();
});

backBtn.addEventListener('click', () => { location.hash = ''; });
newWorkBtn.addEventListener('click', newWork);

/* =====================================================================
 * 新建画作
 * ===================================================================== */
function newWork() {
  const w = {
    id: uid(),
    title: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: 0,
    work: null,
    refs: [],
    copy: null,
    notes: '',
    tags: []
  };

  searchInput.value = '';
  state.query = '';

  Store.add(w);
  location.hash = `#/work/${w.id}`;

  setTimeout(() => {
    const titleEl = document.querySelector(`.card[data-id="${w.id}"] .card-title`);
    if (titleEl) startEditTitle(titleEl, w.id);
  }, 60);
}

/* =====================================================================
 * 全局键盘
 * ===================================================================== */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!lightbox.hidden) { closeLightbox(); return; }
    if (activeMenu) { closeMenu(); return; }
    if (colorPanel) { closeColorPanel(); return; }
    if (parseHash().view === 'detail') location.hash = '';
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft') {
    if (parseHash().view === 'detail') {
      e.preventDefault();
      location.hash = '';
    }
  }
});

/* =====================================================================
 * 启动与初始化（连接本地磁盘）
 * ===================================================================== */
async function initApp() {
  if (!APP_DIR) {
    const selected = await open({ directory: true, title: '请选择一个空文件夹作为画作数据仓库' });
    if (!selected) {
      appMain.innerHTML = `<div class="empty-state"><p>必须选择一个文件夹才能启动。</p><button class="primary-btn" onclick="location.reload()">重试</button></div>`;
      return;
    }
    APP_DIR = selected;
    localStorage.setItem('moss_app_dir', APP_DIR);
  }

  try {
    await mkdir(`${APP_DIR}/works`.replace(/\\/g, '/'), { recursive: true });
    await mkdir(`${APP_DIR}/refs`.replace(/\\/g, '/'), { recursive: true });
    await mkdir(`${APP_DIR}/copies`.replace(/\\/g, '/'), { recursive: true });
    
    const libraryFile = `${APP_DIR}/library.json`.replace(/\\/g, '/');
    const hasData = await exists(libraryFile);
    
    if (hasData) {
      const text = await readTextFile(libraryFile);
      const list = JSON.parse(text);
      Store.seed(list);
    } else {
      Store.seed([]);
    }
  } catch (err) {
    console.error(err);
    showToast('读取数据目录失败，请检查权限。');
    localStorage.removeItem('moss_app_dir');
    return;
  }

  Store.subscribe(render);
  handleRouteChange();
}

initApp();