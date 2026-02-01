// ==UserScript==
// @name         Google Flights Helper - MultiRun via Seed TFS URLs (Stable)
// @namespace    google.flights.helper.multirun.seed
// @version      3.1.0
// @description  Batch runner across multiple destination/cabin combos using user-provided Google Flights seed URLs (?tfs=...). Iterates dates via Next Day. Records Cheapest tab price per combination. Auto-remove US connecting airports. Pause/Resume + Clear history. Trusted Types safe.
// @match        https://www.google.com/travel/flights/*
// @match        https://www.google.ca/travel/flights/*
// @include      https://www.google.*/travel/flights/*
// @run-at       document-idle
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  /********************
   * CONFIG (EDIT ME)
   ********************/
  const CFG = {
    // Date range (inclusive)
    startDateISO: '2026-05-22',
    endDateISO:   '2026-09-30',

    // Trip type label for signatures (URL itself enforces actual trip type)
    // Use: 'oneway' or 'roundtrip'
    tripType: 'oneway',

    // Cabin labels for signatures (URL itself enforces actual cabin)
    // Use: 'econ' | 'pe' | 'biz' | 'first'
    // IMPORTANT: Each seed URL should already be set to the matching cabin.
    seedSearches: [
      // ✅ Your provided example seed (YYZ -> HKG, 2026-05-25)
      {
        origin: 'YYZ',
        dest: 'HKG',
        cabin: 'econ',
        // This should be a seed URL that starts at or near your startDateISO.
        url: 'https://www.google.com/travel/flights/search?tfs=CBwQAhojEgoyMDI2LTA1LTI1agcIARIDWVlacgwIAxIIL20vMDdkZmtAAUABSAFwAYIBCwj___________8BmAEC&tfu=EgoIABAAGAAgAigB&hl=en&gl=CA'
      },

      // Add more seeds like these (copy from browser after setting cabin + trip + route):
      // { origin:'YYZ', dest:'HKG', cabin:'pe',   url:'https://www.google.com/travel/flights/search?tfs=...' },
      // { origin:'YYZ', dest:'HKG', cabin:'biz',  url:'https://www.google.com/travel/flights/search?tfs=...' },
      // { origin:'YYZ', dest:'HKG', cabin:'first',url:'https://www.google.com/travel/flights/search?tfs=...' },
      // { origin:'YYZ', dest:'ICN', cabin:'econ', url:'https://www.google.com/travel/flights/search?tfs=...' },
      // { origin:'YYZ', dest:'TYO', cabin:'econ', url:'https://www.google.com/travel/flights/search?tfs=...' },
    ],

    // scheduling
    debounceMs: 800,
    pollIntervalMs: 2500,
    ensurePanelEveryMs: 2000,

    // storage
    storeKey: 'gf_store_multirun_seed_v1',
    progressKey: 'gf_multirun_seed_progress_v1',
    historyLines: 60,

    // throttles
    cheapestClickCooldownMs: 5000,
    connDialogCooldownMs: 7000,
    nextDayClickCooldownMs: 1200,
    maxAutoAttemptsPerState: 3,
    maxLoopSteps: 200,

    // waits
    waitReadyTimeoutMs: 90000,
    waitReadyIntervalMs: 250,
    connOpenTimeoutMs: 12000,
    connCloseTimeoutMs: 8000,
    nextDayChangeTimeoutMs: 90000,

    // preference keys
    prefAutoRemoveUSKey: 'gf_pref_auto_remove_us_connections_v1',
    prefPausedKey: 'gf_pref_paused_v1',
    prefMinimizedKey: 'gf_pref_panel_minimized_v1',

    // USA airports to uncheck
    usaIata: new Set([
      "ATL","BOS","BWI","CLT","ORD","DFW","DEN","DTW","EWR",
      "IAD","JFK","LAX","LGA","MIA","MSP","PDX","PHL","PHX",
      "SEA","SFO","SLC","TPA","SAN","SJC","AUS","MCO","RDU",
      "FLL","LAS","IAH","MDW","OAK","CLE","CMH","STL","HNL"
    ])
  };

  const LOG = '[GF SeedMultiRun]';
  const log = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);
  const err = (...a) => console.error(LOG, ...a);

  /********************
   * HELPERS
   ********************/
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function waitFor(predicate, timeoutMs = 30000, intervalMs = 250) {
    return new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        let ok = false;
        try { ok = !!predicate(); } catch (e) {}
        if (ok) { clearInterval(t); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
      }, intervalMs);
    });
  }

  function gmGet(key, fallback) {
    try { return Promise.resolve(GM_getValue(key, fallback)); }
    catch (e) { return Promise.resolve(fallback); }
  }
  function gmSet(key, value) {
    try { return Promise.resolve(GM_setValue(key, value)); }
    catch (e) { return Promise.resolve(); }
  }

  function mk(tag, attrs, text) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'id') el.id = attrs[k];
        else if (k === 'type') el.type = attrs[k];
        else if (k === 'checked') el.checked = !!attrs[k];
        else if (k === 'value') el.value = attrs[k];
        else el.setAttribute(k, attrs[k]);
      });
    }
    if (text != null) el.textContent = text;
    return el;
  }

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function parseCashToNumber(label) {
    const m = String(label || '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }

  function clickReal(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (_) {}
      return false;
    }
  }

  function dateToISO(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function isoToDate(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function cmpISO(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /********************
   * UI
   ********************/
  const UI = {
    panelId: 'gf-seed-panel',
    miniBox: 'gf-seed-minibox',
    minBtn: 'gf-seed-minbtn',

    status: 'gf-seed-status',
    debug: 'gf-seed-debug',
    plan:  'gf-seed-plan',
    sig:   'gf-seed-sig',
    cheapest: 'gf-seed-cheapest',
    history: 'gf-seed-history',

    pauseBtn: 'gf-seed-pausebtn',
    runBtn: 'gf-seed-runbtn',
    clearSigBtn: 'gf-seed-clearsig',
    clearAllBtn: 'gf-seed-clearall',
    resetProgBtn: 'gf-seed-resetprog'
  };

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text == null ? '' : text);
  }

  function panelExists() { return !!document.getElementById(UI.panelId); }
  function miniExists() { return !!document.getElementById(UI.miniBox); }

  async function setMinimized(minimized) {
    await gmSet(CFG.prefMinimizedKey, minimized ? '1' : '0');
    const panel = document.getElementById(UI.panelId);
    const mini = document.getElementById(UI.miniBox);
    if (panel) panel.style.display = minimized ? 'none' : 'block';
    if (mini) mini.style.display = minimized ? 'flex' : 'none';
  }

  async function mountPanelOnce() {
    if (panelExists()) return true;

    const panel = mk('div', { id: UI.panelId });
    panel.style.position = 'fixed';

    panel.appendChild(mk('div', { class: 'title' }, 'GF Multi-Run (Seed URL Mode)'));

    const minBtn = mk('button', { id: UI.minBtn, class: 'mini-btn', title: 'Minimize' }, '—');
    panel.appendChild(minBtn);

    const rowBtns = mk('div', { class: 'row' });
    const btnRun = mk('button', { id: UI.runBtn }, 'Run / Continue');
    const btnPause = mk('button', { id: UI.pauseBtn }, 'Pause: OFF');
    rowBtns.appendChild(btnRun);
    rowBtns.appendChild(btnPause);
    panel.appendChild(rowBtns);

    const rowBtns2 = mk('div', { class: 'row' });
    const btnResetProg = mk('button', { id: UI.resetProgBtn }, 'Reset progress (start over)');
    rowBtns2.appendChild(btnResetProg);
    panel.appendChild(rowBtns2);

    const rowClear = mk('div', { class: 'row' });
    const clearSig = mk('button', { id: UI.clearSigBtn }, 'Clear current combo history');
    const clearAll = mk('button', { id: UI.clearAllBtn }, 'Clear ALL history');
    rowClear.appendChild(clearSig);
    rowClear.appendChild(clearAll);
    panel.appendChild(rowClear);

    const rowInfo = mk('div', { class: 'row-col' });
    rowInfo.appendChild(mk('div', { class: 'line', id: UI.plan }, 'Plan: —'));
    rowInfo.appendChild(mk('div', { class: 'line', id: UI.sig }, 'Signature: —'));
    rowInfo.appendChild(mk('div', { class: 'line', id: UI.cheapest }, 'Cheapest: —'));
    rowInfo.appendChild(mk('div', { class: 'line small', id: UI.status }, 'Status: Idle'));
    rowInfo.appendChild(mk('div', { class: 'line small', id: UI.debug }, 'Debug: —'));
    panel.appendChild(rowInfo);

    panel.appendChild(mk('pre', { id: UI.history, class: 'history' }, 'History: —'));

    (document.body || document.documentElement).appendChild(panel);

    if (!miniExists()) {
      const mini = mk('div', { id: UI.miniBox, title: 'Open panel' }, '☰');
      mini.style.display = 'none';
      document.body.appendChild(mini);
      mini.addEventListener('click', () => setMinimized(false));
    }

    GM_addStyle(`
      #${UI.panelId}{
        right: 16px; bottom: 16px;
        width: 720px; z-index: 2147483647;
        background: rgba(20,20,22,.92); color:#fff;
        border:1px solid rgba(255,255,255,.15);
        border-radius:12px; padding:10px 12px;
        font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
        box-shadow:0 12px 30px rgba(0,0,0,.35);
      }
      #${UI.panelId} .title{font-weight:700;margin-bottom:8px;}
      #${UI.panelId} .row{display:flex;gap:10px;margin-bottom:10px;align-items:center;flex-wrap:wrap;}
      #${UI.panelId} .row-col{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}
      #${UI.panelId} button{
        flex:1; cursor:pointer;
        border:1px solid rgba(255,255,255,.2);
        background:rgba(255,255,255,.10);
        color:#fff; padding:8px 10px; border-radius:10px;
        min-width:240px;
      }
      #${UI.panelId} button:hover{background:rgba(255,255,255,.18);}
      #${UI.panelId} .line{font-size:12px;opacity:.95;}
      #${UI.panelId} .small{opacity:.8;}
      #${UI.panelId} .history{
        margin:0;padding:8px;border-radius:10px;
        background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.10);
        max-height:380px;overflow:auto;
        white-space:pre-wrap;font-size:12px;line-height:1.35;
      }
      #${UI.minBtn}{
        position:absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        padding: 0;
        min-width: 28px;
        flex: 0 0 auto;
        background: rgba(255,255,255,.12);
        border: 1px solid rgba(255,255,255,.20);
        font-size: 18px;
        line-height: 26px;
        text-align: center;
      }
      #${UI.minBtn}:hover{ background: rgba(255,255,255,.22); }
      #${UI.miniBox}{
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 34px;
        height: 34px;
        z-index: 2147483647;
        background: rgba(20,20,22,.92);
        border: 1px solid rgba(255,255,255,.20);
        border-radius: 8px;
        color: #fff;
        font-size: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        user-select: none;
        box-shadow:0 12px 30px rgba(0,0,0,.35);
      }
      #${UI.miniBox}:hover{ background: rgba(255,255,255,.18); }
    `);

    // Minimized state
    const minPref = await gmGet(CFG.prefMinimizedKey, '0');
    await setMinimized(minPref === '1');

    // Paused state
    const pausedPref = await gmGet(CFG.prefPausedKey, '0');
    state.paused = (pausedPref === '1');
    const pbtn = document.getElementById(UI.pauseBtn);
    if (pbtn) pbtn.textContent = state.paused ? 'Pause: ON' : 'Pause: OFF';

    // Bind events
    minBtn.addEventListener('click', () => setMinimized(true));

    document.getElementById(UI.runBtn)?.addEventListener('click', () => runOnce('manual'));

    document.getElementById(UI.pauseBtn)?.addEventListener('click', async () => {
      state.paused = !state.paused;
      await gmSet(CFG.prefPausedKey, state.paused ? '1' : '0');
      const btn = document.getElementById(UI.pauseBtn);
      if (btn) btn.textContent = state.paused ? 'Pause: ON' : 'Pause: OFF';
      setText(UI.status, state.paused ? 'Status: Paused (auto-run disabled)' : 'Status: Resumed');
    });

    document.getElementById(UI.resetProgBtn)?.addEventListener('click', async () => {
      await gmSet(CFG.progressKey, JSON.stringify({ seedIndex: 0 }));
      setText(UI.status, 'Status: Progress reset ✓ (press Run / Continue)');
      // Don’t auto-navigate immediately; user clicks run.
    });

    document.getElementById(UI.clearSigBtn)?.addEventListener('click', async () => {
      const sig = state.currentSignature || '';
      if (!sig) { setText(UI.status, 'Status: No signature yet'); return; }
      const store = await loadStore();
      if (store[sig]) delete store[sig];
      await saveStore(store);
      setText(UI.history, 'History: —');
      setText(UI.status, 'Status: Cleared current combo history ✓');
    });

    document.getElementById(UI.clearAllBtn)?.addEventListener('click', async () => {
      await saveStore({});
      setText(UI.history, 'History: —');
      setText(UI.status, 'Status: Cleared ALL history ✓');
    });

    return true;
  }

  function startPanelKeeper() {
    setInterval(async () => {
      if (!panelExists()) await mountPanelOnce();
      if (!miniExists()) {
        const mini = mk('div', { id: UI.miniBox, title: 'Open panel' }, '☰');
        mini.style.display = 'none';
        document.body.appendChild(mini);
        mini.addEventListener('click', () => setMinimized(false));
      }
    }, CFG.ensurePanelEveryMs);
  }

  /********************
   * Flights DOM hooks (Cheapest + Date navigation)
   ********************/
  function findCheapestTab() {
    const byId = document.getElementById('M7sBEb');
    if (byId && (byId.getAttribute('role') || '') === 'tab') return byId;
    const tabs = qsa('[role="tab"]');
    for (const t of tabs) {
      if (norm(t.textContent).toLowerCase().includes('cheapest')) return t;
    }
    return null;
  }

  function isCheapestSelected(tabEl) {
    return tabEl && tabEl.getAttribute('aria-selected') === 'true';
  }

  function loadingIndicatorExists() {
    const tab = findCheapestTab();
    if (!tab) return true;
    const prog = tab.querySelector('div[jscontroller="DFTXbf"][data-progressvalue]');
    if (!prog) return false;
    return prog.getAttribute('data-progressvalue') !== '1';
  }

  function getCheapestTabPrice() {
    const tab = findCheapestTab();
    if (!tab) return null;
    const span = tab.querySelector('span.hXU5Ud.aA5Mwe') || tab.querySelector('span[aria-label][role="text"]');
    if (!span) return null;
    const label = norm(span.textContent);
    const cash = parseCashToNumber(label);
    return (cash == null) ? null : { cash, token: label };
  }

  async function ensureCheapestSelectedThrottled() {
    const tab = findCheapestTab();
    if (!tab) return { ok: false, reason: 'Cheapest tab not found' };
    if (isCheapestSelected(tab)) return { ok: true, clicked: false };

    const now = Date.now();
    if (now - state.lastCheapestClickTs < CFG.cheapestClickCooldownMs) {
      return { ok: false, reason: 'Cheapest click throttled' };
    }
    state.lastCheapestClickTs = now;
    clickReal(tab);
    return { ok: true, clicked: true };
  }

  async function waitUntilReady() {
    return await waitFor(() => (!loadingIndicatorExists() && !!getCheapestTabPrice()),
      CFG.waitReadyTimeoutMs, CFG.waitReadyIntervalMs);
  }

  function getDepartureLabel() {
    const dep = qs('input[aria-label="Departure"], input[placeholder="Departure"]');
    return norm(dep ? dep.value : '');
  }

  function getDepISOFromLabelGuess(label) {
    if (!label) return '';
    const year = (CFG.startDateISO || '').slice(0, 4) || String(new Date().getFullYear());
    const d = new Date(`${label} ${year}`);
    if (!isNaN(d.getTime())) return dateToISO(d);

    const stripped = label.replace(/^[A-Za-z]{3,},\s*/g, '');
    const d2 = new Date(`${stripped} ${year}`);
    if (!isNaN(d2.getTime())) return dateToISO(d2);

    return '';
  }

  function findNextDayButtonNearDeparture() {
    const depInput = qs('input[aria-label="Departure"], input[placeholder="Departure"]');
    if (depInput) {
      const wrap = depInput.closest('.NA5Egc') || depInput.parentElement;
      if (wrap) {
        const btn = wrap.querySelector('button[jsname="a1ZUMe"][data-delta="1"]');
        if (btn) return btn;
      }
    }
    return qs('button[jsname="a1ZUMe"][data-delta="1"]');
  }

  async function clickNextDayOnce() {
    const now = Date.now();
    if (now - state.lastNextDayClickTs < CFG.nextDayClickCooldownMs) {
      return { clicked: false, reason: 'next-day click throttled' };
    }

    const btn = findNextDayButtonNearDeparture();
    if (!btn) return { clicked: false, reason: 'next-day button not found' };

    state.lastNextDayClickTs = now;

    const prevLabel = getDepartureLabel();
    clickReal(btn);

    const okChange = await waitFor(() => {
      const newLabel = getDepartureLabel();
      return newLabel && newLabel !== prevLabel;
    }, CFG.nextDayChangeTimeoutMs, 250);

    if (!okChange) return { clicked: false, reason: 'timeout waiting for departure to change' };
    return { clicked: true, reason: 'clicked next day' };
  }

  /********************
   * Connecting airports (auto-uncheck US) - unchanged
   ********************/
  function findConnectingAirportsChipButton() {
    const chipContainer = document.querySelector('div[data-filtertype="8"].wpMGDb, div[data-filtertype="8"][jsname="qZXsDd"]');
    if (chipContainer) {
      const btn = chipContainer.querySelector('button[aria-label*="Connecting airports"]');
      if (btn) return btn;
    }
    const btns = Array.from(document.querySelectorAll('button[aria-label*="Connecting airports"]'));
    for (const b of btns) {
      const aria = b.getAttribute('aria-label') || '';
      if (/^Clear Connecting airports/i.test(aria)) continue;
      return b;
    }
    return null;
  }

  function findConnectingAirportsDialog() {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"][aria-modal="true"], div[role="dialog"]'));
    for (const d of dialogs) {
      const h2 = d.querySelector('h2');
      if (h2 && norm(h2.textContent).toLowerCase() === 'connecting airports') return d;
    }
    return null;
  }

  function ensureAllConnectingAirportsSwitchOff(dialog) {
    if (!dialog) return;
    const sw = dialog.querySelector('button[role="switch"][aria-label="All connecting airports"]');
    if (!sw) return;
    if (sw.getAttribute('aria-checked') === 'true') clickReal(sw);
  }

  function uncheckUSAInDialog(dialog) {
    const boxes = dialog ? Array.from(dialog.querySelectorAll('input[type="checkbox"][jsname="YPqjbf"]')) : [];
    let found = 0, unchecked = 0;
    for (const cb of boxes) {
      const code = (cb.value || '').trim().toUpperCase();
      if (!code) continue;
      if (CFG.usaIata.has(code)) {
        found++;
        if (cb.checked) { clickReal(cb); unchecked++; }
      }
    }
    return { found, unchecked };
  }

  async function applyRemoveUSConnectionsIfNeeded(signature, reason) {
    if (signature === state.lastSignatureAppliedForUS) return false;

    const pref = await gmGet(CFG.prefAutoRemoveUSKey, '1');
    if (pref !== '1') return false;

    const now = Date.now();
    if (now - state.lastConnDialogTs < CFG.connDialogCooldownMs) return false;
    state.lastConnDialogTs = now;

    setText(UI.status, `Status: Removing US connections… (${reason})`);

    const chip = findConnectingAirportsChipButton();
    if (!chip) { setText(UI.debug, 'Debug: Connecting airports chip not found'); return false; }

    clickReal(chip);

    const opened = await waitFor(() => !!findConnectingAirportsDialog(), CFG.connOpenTimeoutMs, 200);
    if (!opened) { setText(UI.debug, 'Debug: Connecting airports dialog did not open'); return false; }

    const dialog = findConnectingAirportsDialog();
    ensureAllConnectingAirportsSwitchOff(dialog);
    await sleep(200);

    const res = uncheckUSAInDialog(dialog);

    const closeBtn = dialog.querySelector('button[aria-label="Close dialog"]');
    if (closeBtn) clickReal(closeBtn);

    await waitFor(() => !findConnectingAirportsDialog(), CFG.connCloseTimeoutMs, 200);

    setText(UI.debug, `Debug: US found=${res.found} unchecked=${res.unchecked}`);
    state.lastSignatureAppliedForUS = signature;
    return true;
  }

  /********************
   * STORE + SIGNATURE
   ********************/
  async function loadStore() {
    const raw = await gmGet(CFG.storeKey, '{}');
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  async function saveStore(store) {
    await gmSet(CFG.storeKey, JSON.stringify(store));
  }

  function formatMMDD(iso) {
    if (!iso) return '??/??';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const p = iso.split('-');
      return `${p[1]}/${p[2]}`;
    }
    return String(iso);
  }

  function formatHistoryCompact(sigStore) {
    const keys = Object.keys(sigStore || {}).sort().reverse();
    const lines = keys.slice(0, CFG.historyLines).map(k => `${formatMMDD(k)}  ${sigStore[k].cheapestLabel}`);
    return lines.length ? lines.join('\n') : 'History: —';
  }

  function getCurrencyCode() {
    const btn = qs('button[aria-label^="Currency "]');
    if (btn) {
      const aria = btn.getAttribute('aria-label') || '';
      const m = aria.match(/^Currency\s+([A-Z]{3})\b/);
      if (m) return m[1];
      const span = btn.querySelector('span[jsname="nxRoyb"]');
      if (span && norm(span.textContent)) return norm(span.textContent);
    }
    return 'UnknownCurrency';
  }

  function getLocationValue() {
    const btns = qsa('button');
    for (const b of btns) {
      const text = norm(b.textContent).toLowerCase();
      if (text.includes('location')) {
        const tw = b.querySelector('span.twocKe');
        if (tw && norm(tw.textContent)) return norm(tw.textContent);
      }
    }
    return 'UnknownLocation';
  }

  function makeSignature(seed) {
    const cur = getCurrencyCode();
    const loc = getLocationValue();
    return [
      `trip=${CFG.tripType}`,
      `pax=1`,
      `cabin=${seed.cabin}`,
      `start=${seed.origin}`,
      `end=${seed.dest}`,
      `loc=${loc}`,
      `cur=${cur}`
    ].join('|');
  }

  async function recordCheapest(seed, depISO, best) {
    const sig = makeSignature(seed);
    state.currentSignature = sig;

    const store = await loadStore();
    if (!store[sig]) store[sig] = {};

    const rec = {
      signature: sig,
      dateKey: depISO,
      tripType: CFG.tripType,
      pax: 1,
      cabin: seed.cabin,
      start: seed.origin,
      end: seed.dest,
      loc: getLocationValue(),
      cur: getCurrencyCode(),
      pretty: `${seed.origin}->${seed.dest} ${depISO}`,
      cheapest: best.cash,
      cheapestLabel: best.token,
      updatedAt: new Date().toISOString()
    };

    const existing = store[sig][depISO];
    if (!existing || rec.cheapest < existing.cheapest) {
      store[sig][depISO] = rec;
      await saveStore(store);
      setText(UI.status, `Status: Recorded ✓`);
    } else {
      setText(UI.status, `Status: Seen (no improvement)`);
    }

    setText(UI.sig, `Signature: ${sig}`);
    setText(UI.cheapest, `Cheapest: ${best.token} (date=${depISO})`);
    setText(UI.history, formatHistoryCompact(store[sig]));
  }

  /********************
   * PROGRESS (persists across navigation)
   ********************/
  async function loadProgress() {
    const raw = await gmGet(CFG.progressKey, '');
    if (!raw) return { seedIndex: 0 };
    try { return JSON.parse(raw); } catch { return { seedIndex: 0 }; }
  }

  async function saveProgress(p) {
    await gmSet(CFG.progressKey, JSON.stringify(p));
  }

  /********************
   * MAIN RUNNER
   ********************/
  async function ensureOnSeedUrl(seed) {
    const here = String(location.href);
    if (here.startsWith(seed.url)) return true;

    // Navigate (full page load). Progress is saved.
    setText(UI.status, `Status: Navigating to seed URL (${seed.origin}->${seed.dest} ${seed.cabin})…`);
    await sleep(50);
    location.assign(seed.url);
    return false; // execution will restart after navigation
  }

  async function runLoop(reason) {
    if (!CFG.seedSearches || !CFG.seedSearches.length) {
      setText(UI.status, 'Status: No seed URLs configured');
      return;
    }

    const progress = await loadProgress();
    let seedIndex = Math.max(0, Math.min(progress.seedIndex || 0, CFG.seedSearches.length - 1));
    const seed = CFG.seedSearches[seedIndex];

    setText(UI.plan, `Plan: [${seedIndex + 1}/${CFG.seedSearches.length}] ${seed.origin}→${seed.dest} | cabin=${seed.cabin} | ${CFG.startDateISO}..${CFG.endDateISO}`);

    // Ensure we are on the correct seed page first
    const onSeed = await ensureOnSeedUrl(seed);
    if (!onSeed) return;

    // Determine current dep date from UI label
    const depLabel = getDepartureLabel();
    const depISO = getDepISOFromLabelGuess(depLabel);

    if (!depISO) {
      setText(UI.status, 'Status: Could not parse departure date from UI (check locale/label)');
      setText(UI.debug, `Debug: depLabel="${depLabel}"`);
      return;
    }

    // If already past end date, advance to next seed
    if (cmpISO(depISO, CFG.endDateISO) > 0) {
      seedIndex++;
      await saveProgress({ seedIndex });
      if (seedIndex >= CFG.seedSearches.length) {
        setText(UI.status, 'Status: All seed combos complete ✓');
        return;
      }
      setText(UI.status, 'Status: Combo done → next combo…');
      location.assign(CFG.seedSearches[seedIndex].url);
      return;
    }

    // If before start date, we still proceed and record from current day forward
    // (Best practice: make seed URL start close to startDateISO to reduce clicks)
    if (cmpISO(depISO, CFG.startDateISO) < 0) {
      setText(UI.status, `Status: Seed is before startDate (${depISO} < ${CFG.startDateISO}). Click next-day until start date…`);
    }

    // Main bounded loop (per page session)
    let steps = 0;
    while (steps < CFG.maxLoopSteps) {
      steps++;

      if (state.paused) {
        setText(UI.status, 'Status: Paused');
        return;
      }

      const curLabel = getDepartureLabel();
      const curISO = getDepISOFromLabelGuess(curLabel);
      if (!curISO) {
        setText(UI.status, 'Status: Date parse failed mid-run');
        setText(UI.debug, `Debug: label="${curLabel}"`);
        return;
      }

      // If beyond end date, move to next seed combo
      if (cmpISO(curISO, CFG.endDateISO) > 0) {
        seedIndex++;
        await saveProgress({ seedIndex });
        if (seedIndex >= CFG.seedSearches.length) {
          setText(UI.status, 'Status: All seed combos complete ✓');
          return;
        }
        setText(UI.status, 'Status: Combo complete → navigating to next combo…');
        location.assign(CFG.seedSearches[seedIndex].url);
        return;
      }

      // Ensure Cheapest tab selected
      const sel = await ensureCheapestSelectedThrottled();
      if (!sel.ok) { setText(UI.status, `Status: ${sel.reason}`); return; }
      if (sel.clicked) { setText(UI.status, 'Status: Clicked Cheapest (waiting…)'); return; }

      // Wait for load
      setText(UI.status, `Status: Waiting for load… (${curISO})`);
      const ready = await waitUntilReady();
      if (!ready) { setText(UI.status, 'Status: Ready timeout'); return; }

      // Apply Remove US connections when signature changes (seed-specific signature)
      const sig = makeSignature(seed);
      if (sig !== state.lastSignatureSeen) state.lastSignatureSeen = sig;

      const removed = await applyRemoveUSConnectionsIfNeeded(sig, 'sig-change');
      if (removed) {
        setText(UI.status, 'Status: Waiting reload after Remove US…');
        const ready2 = await waitUntilReady();
        if (!ready2) { setText(UI.status, 'Status: Reload timeout after Remove US'); return; }
      }

      // Record if within desired start..end
      if (cmpISO(curISO, CFG.startDateISO) >= 0 && cmpISO(curISO, CFG.endDateISO) <= 0) {
        const best = getCheapestTabPrice();
        if (!best) { setText(UI.status, 'Status: No Cheapest price found'); return; }
        await recordCheapest(seed, curISO, best);
      } else {
        setText(UI.status, `Status: Skipping record (outside range): ${curISO}`);
      }

      setText(UI.debug, `Debug: curISO=${curISO} loading=${loadingIndicatorExists() ? 1 : 0}`);

      // Next day
      const clickRes = await clickNextDayOnce();
      if (!clickRes.clicked) {
        setText(UI.status, `Status: Stopped (${clickRes.reason})`);
        return;
      }

      setText(UI.status, 'Status: Clicked next day → waiting…');
      await sleep(350);
    }

    setText(UI.status, `Status: Stopped (max steps ${CFG.maxLoopSteps})`);
  }

  /********************
   * SCHEDULER
   ********************/
  const state = {
    running: false,
    paused: false,
    debounceTimer: null,

    lastCheapestClickTs: 0,
    lastConnDialogTs: 0,
    lastNextDayClickTs: 0,

    lastSignatureSeen: '',
    lastSignatureAppliedForUS: '',
    currentSignature: ''
  };

  async function schedule(reason) {
    if (!panelExists()) return;
    if (state.paused) return;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => runOnce('auto:' + reason), CFG.debounceMs);
  }

  async function runOnce(reason) {
    if (state.running) return;

    if (state.paused && !String(reason || '').startsWith('manual')) {
      setText(UI.status, 'Status: Paused (auto ignored)');
      return;
    }

    state.running = true;
    try {
      await runLoop(reason);
    } catch (e) {
      err('runOnce failed:', e);
      setText(UI.status, 'Status: Error — check console');
    } finally {
      state.running = false;
    }
  }

  function observeSpa() {
    const root = qs('main') || document.body;
    if (!root) return;
    const mo = new MutationObserver(() => { schedule('mutation'); });
    mo.observe(root, { childList: true, subtree: true });
  }

  function startPolling() {
    setInterval(() => { schedule('poll'); }, CFG.pollIntervalMs);
  }

  async function boot() {
    await mountPanelOnce();
    startPanelKeeper();

    // Load paused state
    const pausedPref = await gmGet(CFG.prefPausedKey, '0');
    state.paused = (pausedPref === '1');
    setText(UI.status, state.paused ? 'Status: Ready (Paused)' : 'Status: Ready');

    observeSpa();
    startPolling();

    schedule('boot');
  }

  boot().catch(err);

})();
