// mydash 前端：实时刷新、搜索、相对时间、Mermaid / PDF 按需加载
(() => {
  // 译文由 /i18n.js 注入（window.__T）；键是英文原文，'a|b' 单复数，'@@xx' 上下文
  const T = (key, vars) => {
    let s = (window.__T && window.__T[key]) || key;
    if (s.includes('@@')) s = s.slice(0, s.indexOf('@@'));
    if (s.includes('|')) { const [one, other] = s.split('|'); s = vars && Number(vars.n) === 1 ? one : other; }
    return vars ? s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all)) : s;
  };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const body = document.body;
  const page = body.className.replace(/^.*page-(\w+).*$/, '$1');

  // ---------- 提示 ----------
  let toastTimer;
  function toast(msg, ms = 2400) {
    const t = $('.toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- 相对时间 ----------
  function rel(iso) {
    const d = new Date(iso); const s = (Date.now() - d) / 1000;
    if (s < 45) return T('just now');
    if (s < 3600) return T('{n} minute ago|{n} minutes ago', { n: Math.round(s / 60) });
    if (s < 86400) return T('{n} hour ago|{n} hours ago', { n: Math.round(s / 3600) });
    if (s < 86400 * 7) return T('{n} day ago|{n} days ago', { n: Math.round(s / 86400) });
    return null;
  }
  function tickTimes() {
    for (const t of $$('time[data-rel]')) {
      const r = rel(t.getAttribute('datetime'));
      if (!t.dataset.abs) t.dataset.abs = t.textContent;
      t.textContent = r ? r : t.dataset.abs;
      t.title = t.dataset.abs;
    }
  }
  tickTimes(); setInterval(tickTimes, 30000);

  // ---------- 前端错误回报到服务日志 ----------
  let reported = 0;
  function report(message) {
    if (reported++ > 5) return;
    try { fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify({ page: location.pathname + location.search, message: String(message).slice(0, 500) }) }); } catch {}
  }
  window.mydashReport = report;
  window.addEventListener('error', e => report(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => report('unhandled: ' + (e.reason?.message || e.reason)));

  // ---------- 本地偏好与请求 ----------
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  async function post(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  {
    const sp = new URLSearchParams(location.search);
    const show = sp.get('show');
    if (show === 'unread' || show === 'all') {
      store.set('mydash.show', show);
      sp.delete('show');
      history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp : '') + location.hash);
    }
  }

  // ---------- 列表筛选：搜索 + 全部/未读 ----------
  function showMode() { return store.get('mydash.show') === 'unread' ? 'unread' : 'all'; }
  // 按来源 agent 筛选：只有列表里有两种以上来源时才有这组按钮
  function agentMode() { const v = store.get('mydash.agent') || 'all'; return $(`.agent-seg button[data-agent="${v}"]`) ? v : 'all'; }
  function catMode() { const v = store.get('mydash.cat') || 'all'; return $(`.cat-seg button[data-cat="${v}"]`) ? v : 'all'; }
  function applyFilter() {
    if (!$('.timeline')) return;
    const q = $('#q');
    const terms = q ? q.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
    const onlyUnread = showMode() === 'unread';
    const am = agentMode();
    const cm = catMode();
    const agentOk = el => (am === 'all' || el.dataset.agent === am) && (cm === 'all' || el.dataset.cat === cm);
    let any = false;
    for (const day of $$('.day')) {
      let vis = 0;
      for (const e of $$('.entry', day)) {
        const ok = terms.every(t => e.dataset.search.includes(t)) && (!onlyUnread || e.dataset.unread === '1') && agentOk(e);
        e.hidden = !ok; if (ok) vis++;
      }
      day.hidden = vis === 0; if (vis) any = true;
    }
    const cards = $$('.card-wrap');
    for (const c of cards) c.hidden = !(terms.every(t => c.dataset.search.includes(t)) && (!onlyUnread || c.dataset.unread === '1') && agentOk(c));
    const ps = $('.pinned-sec'); if (ps) ps.hidden = cards.length > 0 && cards.every(c => c.hidden);
    const nm = $('.no-match'); if (nm) nm.hidden = any || (!terms.length && am === 'all' && cm === 'all');
    const ar = $('.all-read'); if (ar) ar.hidden = any || terms.length > 0 || !onlyUnread || am !== 'all' || cm !== 'all';
    $$('.cat-seg button').forEach(b => b.classList.toggle('on', b.dataset.cat === cm));
    $$('.seg button[data-show]').forEach(b => b.classList.toggle('on', b.dataset.show === showMode()));
    $$('.agent-seg button').forEach(b => b.classList.toggle('on', b.dataset.agent === am));
    // 「筛选」按钮上标出开着几个筛选（类型、来源）
    const fb = $('.filter-btn'); if (fb) { const k = (cm !== 'all') + (am !== 'all'); const em = $('em', fb); em.textContent = k; em.hidden = !k; fb.classList.toggle('active', k > 0); }
    if (page === 'home') {
      $('.tb-all')?.classList.toggle('on', showMode() === 'all');
      $('.tb-unread')?.classList.toggle('on', showMode() === 'unread');
    }
  }
  // 全文搜索：标题、摘要里没有，但正文里提到了的条目
  let bsTimer = null, bsSeq = 0;
  function bodySearch() {
    clearTimeout(bsTimer);
    bsTimer = setTimeout(async () => {
      const q = $('#q')?.value.trim() || ''; const seq = ++bsSeq;
      let box = $('.ft-results');
      if (q.length < 2) { box?.remove(); return; }
      let hits = [];
      try { hits = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' })).json(); } catch { return; }
      if (seq !== bsSeq) return;
      const shown = new Set($$('.entry:not([hidden])').map(e => e.dataset.id));
      const extra = hits.filter(h => !shown.has(h.id));
      if (!extra.length) { box?.remove(); return; }
      if (!box) { box = document.createElement('section'); box.className = 'ft-results'; ($('.timeline') || $('#main')).before(box); }
      box.innerHTML = `<h2 class="sec-h">${T('Mentioned in the text')}<em>${extra.length}</em></h2><ol class="dg-list">${extra.map(h => `<li class="dg-row"><a href="${h.url}"><span class="dg-t">${h.title.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span><span class="dg-x">${h.snippet}</span></a></li>`).join('')}</ol>`;
    }, 280);
  }
  function bindList() {
    const q = $('#q');
    if (q) {
      try { const saved = sessionStorage.getItem('mydash.q'); if (saved && !q.value) q.value = saved; } catch {}
      q.addEventListener('input', () => { applyFilter(); try { sessionStorage.setItem('mydash.q', q.value); } catch {} bodySearch(); });
      if (q.value) bodySearch();
    }
    for (const b of $$('.seg button[data-show]')) b.addEventListener('click', () => { store.set('mydash.show', b.dataset.show); applyFilter(); });
    for (const b of $$('.agent-seg button')) b.addEventListener('click', () => { store.set('mydash.agent', b.dataset.agent); applyFilter(); });
    for (const b of $$('.cat-seg button')) b.addEventListener('click', () => { store.set('mydash.cat', b.dataset.cat); applyFilter(); });
    // 手机上的「筛选」：打开 / 收起类型、来源那一块
    const fb = $('.filter-btn');
    fb?.addEventListener('click', () => { const tools = fb.closest('.list-tools'); const open = !tools.classList.contains('open'); tools.classList.toggle('open', open); fb.setAttribute('aria-expanded', String(open)); });
    const ma = $('.mark-all');
    ma?.addEventListener('click', async () => {
      ma.disabled = true;
      try {
        const r = await post('/api/read-all', ma.dataset.ids ? { ids: ma.dataset.ids.split(',') } : { project: ma.closest('.list-tools')?.dataset.project || '' });
        toast(r.marked ? T('Marked {n} item as read|Marked {n} items as read', { n: r.marked }) : T('Everything is already read'));
        await Promise.all([refreshList(), refreshSide()]);
      } catch { ma.disabled = false; toast(T('That did not work. Try again in a moment.')); }
    });
    applyFilter();
  }
  bindList();

  // 标题和主屏幕图标上的未读数
  function updateBadge() {
    const n = Number($('#side')?.dataset.unread || 0);
    const base = document.querySelector('meta[name="mydash-title"]')?.content || document.title;
    document.title = (n ? `(${n}) ` : '') + base;
    const tb = $('.tb-badge'); if (tb) { tb.textContent = n; tb.hidden = !n; }
    try { if (n && navigator.setAppBadge) navigator.setAppBadge(n); else if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch {}
  }
  updateBadge();

  // ---------- 电脑端收起边栏（按设备记住）----------
  const root = document.documentElement;
  const isCollapsed = () => root.classList.contains('side-collapsed');
  function setCollapsed(on) {
    root.classList.toggle('side-collapsed', on);
    store.set('mydash.side', on ? 'collapsed' : 'open');
    const b = $('.side-collapse');
    if (b) { b.setAttribute('aria-label', on ? T('Expand sidebar') : T('Collapse sidebar')); b.title = on ? T('Expand sidebar (shortcut: [)') : T('Collapse sidebar (shortcut: [)'); b.setAttribute('aria-pressed', String(on)); }
  }

  // ---------- 页面语言：按设备记在 cookie 里，服务端据此出页面（命令行和推送不受影响）----------
  const setLang = l => { document.cookie = `mydash_lang=${l}; path=/; max-age=31536000; samesite=lax`; location.reload(); };
  $('.lang-btn')?.addEventListener('click', e => setLang(e.currentTarget.dataset.lang));
  window.mydashSetLang = setLang;

  // ---------- 外观：自动 / 浅色 / 深色（按设备记住）----------
  // 实际判断在 <head> 的 window.mydashTheme 里：自动 = 晚上或系统是深色时用深色
  const THEME_NAME = { auto: T('Auto'), light: T('Light'), dark: T('Dark') };
  const themeMode = () => root.dataset.themeMode || 'auto';
  function syncThemeMenu() {
    for (const b of $$('[data-theme-set]')) b.setAttribute('aria-checked', String(b.dataset.themeSet === themeMode()));
    const btn = $('.theme-btn');
    if (btn) btn.title = themeMode() === 'auto' ? T('Appearance: auto (now {mode})', { mode: root.dataset.theme === 'dark' ? T('dark') : T('light') }) : T('Appearance: {mode}', { mode: THEME_NAME[themeMode()] });
  }
  function applyTheme(mode, animate = false) {
    if (!window.mydashTheme) return;
    const before = root.dataset.theme;
    const run = () => window.mydashTheme(mode);
    const vt = animate && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches ? document.startViewTransition(run) : (run(), null);
    Promise.resolve(vt?.updateCallbackDone).catch(() => {}).then(() => {
      syncThemeMenu();
      if (root.dataset.theme !== before) document.dispatchEvent(new CustomEvent('mydash:theme'));
    });
  }
  function openThemeMenu(open, byKeyboard = false) {
    const m = $('#theme-menu'); if (!m) return;
    m.hidden = !open; $('.theme-btn')?.setAttribute('aria-expanded', String(open));
    // 只有用键盘打开时才把焦点移进菜单，手指点开不出现焦点框
    if (open && byKeyboard) (m.querySelector('[aria-checked="true"]') || m.querySelector('button'))?.focus({ preventScroll: true });
  }
  $('.theme-btn')?.addEventListener('click', e => { e.stopPropagation(); openThemeMenu($('#theme-menu')?.hidden, e.detail === 0); });
  for (const b of $$('[data-theme-set]')) b.addEventListener('click', () => {
    const mode = b.dataset.themeSet;
    store.set('mydash.theme', mode);
    applyTheme(mode, true); openThemeMenu(false);
    toast(mode === 'auto' ? T('Appearance: auto (now {mode})', { mode: root.dataset.theme === 'dark' ? T('dark') : T('light') }) : T('Appearance: {mode}', { mode: THEME_NAME[mode] }));
  });
  window.mydashSetThemeMode = mode => { store.set('mydash.theme', mode); applyTheme(mode, true); };
  document.addEventListener('click', e => { if (!e.target.closest('.theme')) openThemeMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#theme-menu')?.hidden) { openThemeMenu(false); $('.theme-btn')?.focus(); } });
  // 自动模式：到点就换（每分钟看一次，切回页面、系统外观变了也重新判断）
  const recheck = () => { if (themeMode() === 'auto') applyTheme('auto', document.visibilityState === 'visible'); };
  setInterval(recheck, 60000);
  document.addEventListener('visibilitychange', recheck);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', recheck);
  // 别的标签页改了外观，这里也跟着变
  window.addEventListener('storage', e => { if (e.key === 'mydash.theme') applyTheme(e.newValue || 'auto'); });
  syncThemeMenu();

  // 项目页：大标题滚出屏幕后顶栏显示项目名
  let titleIO;
  function bindTitle() {
    titleIO?.disconnect();
    const t = $('.proj-title'); if (!t || !('IntersectionObserver' in window)) return;
    titleIO = new IntersectionObserver(([en]) => body.classList.toggle('title-out', !en.isIntersecting && en.boundingClientRect.top < 80), { rootMargin: '-48px 0px 0px 0px' });
    titleIO.observe(t);
  }
  bindTitle();

  // ---------- 项目边栏 ----------
  function openSide(open) {
    body.classList.toggle('side-open', open);
    $('.side-toggle')?.setAttribute('aria-expanded', String(open));
    $('.tb-proj')?.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => $('.side-proj.on')?.scrollIntoView({ block: 'nearest' }));
  }
  $('.side-toggle')?.addEventListener('click', () => openSide(!body.classList.contains('side-open')));
  $('.tb-proj')?.addEventListener('click', () => openSide(!body.classList.contains('side-open')));
  $('.side-mask')?.addEventListener('click', () => openSide(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && body.classList.contains('side-open')) openSide(false); });
  function sortSide(mode) {
    for (const list of $$('.side-list')) {
      const rows = $$('.side-row', list);
      rows.sort((a, b) => mode === 'name' ? a.dataset.name.localeCompare(b.dataset.name) : b.dataset.updated.localeCompare(a.dataset.updated));
      rows.forEach(r => list.appendChild(r));
    }
    $$('.side-sort button').forEach(b => b.classList.toggle('on', b.dataset.sort === mode));
  }
  function filterSide() {
    const q = ($('#pf')?.value || '').trim().toLowerCase();
    let vis = 0;
    for (const r of $$('.side-row')) { const ok = !q || r.dataset.search.includes(q); r.hidden = !ok; if (ok) vis++; }
    for (const g of $$('.side-group')) {
      const rows = $$('.side-row', g);
      g.hidden = g.dataset.group === 'pinned' ? !rows.some(r => !r.hidden) : (q && !rows.some(r => !r.hidden));
    }
    const nm = $('.side-nomatch'); if (nm) nm.hidden = vis > 0 || !q;
  }
  function bindSide() {
    sortSide(store.get('mydash.sort') || 'recent');
    for (const b of $$('.side-sort button')) b.addEventListener('click', () => { store.set('mydash.sort', b.dataset.sort); sortSide(b.dataset.sort); });
    $('#pf')?.addEventListener('input', filterSide);
    $('#pf')?.addEventListener('keydown', e => { if (e.key === 'Enter') { const first = $$('.side-row').find(r => !r.hidden); if (first) location.href = first.querySelector('a').href; } });
    for (const a of $$('#side a')) a.addEventListener('click', () => openSide(false));
    $('.side-close')?.addEventListener('click', () => openSide(false));
    // 收起按钮在边栏里，边栏刷新后要重新绑定
    $('.side-collapse')?.addEventListener('click', () => setCollapsed(!isCollapsed()));
    if (isCollapsed()) setCollapsed(true);
    bindSheetDrag();
  }
  // 窄屏底部面板：列表在顶部时往下拉就关闭
  function bindSheetDrag() {
    const side = $('#side'); if (!side) return;
    let y0 = null, dy = 0;
    side.addEventListener('touchstart', e => {
      if (!body.classList.contains('side-open') || innerWidth >= 960 || side.scrollTop > 0) return;
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    side.addEventListener('touchmove', e => {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { side.style.transition = 'none'; side.style.transform = `translateY(${dy}px)`; }
    }, { passive: true });
    side.addEventListener('touchend', () => {
      if (y0 == null) return;
      side.style.transition = ''; side.style.transform = '';
      if (dy > 90) openSide(false);
      y0 = null; dy = 0;
    });
  }
  bindSide();
  if (innerWidth >= 960) $('.side-proj.on')?.scrollIntoView({ block: 'nearest' });
  async function refreshSide() {
    const old = $('#side'); if (!old) return;
    const q = $('#pf')?.value || ''; const top = old.scrollTop;
    const html = await (await fetch('/api/sidebar?current=' + encodeURIComponent(body.dataset.project || ''), { cache: 'no-store' })).text();
    const tpl = document.createElement('template'); tpl.innerHTML = html.trim();
    const fresh = tpl.content.firstElementChild; if (!fresh) return;
    old.replaceWith(fresh); fresh.scrollTop = top;
    const pf = $('#pf'); if (pf && q) pf.value = q;
    bindSide(); filterSide(); updateBadge(); setLive();
  }

  // ---------- 实时更新 ----------
  let connected = false;
  function setLive() { $$('.live').forEach(l => l.classList.toggle('on', connected)); }
  async function refreshList(changedId) {
    const before = new Set($$('.entry').map(e => e.dataset.id + '@' + e.querySelector('.ver')?.textContent));
    const q = $('#q')?.value || '';
    const html = await (await fetch(location.href, { cache: 'no-store' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fresh = doc.querySelector('#main'); if (!fresh) return;
    $('#main').replaceWith(fresh);
    // 顶栏面包屑、网页标题、显示名也跟着更新（项目改名后）
    const nc = doc.querySelector('.crumbs'); if (nc && $('.crumbs')) $('.crumbs').innerHTML = nc.innerHTML;
    const nt = doc.querySelector('meta[name="mydash-title"]'); if (nt) $('meta[name="mydash-title"]')?.setAttribute('content', nt.content);
    if (doc.body.dataset.display) body.dataset.display = doc.body.dataset.display;
    updateBadge(); bindRename(); bindTitle();
    const nq = $('#q'); if (nq) nq.value = q;
    bindList();
    for (const e of $$('.entry')) {
      e.style.animation = 'none';
      const key = e.dataset.id + '@' + e.querySelector('.ver')?.textContent;
      if (!before.has(key) || e.dataset.id === changedId) e.classList.add('fresh');
    }
    tickTimes();
  }
  function connect() {
    if (!window.EventSource) return;
    const es = new EventSource('/events');
    es.onopen = () => { connected = true; setLive(); };
    es.onerror = () => { connected = false; setLive(); };
    es.addEventListener('pin', ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      refreshSide().catch(() => {});
      if (page === 'home' || page === 'project') refreshList().catch(() => {});
      else syncPinButtons(d.kind, d.id, d.pinned);
    });
    es.addEventListener('project', ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      refreshSide().catch(() => {});
      if (page === 'home' || page === 'project') refreshList().catch(() => {});
      else if (page === 'item' && body.dataset.project === d.project) {
        const k = $('.doc-kicker a span'); if (k) k.textContent = d.name;
        const c = $$('.crumbs a').at(-1); if (c && c.getAttribute('href') !== '/') c.textContent = d.name;
      }
    });
    es.addEventListener('read', () => {
      refreshSide().catch(() => {});
      if (page === 'home' || page === 'project') refreshList().catch(() => {});
    });
    // 审批答复、批注有变化：列表上的状态和计数跟着变
    es.addEventListener('response', e => {
      if (page === 'home' || page === 'project') refreshList().catch(() => {});
      let d = {}; try { d = JSON.parse(e.data); } catch {}
      document.dispatchEvent(new CustomEvent('mydash-response', { detail: d }));
    });
    es.addEventListener('prompt', e => {
      let d = {}; try { d = JSON.parse(e.data); } catch {}
      document.dispatchEvent(new CustomEvent('mydash-prompt', { detail: d }));
    });
    es.addEventListener('change', ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      const id = d.project + '/' + d.slug;
      refreshSide().catch(() => {});
      if (page === 'home' || (page === 'project' && body.dataset.project === d.project)) {
        refreshList(id).catch(() => {});
      } else if (page === 'item' && body.dataset.project === d.project && body.dataset.slug === d.slug && body.dataset.latest === '1') {
        toast(T('New version, reloading…'));
        setTimeout(() => location.reload(), 700);
      } else if (page === 'item') {
        toast(T('New in {project}', { project: d.project }));
      }
    });
  }
  connect();

  // ---------- 置顶（条目和项目）----------
  function syncPinButtons(kind, id, on) {
    for (const b of $$(`.pin-btn[data-pin="${kind}"]`)) {
      if (b.dataset.id !== id) continue;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      b.title = kind === 'project' ? (on ? T('Unpin project') : T('Pin project')) : (on ? T('Unpin') : T('Pin')); b.setAttribute('aria-label', b.title);
      const span = b.querySelector('span'); if (span) span.textContent = on ? T('Pinned@@state') : T('Pin');
    }
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('.pin-btn'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const kind = b.dataset.pin, id = b.dataset.id, on = !b.classList.contains('on');
    syncPinButtons(kind, id, on);
    try {
      await post('/api/pin', { kind, id, pinned: on });
      toast(on ? (kind === 'project' ? T('Project pinned') : T('Pinned@@toast')) : T('Unpinned'));
      await Promise.all([refreshSide(), (page === 'home' || page === 'project') ? refreshList() : null]);
    } catch { syncPinButtons(kind, id, !on); toast(T('That did not work. Try again in a moment.')); }
  });

  // 按 [ 收起 / 展开边栏（电脑端）
  document.addEventListener('keydown', e => {
    if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || innerWidth < 960) return;
    if (/input|textarea|select/i.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable) return;
    e.preventDefault(); setCollapsed(!isCollapsed());
  });

  // ---------- 在其他设备上打开：Tailscale 地址、局域网地址 + 二维码 + 访问码 ----------
  document.addEventListener('click', async e => {
    const btn = e.target.closest('.reach-btn'); if (!btn) return;
    let info;
    try { const r = await fetch('/api/access', { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); info = await r.json(); }
    catch { toast(T('Only the computer running mydash, or your tailnet, can show this.')); return; }
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const parts = [];
    if (info.tailnet) parts.push(`<section><h4>${T('Over Tailscale')}</h4><a class="ad-url" href="${esc(info.tailnet)}">${esc(info.tailnet)}</a><p>${T('On any device with Tailscale signed in to the same account, from anywhere.')}</p></section>`);
    if (info.lan) parts.push(`<section><h4>${T('On the same Wi-Fi')}</h4>${info.qr ? `<div class="ad-qr" aria-label="QR">${info.qr}</div><p>${T('Scan with the phone camera to open it and log in at once.')}</p>` : ''}${info.urls.map(u => `<div><a class="ad-url" href="${esc(u)}">${esc(u)}</a></div>`).join('')}<p>${T('Access code')}: <span class="ad-code">${esc(info.code)}</span></p><p>${T('{n} device logged in. To change the code and log every device out, run mydash lan reset.|{n} devices logged in. To change the code and log every device out, run mydash lan reset.', { n: info.devices })}</p></section>`);
    else parts.push(`<section><h4>${T('On the same Wi-Fi')}</h4><p>${T('Not turned on. On this computer run mydash lan on, or ask your agent to.')}</p></section>`);
    const dlg = document.createElement('dialog'); dlg.className = 'access-dlg';
    dlg.innerHTML = `<div class="ad-body"><h3>${T('Open on another device')}</h3>${parts.join('')}<button type="button" class="ad-close">${T('Close')}</button></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('.ad-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
    dlg.showModal();
  });

  // 打印 / 存成 PDF：用浏览器自带的打印（手机上从共享菜单里也能存成 PDF）
  $('.print-btn')?.addEventListener('click', () => window.print());

  // ---------- 归档条目、静音项目 ----------
  document.addEventListener('click', async e => {
    const ab = e.target.closest('.arch-btn');
    if (ab) {
      const on = ab.dataset.archived !== '1';
      try {
        await post('/api/archive', { id: body.dataset.id, archived: on });
        ab.dataset.archived = on ? '1' : '0'; ab.textContent = on ? T('Unarchive') : T('Archive');
        toast(on ? T('Archived. It no longer shows in the lists.') : T('Back in the lists.'));
        refreshSide().catch(() => {});
      } catch { toast(T('That did not work. Try again in a moment.')); }
      return;
    }
    const mb = e.target.closest('.mute-btn');
    if (mb) {
      const on = mb.getAttribute('aria-pressed') !== 'true';
      try {
        await post('/api/mute', { project: mb.dataset.project, muted: on });
        toast(on ? T('Muted. Its items no longer count as unread.') : T('Unmuted.'));
        await Promise.all([refreshList(), refreshSide()]);
      } catch { toast(T('That did not work. Try again in a moment.')); }
    }
  });

  // ---------- 小工具：弹窗、转义、时间 ----------
  const escH = x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function modal(html, { onOpen } = {}) {
    const dlg = document.createElement('dialog'); dlg.className = 'access-dlg md-dlg';
    dlg.innerHTML = `<div class="ad-body">${html}</div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
    for (const b of $$('[data-close]', dlg)) b.addEventListener('click', () => dlg.close());
    dlg.showModal(); onOpen?.(dlg);
    return dlg;
  }
  const when = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

  // ---------- 审批单：点选、输入，确认后提交 ----------
  const apForm = $('#ap-form');
  if (apForm) {
    const data = JSON.parse($('#ap-data')?.textContent || '{}');
    const draftKey = `mydash.ap.${apForm.dataset.id}.v${apForm.dataset.v}`;
    const qs = $$('.ap-q');
    const stateBox = $('.ap-state', apForm), sendBtn = $('.ap-send', apForm);
    const OTHER = '__other__';
    function collect() {
      const out = {};
      for (const q of qs) {
        const id = q.dataset.q, type = q.dataset.type, other = () => ({ other: $('.ap-other-text', q)?.value || '' });
        if (type === 'choice') { const c = $('input[type=radio]:checked', q); if (c) out[id] = c.value === OTHER ? other() : c.value; }
        else if (type === 'multi') { const arr = $$('input[type=checkbox]:checked', q).map(c => (c.value === OTHER ? other() : c.value)).filter(x => typeof x === 'string' || x.other.trim()); if (arr.length) out[id] = arr; }
        else { const v = $('textarea:not(.ask-text), input[type=text]:not(.ask-text)', q)?.value || ''; if (v.trim()) out[id] = v; }
      }
      return out;
    }
    function fill(ans) {
      for (const q of qs) {
        const a = ans?.[q.dataset.q]; if (a == null) continue;
        const list = Array.isArray(a) ? a : [a];
        if (q.dataset.type === 'choice' || q.dataset.type === 'multi') {
          for (const el of $$('input[type=radio], input[type=checkbox]', q)) {
            const o = list.find(x => (x && typeof x === 'object' ? el.value === OTHER : x === el.value));
            el.checked = Boolean(o);
            if (o && typeof o === 'object') { const ot = $('.ap-other-text', q); if (ot) ot.value = o.other; }
          }
        } else { const el = $('textarea:not(.ask-text), input[type=text]:not(.ask-text)', q); if (el) el.value = a; }
      }
    }
    const blank = a => a == null || (typeof a === 'object' && !Array.isArray(a) && !String(a.other || '').trim());
    const missing = ans => qs.filter(q => q.dataset.required && blank(ans[q.dataset.q]));
    function lock(on) {
      for (const el of $$('input, textarea', document)) if (el.form === apForm || el.getAttribute('form') === 'ap-form') el.disabled = on;
      apForm.classList.toggle('locked', on); sendBtn.hidden = on;
    }
    function showState(kind) {
      const sub = data.submission;
      if (kind === 'submitted' && sub) {
        stateBox.innerHTML = `<p class="ap-ok">${sub.status === 'done' ? T('Your agent has handled this.') : T('Submitted {time}. It is saved in mydash.', { time: when(sub.submittedAt) })}</p>
          <div class="ap-btns"><button type="button" class="ap-edit">${T('Change my answers')}</button><button type="button" class="ap-copy">${T('Copy answers for the agent')}</button></div>`;
        $('.ap-edit', stateBox).addEventListener('click', () => { lock(false); showState('editing'); });
        $('.ap-copy', stateBox).addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(data.summary || ''); toast(T('Copied. Paste it to your agent.')); }
          catch { modal(`<h3>${T('Copy answers for the agent')}</h3><textarea class="ap-copytext" readonly rows="8">${escH(data.summary)}</textarea><button type="button" class="ad-close" data-close>${T('Close')}</button>`, { onOpen: d => $('textarea', d).select() }); }
        });
      } else if (kind === 'closed') {
        const c = data.closed;
        const msg = c.how === 'chat' ? T('Decided in the conversation {time}, so this form is closed.', { time: when(c.at) })
          : c.how === 'superseded' ? T('Replaced by a newer approval form, so this one is closed.')
          : T('Expired: nobody answered and the session that asked has stopped. If you still want to answer, tell your agent in a new conversation.');
        stateBox.innerHTML = `<p class="ap-closed">${escH(msg)}</p>${c.note ? `<blockquote class="ap-closed-note">${escH(c.note)}</blockquote>` : ''}${c.by ? `<p><a href="${escH(c.by)}">${T('Open the newer one')}</a></p>` : ''}`;
      } else if (kind === 'editing') stateBox.innerHTML = `<p class="ap-note">${T('Change anything, then submit again. The latest answers count.')}</p>`;
      else if (kind === 'old') stateBox.innerHTML = `<p class="ap-note">${T('This is an older version. Answer on the latest version.')}</p>`;
      else stateBox.innerHTML = '';
      stateBox.hidden = !stateBox.innerHTML;
    }
    if (data.closed && !data.submission) { lock(true); showState('closed'); }
    else if (data.submission) { fill(data.submission.answers); lock(true); showState('submitted'); }
    else if (apForm.dataset.latest !== '1') { lock(true); showState('old'); }
    else { try { fill(JSON.parse(localStorage.getItem(draftKey) || 'null')); } catch {} }
    // 改了就存草稿；在"其他"里打字时自动勾上"其他"
    document.addEventListener('input', e => {
      const q = e.target.closest?.('.ap-q'); if (!q || e.target.classList.contains('ask-text')) return;
      if (e.target.classList.contains('ap-other-text')) { const box = $(`input[value="${OTHER}"]`, q); if (box && e.target.value) box.checked = true; }
      q.classList.remove('ap-missing');
      if (!data.submission || !apForm.classList.contains('locked')) { try { localStorage.setItem(draftKey, JSON.stringify(collect())); } catch {} }
    });
    apForm.addEventListener('submit', e => {
      e.preventDefault();
      const ans = collect(); const miss = missing(ans);
      qs.forEach(q => q.classList.toggle('ap-missing', miss.includes(q)));
      if (miss.length) { miss[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); toast(T('{n} required question is not answered yet.|{n} required questions are not answered yet.', { n: miss.length })); return; }
      const show = q => { const a = ans[q.dataset.q]; const label = v => (v && typeof v === 'object' ? `${$('.ap-other b', q)?.textContent || T('Other@@option')}: ${v.other}` : ($(`input[value="${CSS.escape(v)}"]`, q)?.closest('label')?.querySelector('b')?.textContent || v)); return a == null ? `<i>${T('(no answer)')}</i>` : escH(Array.isArray(a) ? a.map(label).join('、') : label(a)); };
      const rows = qs.map(q => `<li><b>${escH($('legend', q)?.childNodes[0]?.textContent || q.dataset.q)}</b><span>${show(q)}</span></li>`).join('');
      modal(`<h3>${T('Submit these answers?')}</h3><ul class="ap-review">${rows}</ul><p class="ap-note">${T('After you confirm, the answers are saved for your agent. You can still change them later.')}</p><div class="ap-btns"><button type="button" class="ap-confirm">${T('Confirm and submit')}</button><button type="button" data-close>${T('Keep editing')}</button></div>`, {
        onOpen: dlg => $('.ap-confirm', dlg).addEventListener('click', async () => {
          try {
            const r = await post('/api/approval', { id: apForm.dataset.id, v: Number(apForm.dataset.v), answers: ans });
            data.submission = r.submission; data.summary = r.summary;
            try { localStorage.removeItem(draftKey); } catch {}
            dlg.close(); lock(true); showState('submitted'); toast(T('Submitted'));
          } catch (e) {
            // 409：这张单子已经在对话里定了（或被取代、过期），刷新看结局
            if (/409/.test(e.message)) { toast(T('This form was already closed. Reloading…')); setTimeout(() => location.reload(), 1200); }
            else toast(T('That did not work. Try again in a moment.'));
          }
        }),
      });
    });
  }

  // ---------- 待办：自己做完一件就勾掉，进度存进 mydash ----------
  const tdBar = $('.td-bar');
  if (tdBar) {
    const state = JSON.parse($('#td-data')?.textContent || '{}');
    const boxes = $$('.sheet .todo-item').map(li => ({ li, k: li.dataset.k, input: $(':scope > .todo-box input', li) })).filter(x => x.input);
    // 做完的默认收起来（按设备记住），没做完的排在眼前；刚勾掉的先留着，免得一点就不见了
    let hideDone = store.get('mydash.td.hide') !== 'show';
    const hideBtn = $('.td-hide', tdBar);
    const sync = () => {
      const total = boxes.length, done = boxes.filter(x => x.input.checked).length;
      for (const b of boxes) b.li.classList.toggle('done', b.input.checked);
      for (const b of boxes) b.li.classList.toggle('has-open', b.input.checked && $$('.todo-item', b.li).some(x => !x.classList.contains('done')));
      $('.sheet')?.classList.toggle('hide-done', hideDone && done > 0 && done < total);
      if (hideBtn) { hideBtn.hidden = !done || done === total; hideBtn.textContent = hideDone ? T('Show the {n} done|Show the {n} done', { n: done }) : T('Hide the done ones'); }
      tdBar.classList.toggle('all', total > 0 && done === total);
      $('.td-txt', tdBar).textContent = done === total ? T('All done') : T('{done} of {total} done', { done, total });
      $('.td-track i', tdBar).style.width = (total ? Math.round(done / total * 100) : 0) + '%';
      $('.td-track', tdBar).setAttribute('aria-valuenow', done);
      return done === total;
    };
    for (const b of boxes) if (b.k in state) b.input.checked = Boolean(state[b.k]);
    sync();
    hideBtn?.addEventListener('click', () => { hideDone = !hideDone; store.set('mydash.td.hide', hideDone ? 'hide' : 'show'); for (const b of boxes) b.li.classList.remove('keep'); sync(); });
    // 别处改了勾选（自动检测、另一台设备、agent 替你勾的）：拉一次最新状态
    document.addEventListener('mydash-response', async e => {
      if (e.detail?.id !== tdBar.dataset.id) return;
      try {
        const j = await (await fetch(`/api/todos?id=${encodeURIComponent(tdBar.dataset.id)}`)).json();
        if (j.v !== Number(tdBar.dataset.v)) return;
        const before = boxes.filter(b => b.input.checked).length;
        for (const b of boxes) if (b.k in j.done) b.input.checked = j.done[b.k];
        if (sync() && boxes.filter(b => b.input.checked).length > before) toast(T('All done'));
      } catch {}
    });
    for (const b of boxes) b.input.addEventListener('change', async () => {
      b.li.classList.add('keep');
      const on = b.input.checked; const all = sync();
      try {
        await post('/api/todo', { id: tdBar.dataset.id, v: Number(tdBar.dataset.v), key: b.k, done: on });
        if (on && all) toast(T('All done'));
      } catch { b.input.checked = !on; sync(); toast(T('That did not work. Try again in a moment.')); }
    });
  }

  // ---------- 终端里的提问：在这里答，答完终端那边接着跑 ----------
  const prData = (() => { try { return JSON.parse($('#pr-data')?.textContent || 'null'); } catch { return null; } })();
  if (prData) {
    // 在「其他」里打字就自动选上「其他」
    for (const ot of $$('.pr-q .ap-other-text')) ot.addEventListener('input', () => { const box = ot.closest('.ap-opt')?.querySelector('input[value="__other__"]'); if (box && ot.value) box.checked = true; ot.closest('.pr-q').classList.remove('ap-missing'); });
    for (const q of $$('.pr-q')) q.addEventListener('change', () => q.classList.remove('ap-missing'));
    const go = async (path, body, okMsg) => {
      for (const b of $$('.pr-acts button')) b.disabled = true;
      try {
        const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify(body) });
        if (r.status === 409) { toast(T('This was already handled elsewhere.')); return setTimeout(() => location.reload(), 900); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        toast(okMsg); setTimeout(() => location.reload(), 700);
      } catch { toast(T('That did not work. Try again in a moment.')); for (const b of $$('.pr-acts button')) b.disabled = false; }
    };
    for (const b of $$('.pr-acts [data-act]')) b.addEventListener('click', () => {
      const act = b.dataset.act; const base = `/api/prompts/${prData.id}`;
      if (act === 'release') return go(`${base}/release`, {}, T('Handed back.'));
      if (prData.kind === 'question') {
        const answers = {}; let missing = null;
        $$('.pr-q').forEach((fs, i) => {
          const picked = $$('input[type=radio]:checked, input[type=checkbox]:checked', fs).map(x => (x.value === '__other__' ? $('.ap-other-text', fs).value.trim() : x.value)).filter(Boolean);
          if (!picked.length) missing = missing || fs;
          answers[prData.questions[i]] = fs.dataset.multi === '1' ? picked : picked[0];
        });
        if (missing) { missing.classList.add('ap-missing'); missing.scrollIntoView({ behavior: 'smooth', block: 'center' }); return toast(T('Answer every question first.')); }
        return go(`${base}/answer`, { answers }, T('Sent. The agent carries on now.'));
      }
      if (prData.kind === 'plan') {
        const fb = $('.pr-feedback')?.value.trim() || '';
        if (act === 'revise' && !fb) { $('.pr-feedback')?.focus(); return toast(T('Say what should change first.')); }
        return go(`${base}/answer`, { approve: act === 'approve', feedback: fb }, T('Sent. The agent carries on now.'));
      }
      return go(`${base}/answer`, { decision: act, message: $('.pr-reason')?.value.trim() || '' }, T('Sent. The agent carries on now.'));
    });
    // 终端那边取消了、或者在别的设备上答了：刷新一下
    document.addEventListener('mydash-prompt', e => { if (e.detail?.id === prData.id && prData.status === 'pending') location.reload(); });
  }

  // ---------- 设置页：改了就自动保存；推送渠道可以加好几个，每个单独开关、试发、改、删 ----------
  const setForm = $('#set-form');
  if (setForm) {
    const q = n => setForm.querySelector(`[name="${n}"]`);
    const send = async (url, data) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mydash': '1' }, body: JSON.stringify(data) });
      return { ...(await r.json().catch(() => ({}))), status: r.status, httpOk: r.ok };
    };
    const oops = () => toast(T('That did not work. Try again in a moment.'));
    // 这台设备：语言（cookie，刷新页面）、外观
    const themeSel = q('theme');
    if (themeSel) { themeSel.value = root.dataset.themeMode || 'auto'; themeSel.addEventListener('change', () => { window.mydashSetThemeMode?.(themeSel.value); toast(T('Saved')); }); }
    q('lang')?.addEventListener('change', e => window.mydashSetLang?.(e.target.value));
    // 其余选项：改了就存
    const syncDaily = () => { q('daily').disabled = !q('dailyOn').checked; };
    syncDaily();
    const autoData = () => ({
      autoArchiveDays: Number(q('autoArchiveDays').value), daily: q('dailyOn').checked ? q('daily').value : '',
      prompts: { enabled: q('promptsOn').checked, chat: q('promptsChat').checked, mode: q('promptsMode').value, codexMode: q('promptsCodex').value, pushDelay: Number(q('promptsPush').value) },
    });
    // 一次只存一份，轮到时再读表单：连着改两项，后存的一定是最新的样子
    let saving = Promise.resolve();
    for (const el of $$('[data-auto]', setForm)) el.addEventListener('change', () => {
      if (el.name === 'dailyOn') syncDaily();
      saving = saving.then(async () => {
        try {
          const j = await send('/api/settings', autoData());
          if (j.httpOk) { for (const x of $$('[data-auto].bad', setForm)) x.classList.remove('bad'); toast(T('Saved')); }
          else { (j.field && q(j.field) || el).classList.add('bad'); toast(T('Check the highlighted field.')); }
        } catch { oops(); }
      });
    });
    // 推送渠道
    const push = $('#set-push');
    if (push) {
      if (store.get('mydash.set.push') === 'open') push.open = true;
      push.addEventListener('toggle', () => store.set('mydash.set.push', push.open ? 'open' : 'closed'));
    }
    const list = $('#set-chs'), ed = $('#set-ed'), types = $('.set-types', setForm);
    const applyList = j => { if (j.html != null) list.innerHTML = j.html; if (j.summary) $('.set-sum', push).textContent = j.summary; };
    const rowData = row => { try { return JSON.parse($('.set-chdata', row).textContent); } catch { return {}; } };
    const edFields = () => Object.fromEntries($$('.set-edbody [name]', ed).map(el => [el.name, el.value.trim()]));
    const edClear = () => $$('.set-edbody [data-clear]', ed).map(el => el.name);
    // 可以单独清掉的已存值（选填的那几个）
    const CLEARABLE = { webhook: ['secret'], email: ['pass'] };
    const markBad = field => { const el = field && ed.querySelector(`[name="${field}"]`); if (el) { el.classList.add('bad'); el.focus(); } };
    function closeEditor() { ed.hidden = true; delete ed.dataset.id; types.hidden = true; $('.set-add', setForm).hidden = false; for (const r of $$('.set-chrow.editing', list)) r.classList.remove('editing'); }
    // 打开表单：加新的（type）或改已有的（那一行的数据）。密钥和带密钥的网址不回填，只提示存着的样子，留空就不改
    function openEditor(type, cur = null) {
      const tpl = $(`#tpl-${type}`); if (!tpl) return;
      ed.dataset.type = type; if (cur) ed.dataset.id = cur.id; else delete ed.dataset.id;
      $('.set-edh', ed).textContent = cur ? T('Edit {name}', { name: cur.name || tpl.dataset.name }) : T('Add {name}', { name: tpl.dataset.name });
      const body = $('.set-edbody', ed); body.innerHTML = ''; body.append(tpl.content.cloneNode(true));
      ed.elements.name.value = cur?.name || '';
      for (const el of $$('[name]', body)) {
        if (cur?.values?.[el.name] != null) el.value = cur.values[el.name];
        // 邮件的加密方式没存过 = 按 STARTTLS 发（和发信时的默认一致），不能显示成下拉框的第一项
        else if (cur && type === 'email' && el.name === 'secure') el.value = 'starttls';
        if (cur?.masked?.[el.name]) {
          el.placeholder = T('Saved: {value} (leave blank to keep)', { value: cur.masked[el.name] });
          if ((CLEARABLE[type] || []).includes(el.name)) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'linkish set-clear'; b.textContent = T('Clear the saved one');
            b.addEventListener('click', () => { el.value = ''; el.dataset.clear = '1'; el.placeholder = T('Cleared when you save'); b.remove(); });
            el.after(b);
          }
        }
      }
      $('.set-save', ed).textContent = cur ? T('Save') : T('Add');
      ed.hidden = false; types.hidden = true; $('.set-add', setForm).hidden = true;
      (cur ? ed.elements.name : $('.set-edbody input', ed))?.focus();
      ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    $('.set-add', setForm)?.addEventListener('click', e => { types.hidden = false; e.currentTarget.hidden = true; });
    for (const b of $$('.set-type', setForm)) b.addEventListener('click', () => openEditor(b.dataset.type));
    $('.set-cancel', ed)?.addEventListener('click', closeEditor);
    ed?.addEventListener('input', e => e.target.classList.remove('bad'));
    ed?.addEventListener('submit', async e => {
      e.preventDefault();
      const id = ed.dataset.id;
      try {
        const j = await send('/api/channels', id ? { op: 'update', id, name: ed.elements.name.value, fields: edFields(), clear: edClear() } : { op: 'add', type: ed.dataset.type, name: ed.elements.name.value, fields: edFields() });
        if (!j.httpOk) { markBad(j.field); toast(j.status === 409 ? T('That one is already in the list.') : T('Check the highlighted field.')); return; }
        applyList(j); closeEditor(); toast(id ? T('Saved') : T('Added. Tap “Send a test” to check.'));
      } catch { oops(); }
    });
    $('.set-edtest', ed)?.addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const j = await send('/api/notify-test', { type: ed.dataset.type, id: ed.dataset.id, fields: edFields(), clear: edClear() });
        if (!j.httpOk) { markBad(j.field); toast(T('Fill in the highlighted field first.')); return; }
        toast(j.ok ? T('Sent. Check your phone.') : T('Failed: {err}', { err: j.error || j.status }));
      } catch { oops(); } finally { b.disabled = false; }
    });
    // 表单里的小工具：ntfy 随机话题、Telegram 找 chat id
    ed?.addEventListener('click', async e => {
      // 邮箱教程里的「填入这些设置」：服务器、端口、加密方式
      const fillBtn = e.target.closest('.set-fill');
      if (fillBtn) {
        for (const k of ['host', 'port', 'secure']) { const el = ed.querySelector(`[name="${k}"]`); if (el && fillBtn.dataset[k]) { el.value = fillBtn.dataset[k]; el.classList.remove('bad'); } }
        ed.querySelector('[name="user"]')?.focus();
        toast(T('Filled in the server, port and encryption.')); return;
      }
      if (e.target.closest('.set-gen')) {
        const a = new Uint8Array(10); crypto.getRandomValues(a);
        ed.querySelector('[name="url"]').value = 'https://ntfy.sh/mydash-' + [...a].map(x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
      }
      const tg = e.target.closest('.set-tg'); if (!tg) return;
      tg.disabled = true;
      try {
        const j = await send('/api/telegram-chat', { token: ed.querySelector('[name="token"]').value.trim(), id: ed.dataset.id });
        if (!j.httpOk) { markBad('token'); toast(T('Paste the bot token first.')); return; }
        if (j.ok) { ed.querySelector('[name="chat"]').value = j.chat; toast(j.name ? T('Found: {name}', { name: j.name }) : T('Found it.')); }
        else toast(j.error === 'no messages yet' ? T('Send your bot a message in Telegram first, then try again.') : T('Failed: {err}', { err: j.error }));
      } catch { oops(); } finally { tg.disabled = false; }
    });
    // 每一行：开关、试发、改、删（行是服务端重画的，所以在外层接事件）
    list?.addEventListener('change', async e => {
      const sw = e.target.closest('.set-chon'); if (!sw) return;
      const row = sw.closest('.set-chrow');
      try { const j = await send('/api/channels', { op: 'toggle', id: row.dataset.id, on: sw.checked }); if (!j.httpOk) throw 0; applyList(j); toast(sw.checked ? T('On') : T('Off')); } catch { sw.checked = !sw.checked; oops(); }
    });
    list?.addEventListener('click', async e => {
      const row = e.target.closest('.set-chrow'); if (!row) return;
      if (e.target.closest('.set-edit')) { closeEditor(); row.classList.add('editing'); openEditor(row.dataset.type, rowData(row)); return; }
      if (e.target.closest('.set-del')) {
        if (!confirm(T('Remove “{name}”?', { name: $('.set-chmain b', row).textContent }))) return;
        try { const j = await send('/api/channels', { op: 'remove', id: row.dataset.id }); if (!j.httpOk) throw 0; applyList(j); closeEditor(); toast(T('Removed')); } catch { oops(); }
        return;
      }
      const b = e.target.closest('.set-test'); if (!b) return;
      b.disabled = true;
      try { const j = await send('/api/notify-test', { id: row.dataset.id }); toast(j.ok ? T('Sent. Check your phone.') : T('Failed: {err}', { err: j.error || j.status })); } catch { oops(); } finally { b.disabled = false; }
    });
    // 网页推送：只能在 HTTPS 下订阅；iPhone 还要从主屏幕打开
    const wp = $('.set-wp', setForm);
    if (wp) {
      const state = $('.set-wp-state', wp), on = $('.set-wp-on', wp), off = $('.set-wp-off', wp), badge = $('.set-on', wp);
      const setDevices = n => { badge.hidden = !n; badge.textContent = T('{n} device|{n} devices', { n }); };
      const key = s => { const r = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, c => c.charCodeAt(0)); };
      async function refresh() {
        if (!wp.dataset.https) return;
        if (!window.isSecureContext) { state.innerHTML = `${escH(T('Open mydash over HTTPS to turn this on here:'))} <a href="${escH(wp.dataset.https)}/settings">${escH(wp.dataset.https)}</a>`; return; }
        if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) { state.textContent = T('This browser cannot receive web push. On iPhone, add mydash to the home screen and open it from there.'); return; }
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();
        on.hidden = Boolean(sub); off.hidden = !sub;
        state.textContent = sub ? T('This device receives notifications.') : Notification.permission === 'denied' ? T('Notifications are blocked for this site in the browser settings.') : '';
      }
      refresh().catch(() => {});
      on.addEventListener('click', async () => {
        on.disabled = true;
        try {
          if (await Notification.requestPermission() !== 'granted') { toast(T('Notifications were not allowed.')); return; }
          const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
          const { publicKey } = await (await fetch('/api/webpush')).json();
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(publicKey) });
          const j = await post('/api/webpush/subscribe', { subscription: sub.toJSON() });
          setDevices(j.devices); toast(T('On. Tap “Send a test” to check.'));
        } catch (e) { toast(T('Failed: {err}', { err: e.message })); }
        finally { on.disabled = false; refresh().catch(() => {}); }
      });
      off.addEventListener('click', async () => {
        try {
          const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
          if (sub) { const j = await post('/api/webpush/unsubscribe', { endpoint: sub.endpoint }); setDevices(j.devices); await sub.unsubscribe(); }
        } catch {}
        refresh().catch(() => {});
      });
      $('.set-wp-test', wp)?.addEventListener('click', async e => {
        const b = e.currentTarget; b.disabled = true;
        try { const j = await send('/api/notify-test', { type: 'webpush' }); toast(j.ok ? T('Sent. Check your phone.') : T('Failed: {err}', { err: j.error || j.status })); } catch { oops(); } finally { b.disabled = false; }
      });
    }
  }

  // ---------- 「问一下」：在某一项待办、某一道审批题上问 agent，回答挂在那一项下面 ----------
  // 按钮常显（做完的项不显示）；来回问答不堆在页面上：每一项只摆最新一轮，更早的收起来，做完的项整段收成一行
  const askData = (() => { try { return JSON.parse($('#ask-data')?.textContent || 'null'); } catch { return null; } })();
  if (askData) {
    let asks = askData.asks || [];
    const ICON_ASK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17.5h-1A1.5 1.5 0 0 1 3 16V7a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.7-.9 1.3v.3M12 15.4h.01"/></svg>';
    const closed = (() => { try { return Boolean(JSON.parse($('#ap-data')?.textContent || '{}').closed); } catch { return false; } })();
    // 能问的地方：待办的每一项、审批单的每道题
    const spots = [
      ...$$('.sheet .todo-item').map(el => ({ el, kind: 'todo', key: el.dataset.k, host: $(':scope > .todo-body', el), done: () => el.classList.contains('done') })),
      ...$$('.sheet .ap-q').map(el => ({ el, kind: 'approval', key: el.dataset.q, host: el, done: () => Boolean($('#ap-form')?.classList.contains('locked')) })),
    ].filter(x => x.host && x.key);
    const fmt = iso => { try { return new Date(iso).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
    const linkify = x => escH(x).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const qa = a => `<p class="ask-q"><span>${escH(T('You asked'))}</span>${escH(a.text)}</p>${a.reply ? `<p class="ask-a">${linkify(a.reply.text)}</p>` : `<p class="ask-wait">${escH(T('Waiting for the agent. It replies after finishing what it is doing.'))}</p>`}`;
    function renderThread(sp) {
      $(':scope > .ask-thread', sp.host)?.remove();
      const mine = asks.filter(a => a.kind === sp.kind && a.key === sp.key);
      sp.el.classList.toggle('has-ask', mine.length > 0);
      if (!mine.length) return;
      const box = document.createElement('div'); box.className = 'ask-thread';
      const last = mine[mine.length - 1], earlier = mine.slice(0, -1);
      const older = earlier.length ? `<details class="ask-older"><summary>${escH(T('Earlier questions · {n}', { n: earlier.length }))}</summary>${earlier.map(a => `<div class="ask-item">${qa(a)}</div>`).join('')}</details>` : '';
      // 这一项已经做完、问题也都答了：整段收成一行
      box.innerHTML = sp.done() && mine.every(a => a.reply)
        ? `<details class="ask-older"><summary>${escH(T('Questions · {n}', { n: mine.length }))}</summary>${mine.map(a => `<div class="ask-item">${qa(a)}</div>`).join('')}</details>`
        : `<div class="ask-item ask-last${last.reply ? '' : ' pending'}">${qa(last)}</div>${older}`;
      sp.host.appendChild(box);
    }
    function openComposer(sp, btn) {
      const old = $(':scope > .ask-new', sp.host); if (old) { old.remove(); return; }
      const box = document.createElement('div'); box.className = 'ask-new';
      box.innerHTML = `<textarea class="ask-text" rows="2" maxlength="1000" placeholder="${escH(T('What is unclear, what you cannot do, or where you are stuck?'))}"></textarea><div class="ask-btns"><button type="button" class="ask-send">${escH(T('Send to agent'))}</button><button type="button" class="ask-cancel">${escH(T('Cancel'))}</button></div>`;
      sp.host.appendChild(box);
      const ta = $('textarea', box); ta.focus();
      $('.ask-cancel', box).addEventListener('click', () => box.remove());
      const send = async () => {
        const text = ta.value.trim(); if (!text) { ta.focus(); return; }
        $('.ask-send', box).disabled = true;
        try {
          const r = await post('/api/ask', { id: askData.id, v: askData.v, kind: sp.kind, key: sp.key, text });
          asks.push(r.ask); box.remove(); renderThread(sp);
          toast(T('Sent. The agent replies here after finishing what it is doing.'));
        } catch (e) { $('.ask-send', box).disabled = false; toast(/409/.test(e.message) ? T('This form was already closed. Reloading…') : T('That did not work. Try again in a moment.')); }
      };
      $('.ask-send', box).addEventListener('click', send);
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
    }
    for (const sp of spots) {
      if (askData.latest && !closed) {
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ask-btn';
        btn.title = T('Ask the agent about this'); btn.innerHTML = `${ICON_ASK}<span>${escH(T('Ask'))}</span>`;
        btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openComposer(sp, btn); });
        // 位置固定：待办在那一项文字下面、审批题在选项下面，单独一行操作区（「自动检测」标记也挪进来）
        const acts = document.createElement('div'); acts.className = sp.kind === 'todo' ? 'todo-acts' : 'ap-acts';
        const auto = $(':scope > .todo-auto', sp.host) || $('.todo-auto', sp.host); if (auto && sp.kind === 'todo') acts.appendChild(auto);
        acts.appendChild(btn); sp.host.appendChild(acts);
      }
      renderThread(sp);
    }
    // agent 回答了（或者另一台设备上问了）：拉一次最新的
    document.addEventListener('mydash-response', async e => {
      if (e.detail?.id !== askData.id) return;
      try { const j = await (await fetch(`/api/asks?id=${encodeURIComponent(askData.id)}`)).json(); asks = j.asks || []; spots.forEach(renderThread); } catch {}
    });
    // 勾掉 / 取消勾选时，问答跟着收起或展开
    for (const sp of spots) $(':scope > .todo-box input', sp.el)?.addEventListener('change', () => setTimeout(() => renderThread(sp), 0));
  }

  // ---------- 批注：选中正文写意见，agent 用 mydash feedback 读取 ----------
  const cmPanel = $('.cm-panel');
  if (cmPanel) {
    let comments = JSON.parse($('#cm-data')?.textContent || '[]');
    const prose = cmPanel.dataset.prose === '1' ? $('.sheet .prose') : null;
    const itemId = cmPanel.dataset.id, curV = Number(cmPanel.dataset.v), file = cmPanel.dataset.file;
    function highlight() {
      if (!prose) return;
      for (const m of $$('mark.cm-hl', prose)) m.replaceWith(...m.childNodes);
      prose.normalize();
      for (const c of comments) {
        if (c.status !== 'open' || !c.quote || (c.file && c.file !== file)) continue;
        const needle = c.quote.trim().slice(0, 200);
        const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const i = node.nodeValue.indexOf(needle); if (i < 0) continue;
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + needle.length);
          const mark = document.createElement('mark'); mark.className = 'cm-hl'; mark.dataset.cid = c.id;
          range.surroundContents(mark); break;
        }
      }
    }
    function render() {
      const open = comments.filter(c => c.status === 'open'), done = comments.filter(c => c.status !== 'open');
      const card = c => `<div class="cm-item${c.status === 'open' ? '' : ' done'}" id="cm-${escH(c.id)}">
        ${c.quote ? `<blockquote>${escH(c.quote)}</blockquote>` : ''}<p>${escH(c.text)}</p>
        <div class="cm-meta"><span>v${c.v} · ${when(c.createdAt)}</span><span class="cm-st">${c.status === 'open' ? T('Not handled yet') : T('Handled{v}', { v: c.resolvedIn ? ` (v${c.resolvedIn})` : '' })}</span>${c.note ? `<span class="cm-note">${escH(c.note)}</span>` : ''}${c.status === 'open' ? `<button type="button" class="cm-del" data-cid="${escH(c.id)}">${T('Delete')}</button>` : ''}</div></div>`;
      $('.cm-list', cmPanel).innerHTML = open.map(card).join('') + (done.length ? `<details class="cm-done"><summary>${T('{n} handled|{n} handled', { n: done.length })}</summary>${done.map(card).join('')}</details>` : '');
      $('.cm-n', cmPanel).textContent = open.length || '';
      highlight();
    }
    async function save(payload) {
      try { const r = await post(payload.cid ? '/api/comment/delete' : '/api/comment', { id: itemId, ...payload }); comments = r.comments; render(); return true; }
      catch { toast(T('That did not work. Try again in a moment.')); return false; }
    }
    function openEditor(quote = '', heading = '') {
      modal(`<h3>${quote ? T('Comment on this passage') : T('Add a comment')}</h3>${quote ? `<blockquote class="cm-q">${escH(quote)}</blockquote>` : ''}<textarea class="cm-text" rows="5" placeholder="${escH(T('What should the agent change or know?'))}"></textarea><div class="ap-btns"><button type="button" class="ap-confirm">${T('Save comment')}</button><button type="button" data-close>${T('Cancel')}</button></div>`, {
        onOpen: dlg => {
          const ta = $('.cm-text', dlg); setTimeout(() => ta.focus(), 50);
          $('.ap-confirm', dlg).addEventListener('click', async () => {
            if (!ta.value.trim()) { ta.focus(); return; }
            if (await save({ v: curV, file, quote, heading, text: ta.value })) { dlg.close(); toast(T('Saved. Your agent will see it.')); }
          });
        },
      });
    }
    $('.cm-add', cmPanel).addEventListener('click', () => openEditor());
    cmPanel.addEventListener('click', e => {
      const del = e.target.closest('.cm-del');
      if (del && confirm(T('Delete this comment?'))) save({ cid: del.dataset.cid });
    });
    // 选中正文 → 浮出"批注"按钮
    if (prose) {
      const fab = document.createElement('button'); fab.type = 'button'; fab.className = 'cm-fab'; fab.hidden = true;
      fab.innerHTML = `<span>${T('Comment')}</span>`; document.body.appendChild(fab);
      let pick = null;
      const headingOf = node => { let el = node.nodeType === 1 ? node : node.parentElement; while (el && el.parentElement !== prose) el = el.parentElement; while (el && !/^H[1-4]$/.test(el.tagName)) el = el.previousElementSibling; return el ? el.textContent.replace(/^#\s*/, '').trim() : ''; };
      document.addEventListener('selectionchange', () => {
        const sel = getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount || !prose.contains(sel.anchorNode)) { fab.hidden = true; return; }
        const text = sel.toString().trim(); if (text.length < 2) { fab.hidden = true; return; }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        pick = { quote: text.slice(0, 500), heading: headingOf(sel.anchorNode) };
        fab.style.top = `${rect.bottom + scrollY + 10}px`; fab.style.left = `${Math.max(12, Math.min(innerWidth - 120, rect.left + rect.width / 2 - 50))}px`;
        fab.hidden = false;
      });
      fab.addEventListener('pointerdown', e => e.preventDefault());
      fab.addEventListener('click', () => { fab.hidden = true; if (pick) openEditor(pick.quote, pick.heading); });
      prose.addEventListener('click', e => { const m = e.target.closest('mark.cm-hl'); if (!m) return; const c = $(`#cm-${CSS.escape(m.dataset.cid)}`); c?.scrollIntoView({ behavior: 'smooth', block: 'center' }); c?.classList.add('flash'); setTimeout(() => c?.classList.remove('flash'), 1600); });
    }
    render();
  }

  // ---------- 网页类产物：从独立的内容端口打开（和工作台不同源）----------
  {
    const meta = $('meta[name="mydash-content-port"]');
    // HTTPS 下内容端口是另一个（见 store.mjs 的 httpsContentPort）
    const port = location.protocol === 'https:' ? meta?.dataset.httpsPort || meta?.content : meta?.content;
    const origin = meta?.dataset.origin || (meta ? `${location.protocol}//${location.hostname}:${port}` : '');
    if (origin) {
      for (const f of $$('iframe[data-src]')) f.src = origin + f.dataset.src;
      for (const a of $$('a[data-isolated]')) a.href = origin + a.getAttribute('href');
    }
  }

  // 网页条目全屏查看
  $('.fs-btn')?.addEventListener('click', () => {
    const f = $('.frame'); if (!f) return;
    (f.requestFullscreen || f.webkitRequestFullscreen)?.call(f);
  });

  // 按 / 聚焦搜索框
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || /input|textarea|select/i.test(document.activeElement?.tagName || '')) return;
    const q = $('#q') || $('#pf'); if (q) { e.preventDefault(); q.focus(); }
  });

  // ---------- 项目改名：只改网页上的显示名，Claude Code 照常用文件夹名 ----------
  function bindRename() {
    const btn = $('.rename'), form = $('.rename-form'), title = $('.proj-title');
    if (!btn || !form || !title) return;
    const input = form.elements.name;
    const open = () => { title.hidden = true; form.hidden = false; input.value = body.dataset.display || ''; input.focus(); input.select(); };
    const close = () => { form.hidden = true; title.hidden = false; };
    btn.addEventListener('click', open);
    form.querySelector('.rename-cancel').addEventListener('click', close);
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const save = form.querySelector('.rename-save'); save.disabled = true;
      try {
        const r = await post('/api/project-name', { project: body.dataset.project, name: input.value });
        body.dataset.display = r.name;
        toast(r.name === body.dataset.project ? T('Back to the folder name') : T('Renamed to “{name}”', { name: r.name }));
        await Promise.all([refreshList(), refreshSide()]);
      } catch { toast(T('Rename failed. Try again in a moment.')); save.disabled = false; }
    });
  }
  bindRename();

  // ---------- 手机上条目页的「⋯」：其余操作收在菜单里，点外面或选了一项就收起 ----------
  const more = $('.more-btn');
  if (more) {
    const bar = more.closest('.doc-actions');
    const openMore = on => { bar.classList.toggle('open', on); more.setAttribute('aria-expanded', String(on)); };
    more.addEventListener('click', e => { e.stopPropagation(); openMore(!bar.classList.contains('open')); });
    document.addEventListener('click', e => { if (!e.target.closest('.doc-more')) openMore(false); else if (e.target.closest('.act')) setTimeout(() => openMore(false), 150); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') openMore(false); });
  }

  // ---------- 已读：打开条目页即标为已读（页面可见时才算），也能手动切换 ----------
  if (page === 'item' && body.dataset.id) {
    const id = body.dataset.id; const v = Number(body.dataset.version);
    let isRead = Number(body.dataset.seen) >= v;
    const btn = $('.read-toggle');
    const render = () => { if (btn) btn.textContent = isRead ? T('Mark as unread') : T('Mark as read'); };
    async function setRead(read) {
      try { await post('/api/read', read ? { id, v } : { id, unread: true }); isRead = read; render(); return true; }
      catch { toast(T('That did not work. Try again in a moment.')); return false; }
    }
    const auto = () => {
      if (isRead || document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', auto);
      setRead(true);
    };
    render();
    if (!isRead) { document.addEventListener('visibilitychange', auto); setTimeout(auto, 600); }
    btn?.addEventListener('click', async () => {
      document.removeEventListener('visibilitychange', auto);
      if (await setRead(!isRead)) toast(isRead ? T('Marked as read') : T('Marked as unread'));
    });
  }

  // ---------- 正文图片点开看原图 ----------
  document.addEventListener('click', e => {
    const img = e.target.closest('.prose img');
    if (img && !img.closest('a')) window.open(img.currentSrc || img.src, '_blank', 'noopener');
  });

  // ---------- 目录高亮 ----------
  const tocLinks = $$('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const map = new Map(tocLinks.map(a => [decodeURIComponent(a.hash.slice(1)), a]));
    const io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) {
        tocLinks.forEach(a => a.classList.remove('on'));
        map.get(en.target.id)?.classList.add('on');
      }
    }, { rootMargin: '-60px 0px -70% 0px' });
    for (const id of map.keys()) { const h = document.getElementById(id); if (h) io.observe(h); }
  }
  for (const a of $$('.toc-m a')) a.addEventListener('click', () => a.closest('details').open = false);

  // ---------- Mermaid ----------
  if (body.dataset.mermaid === '1') {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    const nodes = $$('pre.mermaid');
    for (const el of nodes) el.dataset.code = el.textContent;
    // 切换深浅色时按新配色重画
    const draw = async () => {
      window.mermaid.initialize({ startOnLoad: false, theme: root.dataset.theme === 'dark' ? 'dark' : 'neutral', securityLevel: 'strict', fontFamily: 'PingFang SC, Noto Sans SC, sans-serif' });
      for (const el of nodes) {
        el.removeAttribute('data-processed'); el.classList.remove('failed'); el.textContent = el.dataset.code;
        try { await window.mermaid.run({ nodes: [el] }); }
        catch (err) { el.classList.add('failed'); el.setAttribute('data-processed', '1'); el.title = String(err?.message || err); }
      }
    };
    s.onload = () => { draw(); document.addEventListener('mydash:theme', draw); };
    document.head.appendChild(s);
  }

  // ---------- PDF（没有逐页图片时才用浏览器渲染）----------
  // 以前只捕获了加载脚本失败，打开/解析 PDF 出错会被吞掉，页面一直停在“正在载入”
  function pdfFallback(el, err) {
    report('pdf: ' + (err?.message || err));
    const src = el.dataset.src;
    const msg = String(err?.message || err).slice(0, 120).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    el.innerHTML = `<p class="pdf-status">${T('In-page rendering failed ({msg}); using the browser’s own PDF viewer instead.', { msg })}<a href="${src}" target="_blank" rel="noopener">${T('Open in a new window')}</a></p><iframe class="pdf-fallback" src="${src}" title="PDF"></iframe>`;
  }
  if (body.dataset.pdf === '1') {
    const views = $$('.pdf-view:not(.pages)');
    import('/static/pdf-view.mjs')
      .then(m => views.forEach(el => Promise.resolve().then(() => m.mount(el)).catch(err => pdfFallback(el, err))))
      .catch(err => views.forEach(el => pdfFallback(el, err)));
  }
})();
