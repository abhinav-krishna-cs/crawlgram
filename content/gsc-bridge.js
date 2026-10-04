// Content script on search.google.com (Search Console).
//
//  1. OVERLAY  – on Settings → Crawl stats: a "Back up" button beside GSC's
//                Export button plus a compact CrawlVault status chip/panel.
//  2. REMINDER – on other GSC pages: a small "backup due" chip.
//  3. FETCH    – fallback for the background worker: fetches GSC pages
//                same-origin when the worker's own request isn't signed in.
//
// Backups don't click anything in GSC: the background worker reads the
// report's data straight from Search Console (see lib/gsc-data.js).
(() => {
  const BRAND = { red: '#E31E24', black: '#0A0A0A', grey: '#8A8783', greyLight: '#D8D6D1', greyLighter: '#E9E7E3', loss: '#E5484D', profit: '#12A150' };

  const isCrawlStatsPage = () => /\/settings\/crawl-stats\/?$/.test(location.pathname);
  const propertyId = () => new URL(location.href).searchParams.get('resource_id');
  const send = (msg) => chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err.message }));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'fetchHtml' && msg.url.startsWith('https://search.google.com/')) {
      fetch(msg.url, { credentials: 'include' }).then((r) => r.text()).then((html) => sendResponse({ html }), () => sendResponse({}));
      return true;
    }
    if (msg.type === 'dataChanged') refreshStatus();
  });

  // ======================================================================
  // Backup
  // ======================================================================

  let busy = false;
  async function backupNow() {
    const pid = propertyId();
    if (busy || !pid) return;
    busy = true;
    panel.set({ status: 'working', message: 'Reading crawl stats from Search Console…', open: true });
    const res = await send({ type: 'backup', propertyIds: [pid], source: 'overlay' });
    busy = false;
    const r = res?.results?.[0];
    if (!r?.ok) return panel.set({ status: 'error', message: r?.error || res?.error || 'Backup failed – reload the page and try again.' });
    panel.set({
      status: 'saved',
      message: r.duplicate ? 'Already up to date – nothing new since the last backup.' : `Saved ${r.dailyCount} days (${fmtDate(r.rangeStart)} → ${fmtDate(r.rangeEnd)}).`,
    });
    refreshStatus();
    setTimeout(() => { if (panel.state.status === 'saved') panel.set({ open: false }); }, 6000);
  }

  // ======================================================================
  // "Back up" button beside GSC's Export button
  // ======================================================================

  const findExportButton = () => {
    for (const el of document.querySelectorAll('[role="button"], button')) {
      if (el === inlineBtn) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (/^export$/i.test(label) && el.offsetParent !== null) return el;
    }
    return null;
  };

  let inlineBtn;
  function ensureInlineButton() {
    const exportBtn = isCrawlStatsPage() ? findExportButton() : null;
    if (!exportBtn) { inlineBtn?.remove(); return; }
    if (inlineBtn?.isConnected && inlineBtn.nextElementSibling === exportBtn) return;

    if (!inlineBtn) {
      inlineBtn = document.createElement('button');
      inlineBtn.type = 'button';
      inlineBtn.title = 'Save this Crawl stats report to CrawlVault';
      inlineBtn.innerHTML = `<span style="color:${BRAND.red};margin-right:6px">●</span>Back up crawl stats`;
      Object.assign(inlineBtn.style, {
        height: '36px', padding: '0 14px', marginRight: '8px', borderRadius: '6px', border: '0', cursor: 'pointer',
        background: BRAND.black, color: '#fff', font: '500 13px/36px Poppins, "Google Sans", Arial, sans-serif',
        letterSpacing: '0.02em', whiteSpace: 'nowrap', transition: 'background .15s', flex: '0 0 auto',
      });
      inlineBtn.onmouseenter = () => (inlineBtn.style.background = BRAND.red);
      inlineBtn.onmouseleave = () => (inlineBtn.style.background = BRAND.black);
      inlineBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); backupNow(); };
    }
    // GSC wraps Export in a fixed-height block; make it a row so both buttons sit on one line.
    const wrap = exportBtn.parentElement;
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center' });
    exportBtn.insertAdjacentElement('beforebegin', inlineBtn);
  }

  // ======================================================================
  // Status panel: a small chip by default, expands to a card on demand
  // ======================================================================

  const panel = (() => {
    let host, root, status = null;
    const state = { status: 'idle', message: '', open: false };

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'crawlvault-panel';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${PANEL_CSS}</style><div class="cv"></div>`;
      document.body.append(host);
      root.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'backup') backupNow();
        if (act === 'view') send({ type: 'openDashboard', propertyId: propertyId() });
        if (act === 'toggle') set({ open: !state.open });
      });
      render();
    }
    function unmount() { host?.remove(); host = null; }
    function set(patch) { Object.assign(state, patch); mount(); render(); }
    function setStatus(s) { status = s; render(); }

    function render() {
      if (!root) return;
      const el = root.querySelector('.cv');
      const s = status;
      const due = s?.isDue;
      if (!state.open) {
        el.className = 'cv cv--chip';
        el.innerHTML = `<button class="chip" data-act="toggle" aria-expanded="false" title="CrawlVault crawl stats backup">
          <span class="mark">CrawlVault<span class="dot">.</span></span>
          ${state.status === 'working' ? '<span class="tag">Saving…</span>' : due ? '<span class="tag tag--red">Backup due</span>' : s?.lastExportAt ? `<span class="tag">Saved ${esc(relDays(s.lastExportAt))}</span>` : ''}
        </button>`;
        return;
      }
      el.className = 'cv';
      const label = s?.label || (propertyId() || '').replace(/^sc-domain:/, '');
      const statusLine = !s ? 'Loading…'
        : s.lastExportAt ? `Last backup ${relDays(s.lastExportAt)} · ${s.daysStored} days stored${s.firstDate ? ` since ${fmtDate(s.firstDate)}` : ''}`
        : 'Not backed up yet';
      const msgCls = { working: 'msg', saved: 'msg msg--ok', error: 'msg msg--err' }[state.status];
      el.innerHTML = `
        <div class="head">
          <span class="mark">CrawlVault<span class="dot">.</span></span>
          <button class="icon" data-act="toggle" aria-label="Minimise" aria-expanded="true">–</button>
        </div>
        <p class="kicker">Crawl stats backup</p>
        <p class="prop">${esc(label)}</p>
        <p class="meta">${esc(statusLine)}${due ? ' <span class="tag tag--red">Due</span>' : ''}</p>
        ${msgCls ? `<p class="${msgCls}" role="status">${esc(state.message)}</p>` : ''}
        <button class="btn" data-act="backup" ${state.status === 'working' ? 'disabled' : ''}>${state.status === 'working' ? 'Backing up…' : 'Back up crawl stats'}</button>
        <button class="btn btn--outline" data-act="view">View saved data</button>
        <ol class="steps">
          <li><b>Back up</b> reads this report straight from Search Console. No Export, no file.</li>
          <li>Google keeps 90 days, so we remind you every ${s?.intervalDays ?? 21} days.</li>
          <li>Each backup merges with older ones, so your history keeps growing.</li>
        </ol>`;
    }
    return { mount, unmount, set, setStatus, state };
  })();

  async function refreshStatus() {
    const pid = propertyId();
    if (!pid) return;
    const s = await send({ type: 'getStatus', propertyId: pid });
    if (s?.ok) { panel.setStatus(s); dueChip.update(s); }
  }

  // ======================================================================
  // "Backup due" chip on other GSC pages (only for properties being tracked)
  // ======================================================================

  const dueChip = (() => {
    let el, dismissed = false;
    function update(s) {
      const show = !isCrawlStatsPage() && s?.isDue && s.lastExportAt && !dismissed;
      if (!show) { el?.remove(); return; }
      if (el?.isConnected) return;
      el = document.createElement('div');
      el.innerHTML = `<span style="color:${BRAND.red}">●</span> Crawl stats backup due for <b></b> <a href="#">Back up now</a> <button aria-label="Dismiss">×</button>`;
      el.querySelector('b').textContent = s.label;
      Object.assign(el.style, { position: 'fixed', left: '24px', bottom: '24px', zIndex: 2147483646, background: BRAND.black, color: '#fff', padding: '10px 14px', borderRadius: '6px', font: '400 13px/1.4 Inter, Arial, sans-serif', boxShadow: '0 4px 16px rgba(10,10,10,.2)', display: 'flex', gap: '8px', alignItems: 'center' });
      const a = el.querySelector('a');
      Object.assign(a.style, { color: '#fff', textDecoration: 'underline', textUnderlineOffset: '3px' });
      a.onclick = async (e) => {
        e.preventDefault();
        a.textContent = 'Saving…';
        const res = await send({ type: 'backup', propertyIds: [propertyId()], source: 'due-chip' });
        a.replaceWith(document.createTextNode(res?.ok ? '– saved ✓' : `– failed: ${res?.results?.[0]?.error || res?.error}`));
        setTimeout(() => el.remove(), 5000);
      };
      const x = el.querySelector('button');
      Object.assign(x.style, { background: 'none', border: 0, color: BRAND.greyLight, cursor: 'pointer', fontSize: '16px' });
      x.onclick = () => { dismissed = true; el.remove(); };
      document.body.append(el);
    }
    return { update };
  })();

  // ======================================================================
  // Page lifecycle (GSC is an SPA – watch for URL and DOM changes)
  // ======================================================================

  let lastHref = '';
  function onPage() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (isCrawlStatsPage() && propertyId()) {
      panel.mount();
      panel.set({ status: 'idle', message: '', open: false });
    } else panel.unmount();
    refreshStatus();
  }

  function init() {
    loadFonts();
    const tick = () => { onPage(); ensureInlineButton(); };
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; tick(); }, 400);
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(tick, 2000);
    tick();
  }

  // ======================================================================
  // Helpers
  // ======================================================================

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '–');
  function relDays(iso) {
    const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  }
  function loadFonts() {
    if (document.getElementById('cv-fonts')) return;
    const l = Object.assign(document.createElement('link'), { id: 'cv-fonts', rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@500;600;700&display=swap' });
    (document.head || document.documentElement).append(l);
  }

  const PANEL_CSS = `
    :host { all: initial; }
    .cv { position: fixed; right: 24px; bottom: 24px; z-index: 2147483645; width: 300px; background: #fff; color: ${BRAND.black};
      border: 1px solid ${BRAND.greyLight}; border-radius: 6px; box-shadow: 0 4px 16px rgba(10,10,10,.12); padding: 16px; box-sizing: border-box;
      font: 400 13px/1.5 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .cv--chip { width: auto; padding: 0; border: 0; background: none; box-shadow: none; }
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .mark { font: 600 15px/1 Poppins, 'Arial Black', sans-serif; letter-spacing: -0.01em; color: ${BRAND.black}; }
    .dot { color: ${BRAND.red}; }
    .icon { background: none; border: 0; font-size: 18px; cursor: pointer; color: ${BRAND.grey}; padding: 0 4px; }
    .chip { background: #fff; border: 1px solid ${BRAND.greyLight}; border-radius: 999px; padding: 10px 16px; cursor: pointer; box-shadow: 0 4px 16px rgba(10,10,10,.12); display: flex; gap: 8px; align-items: center; }
    .chip:hover { border-color: ${BRAND.red}; }
    .kicker { margin: 0 0 4px; font: 500 11px/1 Poppins, sans-serif; text-transform: uppercase; letter-spacing: .08em; color: ${BRAND.red}; display: flex; align-items: center; gap: 6px; }
    .kicker::before { content: ''; width: 10px; height: 2px; background: ${BRAND.red}; }
    .prop { margin: 0; font: 700 17px/1.2 Poppins, sans-serif; letter-spacing: -0.01em; word-break: break-all; }
    .meta { margin: 4px 0 12px; color: ${BRAND.grey}; font-size: 12px; }
    .tag { font: 500 10px/1 Poppins, sans-serif; text-transform: uppercase; letter-spacing: .04em; padding: 3px 8px; border-radius: 999px; border: 1px solid ${BRAND.greyLight}; color: ${BRAND.grey}; white-space: nowrap; }
    .tag--red { border-color: ${BRAND.red}; color: ${BRAND.red}; }
    .msg { margin: 0 0 12px; padding: 8px 10px; border-radius: 6px; background: ${BRAND.greyLighter}; font-size: 12px; border-left: 3px solid ${BRAND.black}; }
    .msg--ok { border-left-color: ${BRAND.profit}; }
    .msg--err { border-left-color: ${BRAND.loss}; }
    .btn { display: block; width: 100%; margin-top: 8px; padding: 10px 14px; border-radius: 6px; border: 1px solid ${BRAND.black}; cursor: pointer;
      background: ${BRAND.black}; color: #fff; font: 500 13px/1 Poppins, sans-serif; letter-spacing: .02em; transition: background .15s, color .15s, border-color .15s; }
    .btn:hover:not(:disabled) { background: ${BRAND.red}; border-color: ${BRAND.red}; }
    .btn:disabled { opacity: .6; cursor: progress; }
    .btn--outline { background: #fff; color: ${BRAND.black}; }
    .btn--outline:hover:not(:disabled) { background: #fff; color: ${BRAND.red}; border-color: ${BRAND.red}; }
    .btn:focus-visible, .icon:focus-visible, .chip:focus-visible { outline: 2px solid ${BRAND.red}; outline-offset: 2px; }
    .steps { margin: 14px 0 0; padding: 12px 0 0 18px; border-top: 1px solid ${BRAND.greyLighter}; color: ${BRAND.grey}; font-size: 12px; }
    .steps li { margin-bottom: 4px; }
    .steps b { color: ${BRAND.black}; font-weight: 600; }
    .steps li::marker { color: ${BRAND.red}; font-weight: 600; }`;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
