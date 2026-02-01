// ==UserScript==
// @name         Google Flights Helper - Multi Route/Class/Date Batch Runner
// @namespace    google.flights.helper.multirun
// @version      3.0.0
// @description  Batch runner for multiple destinations + cabin classes + date range. Records Cheapest tab price per combination. Auto remove US connecting airports (optional). Pause/Resume + Clear history. Trusted Types safe.
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
    // === Batch plan ===
    batchEnabled: true,

    // Date range (inclusive) in YYYY-MM-DD
    startDateISO: '2026-05-22',
    endDateISO:   '2026-09-30',
    stepDays: 1,

    // Route
    tripType: 'oneway', // 'oneway' | 'roundtrip' (roundtrip automation is placeholder)

    // Airports / Destinations
    origin: 'YYZ',
    destinations: ['HKG', 'ICN', 'TYO', 'CJU'], // change TYO to HND or NRT if you prefer

    // Cabin selection
    // Use: ['econ','pe','biz','first'] or 'all'
    cabins: 'all',

    // Pax
    passengers: 2, // automation tries to keep as is; not force-changing pax right now

    // === Scheduling / Stability ===
    debounceMs: 800,
    pollIntervalMs: 2500,
    ensurePanelEveryMs: 2000,

    // === Storage ===
    // Store is keyed by signature; signature includes origin/destination/cabin/tripType
    storeKey: 'gf_store_multirun_signature_v1',
    historyLines: 50,

    // === Throttles (avoid freeze) ===
    cheapestClickCooldownMs: 5000,
    connDialogCooldownMs: 7000,
    nextDayClickCooldownMs: 1200,
    maxAutoAttemptsPerState: 2,
    maxLoopSteps: 9999,

    // === Waits ===
    waitReadyTimeoutMs: 90000,
    waitReadyIntervalMs: 250,
    connOpenTimeoutMs: 12000,
    connCloseTimeoutMs: 8000,
    dateChangeTimeoutMs: 90000,
    airportSetTimeoutMs: 15000,
    comboboxSelectTimeoutMs: 10000,

    // === Preferences ===
    prefAutoRemoveUSKey: 'gf_pref_auto_remove_us_connections_v1',
    prefPausedKey: 'gf_pref_paused_v1',
    prefMinimizedKey: 'gf_pref_panel_minimized_v1',

    // === USA airports to uncheck (edit as needed) ===
    usaIata: new Set([
      "ATL","BOS","BWI","CLT","ORD","DFW","DEN","DTW","EWR",
      "IAD","JFK","LAX","LGA","MIA","MSP","PDX","PHL","PHX",
      "SEA","SFO","SLC","TPA","SAN","SJC","AUS","MCO","RDU",
      "FLL","LAS","IAH","MDW","OAK","CLE","CMH","STL","HNL"
    ])
  };

  /********************
   * LOGGING
   ********************/
  const LOG = '[GF MultiRun]';
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

  function typeInto(el, text) {
    if (!el) return false;
    try {
      el.focus();
      // clear
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // set
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
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

  function addDaysISO(iso, days) {
    const d = isoToDate(iso);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return dateToISO(d);
  }

  function cmpISO(a, b) {
    // ISO date string compare works lexicographically
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /********************
   * UI
   ********************/
  const UI = {
    panelId: 'gf-multirun-panel',
    miniBox: 'gf-multirun-minibox',
    minBtn: 'gf-multirun-minbtn',

    status: 'gf-multirun-status',
    debug: 'gf-multirun-debug',
    plan:  'gf-multirun-plan',
    sig:   'gf-multirun-sig',
    cheapest: 'gf-multirun-cheapest',
    history: 'gf-multirun-history',

    pauseBtn: 'gf-multirun-pausebtn',
    runBtn: 'gf-multirun-runbtn',
    clearSigBtn: 'gf-multirun-clearsig',
    clearAllBtn: 'gf-multirun-clearall'
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

    panel.appendChild(mk('div', { class: 'title' }, 'GF Multi-Run Batch Helper'));

    const minBtn = mk('button', { id: UI.minBtn, class: 'mini-btn', title: 'Minimize' }, '—');
    panel.appendChild(minBtn);

    const rowBtns = mk('div', { class: 'row' });
    const btnRun = mk('button', { id: UI.runBtn }, 'Run batch now');
    const btnPause = mk('button', { id: UI.pauseBtn }, 'Pause: OFF');
    rowBtns.appendChild(btnRun);
    rowBtns.appendChild(btnPause);
    panel.appendChild(rowBtns);

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
        width: 640px; z-index: 2147483647;
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
        min-width:220px;
      }
      #${UI.panelId} button:hover{background:rgba(255,255,255,.18);}
      #${UI.panelId} .line{font-size:12px;opacity:.95;}
      #${UI.panelId} .small{opacity:.8;}
      #${UI.panelId} .history{
        margin:0;padding:8px;border-radius:10px;
        background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.10);
        max-height:360px;overflow:auto;
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
        box-shadow: 0 12px 30px rgba(0,0,0,.35);
      }
      #${UI.miniBox}:hover{ background: rgba(255,255,255,.18); }
    `);

    // Minimized state
    const minPref = await gmGet(CFG.prefMinimizedKey, '0');
    await setMinimized(minPref === '1');

    // Paused state
    const pausedPref = await gmGet(CFG.prefPausedKey, '0');
    state.paused = (pausedPref === '1');
    setText(UI.status, state.paused ? 'Status: Ready (Paused)' : 'Status: Ready');
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
   * GOOGLE FLIGHTS UI: Find/Select controls
   ********************/
  function findComboboxByLabel(labelRe) {
    const combos = qsa('[role="combobox"]');
    for (const cb of combos) {
      const labelled = cb.getAttribute('aria-labelledby') || '';
      if (!labelled) continue;
      for (const id of labelled.split(/\s+/).filter(Boolean)) {
        const labelEl = document.getElementById(id);
        const aria = labelEl ? (labelEl.getAttribute('aria-label') || '') : '';
        if (labelRe.test(aria)) return cb;
      }
    }
    return null;
  }

  async function selectFromCombobox(labelRe, optionTextRe) {
    const cb = findComboboxByLabel(labelRe);
    if (!cb) return { ok: false, reason: 'combobox not found' };

    clickReal(cb);

    const opened = await waitFor(() => qsa('[role="option"]').length > 0, CFG.comboboxSelectTimeoutMs, 200);
    if (!opened) return { ok: false, reason: 'options did not appear' };

    const opts = qsa('[role="option"]');
    const hit = opts.find(o => optionTextRe.test(norm(o.textContent)));
    if (!hit) return { ok: false, reason: 'option not found' };

    clickReal(hit);
    return { ok: true };
  }

  function inputWhereFrom() {
    return qs('input[aria-label="Where from?"], input[aria-label^="Where from"]');
  }
  function inputWhereTo() {
    return qs('input[aria-label="Where to?"], input[aria-label^="Where to"]');
  }

  async function setAirportInput(inputEl, codeOrText) {
    if (!inputEl) return { ok: false, reason: 'input not found' };
    clickReal(inputEl);
    await sleep(100);

    // Clear via value + input events
    typeInto(inputEl, codeOrText);

    // Try to select first suggestion
    const okSuggest = await waitFor(() => {
      const opts = qsa('[role="option"]');
      return opts.length > 0;
    }, CFG.airportSetTimeoutMs, 200);

    if (okSuggest) {
      const opts = qsa('[role="option"]');
      // Prefer option containing the code (e.g., "YYZ"), else first option
      const up = String(codeOrText).trim().toUpperCase();
      const best = opts.find(o => norm(o.textContent).toUpperCase().includes(up)) || opts[0];
      if (best) clickReal(best);
      await sleep(150);
      return { ok: true };
    }

    // Fallback: press Enter (sometimes accepts typed text)
    try {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      return { ok: true, fallback: true };
    } catch (e) {}

    return { ok: false, reason: 'no suggestions appeared' };
  }

  function getDepartureLabel() {
    const dep = qs('input[aria-label="Departure"], input[placeholder="Departure"]');
    return norm(dep ? dep.value : '');
  }

  function getDepISOFromLabelGuess(label) {
    if (!label) return '';
    // We guess year from configured start/end range (same year expected)
    const year = (CFG.startDateISO || '').slice(0, 4) || String(new Date().getFullYear());
    const d = new Date(`${label} ${year}`);
    if (!isNaN(d.getTime())) return dateToISO(d);

    const stripped = label.replace(/^[A-Za-z]{3,},\s*/g, '');
    const d2 = new Date(`${stripped} ${year}`);
    if (!isNaN(d2.getTime())) return dateToISO(d2);

    return '';
  }

  function findDayDeltaButton(delta) {
    // delta: -1 or +1
    const depInput = qs('input[aria-label="Departure"], input[placeholder="Departure"]');
    const sel = `button[jsname="a1ZUMe"][data-delta="${delta}"]`;
    if (depInput) {
      const wrap = depInput.closest('.NA5Egc') || depInput.parentElement;
      if (wrap) {
        const btn = wrap.querySelector(sel);
        if (btn) return btn;
      }
    }
    return qs(sel);
  }

  async function gotoDepartureISO(targetISO) {
    const depInput = qs('input[aria-label="Departure"], input[placeholder="Departure"]');
    if (!depInput) return { ok: false, reason: 'departure input not found' };

    // Loop click +1 or -1 until matches target
    const start = Date.now();
    let guard = 0;

    while (Date.now() - start < CFG.dateChangeTimeoutMs) {
      guard++;
      if (guard > 600) return { ok: false, reason: 'guard limit reached' };

      const curLabel = getDepartureLabel();
      const curISO = getDepISOFromLabelGuess(curLabel);
      if (curISO === targetISO) return { ok: true };

      // If we can't parse current date, try to open date picker and bail
      if (!curISO) {
        return { ok: false, reason: `cannot parse current departure label: "${curLabel}"` };
      }

      const delta = cmpISO(curISO, targetISO) < 0 ? 1 : -1;
      const btn = findDayDeltaButton(delta);
      if (!btn) return { ok: false, reason: `day delta button not found (delta=${delta})` };

      const prevLabel = curLabel;
      clickReal(btn);

      const changed = await waitFor(() => getDepartureLabel() && getDepartureLabel() !== prevLabel, 15000, 250);
      if (!changed) return { ok: false, reason: 'timeout waiting for departure to change' };

      // small settle
      await sleep(150);
    }
    return { ok: false, reason: 'timeout reaching target date' };
  }

  /********************
   * Cheapest tab + loading
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

  /********************
   * Connecting airports (auto-uncheck US)
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
   * PLAN BUILDING
   ********************/
  function normalizeCabins(cabins) {
    const all = ['econ','pe','biz','first'];
    if (cabins === 'all') return all;
    if (Array.isArray(cabins) && cabins.length) return cabins;
    return ['econ'];
  }

  function cabinToUiRegex(cabinKey) {
    // match visible option label for seating class
    // These strings may vary by locale; adjust if needed.
    switch (cabinKey) {
      case 'econ':  return /economy/i;
      case 'pe':    return /premium\s*economy/i;
      case 'biz':   return /business/i;
      case 'first': return /^first$/i;
      default:      return /economy/i;
    }
  }

  function tripTypeToUiRegex(tripType) {
    // Google labels often: "One-way" / "Round trip"
    if (tripType === 'roundtrip') return /round\s*trip/i;
    return /one-?way/i;
  }

  function buildPlan() {
    const cabins = normalizeCabins(CFG.cabins);
    const plan = [];

    let d = CFG.startDateISO;
    while (d && cmpISO(d, CFG.endDateISO) <= 0) {
      for (const dest of CFG.destinations) {
        for (const cabin of cabins) {
          plan.push({
            origin: CFG.origin,
            dest,
            cabin,
            tripType: CFG.tripType,
            depISO: d
          });
        }
      }
      d = addDaysISO(d, CFG.stepDays);
    }
    return plan;
  }

  /********************
   * STORE + HISTORY
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

  /********************
   * SIGNATURE + RECORD
   ********************/
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

  function makeSignature(step) {
    const cur = getCurrencyCode();
    const loc = getLocationValue();
    return [
      `trip=${step.tripType}`,
      `pax=${CFG.passengers}`,
      `cabin=${step.cabin}`,
      `start=${step.origin}`,
      `end=${step.dest}`,
      `loc=${loc}`,
      `cur=${cur}`
    ].join('|');
  }

  async function recordCheapest(step, best) {
    const sig = makeSignature(step);
    state.currentSignature = sig;

    const store = await loadStore();
    if (!store[sig]) store[sig] = {};

    const rec = {
      signature: sig,
      dateKey: step.depISO,
      tripType: step.tripType,
      pax: CFG.passengers,
      cabin: step.cabin,
      start: step.origin,
      end: step.dest,
      loc: getLocationValue(),
      cur: getCurrencyCode(),
      pretty: `${step.origin}->${step.dest} ${step.depISO}`,
      cheapest: best.cash,
      cheapestLabel: best.token,
      updatedAt: new Date().toISOString()
    };

    const existing = store[sig][step.depISO];
    if (!existing || rec.cheapest < existing.cheapest) {
      store[sig][step.depISO] = rec;
      await saveStore(store);
      setText(UI.status, `Status: Recorded ✓`);
    } else {
      setText(UI.status, `Status: Seen (no improvement)`);
    }

    setText(UI.sig, `Signature: ${sig}`);
    setText(UI.cheapest, `Cheapest: ${best.token} (date=${step.depISO})`);
    setText(UI.history, formatHistoryCompact(store[sig]));
  }

  /********************
   * APPLY STEP (set UI to match plan)
   ********************/
  async function applyStepToUI(step) {
    setText(UI.status, `Status: Applying step (UI)…`);
    setText(UI.plan, `Plan: ${step.origin} -> ${step.dest} | ${step.tripType} | ${step.cabin} | ${step.depISO}`);

    // Trip type
    // NOTE: roundtrip UI automation can be added later (return date)
    const tripRes = await selectFromCombobox(/ticket type/i, tripTypeToUiRegex(step.tripType));
    if (!tripRes.ok) return { ok: false, reason: `trip type: ${tripRes.reason}` };

    // Cabin class
    const cabRes = await selectFromCombobox(/seating class|preferred seating class/i, cabinToUiRegex(step.cabin));
    if (!cabRes.ok) return { ok: false, reason: `cabin: ${cabRes.reason}` };

    // Set origin/dest
    const fromEl = inputWhereFrom();
    const toEl = inputWhereTo();
    const okFrom = await setAirportInput(fromEl, step.origin);
    if (!okFrom.ok) return { ok: false, reason: `origin: ${okFrom.reason}` };

    const okTo = await setAirportInput(toEl, step.dest);
    if (!okTo.ok) return { ok: false, reason: `dest: ${okTo.reason}` };

    // Set departure date (by stepping day +/- until target)
    const dateRes = await gotoDepartureISO(step.depISO);
    if (!dateRes.ok) return { ok: false, reason: `date: ${dateRes.reason}` };

    return { ok: true };
  }

  /********************
   * MAIN LOOP (batch)
   ********************/
  async function runBatch(reason) {
    const plan = state.plan;
    if (!plan.length) {
      setText(UI.status, 'Status: Plan empty');
      return;
    }

    let stepsDone = 0;
    while (state.planIndex < plan.length) {
      if (state.paused) {
        setText(UI.status, 'Status: Paused');
        return;
      }

      const step = plan[state.planIndex];
      setText(UI.plan, `Plan: [${state.planIndex + 1}/${plan.length}] ${step.origin} -> ${step.dest} | ${step.tripType} | ${step.cabin} | ${step.depISO}`);

      // Avoid infinite retry storms
      const key = `${step.origin}|${step.dest}|${step.tripType}|${step.cabin}|${step.depISO}`;
      if (key !== state.lastStateKey) {
        state.lastStateKey = key;
        state.autoAttemptsThisState = 0;
        state.lastCheapestClickTs = 0;
      }
      if (state.autoAttemptsThisState > CFG.maxAutoAttemptsPerState) {
        setText(UI.status, 'Status: Auto paused (too many attempts). Press "Run batch now".');
        setText(UI.debug, `Debug: attemptsThisState=${state.autoAttemptsThisState}`);
        return;
      }

      // Apply UI for this plan item
      const applied = await applyStepToUI(step);
      if (!applied.ok) {
        state.autoAttemptsThisState++;
        setText(UI.status, `Status: Apply failed: ${applied.reason}`);
        setText(UI.debug, `Debug: If selectors changed, update automation. Current step=${key}`);
        return;
      }

      // Ensure Cheapest tab
      const sel = await ensureCheapestSelectedThrottled();
      if (!sel.ok) {
        state.autoAttemptsThisState++;
        setText(UI.status, `Status: ${sel.reason}`);
        return;
      }
      if (sel.clicked) {
        setText(UI.status, 'Status: Clicked Cheapest (waiting…)');
        return; // next scheduler tick will continue
      }

      setText(UI.status, `Status: Waiting for load…`);
      const ready = await waitUntilReady();
      if (!ready) {
        state.autoAttemptsThisState++;
        setText(UI.status, `Status: Ready timeout`);
        return;
      }

      // Auto-remove US connections on signature change (kept from original)
      const sig = makeSignature(step);
      const sigChanged = (sig !== state.lastSignatureSeen);
      if (sigChanged) state.lastSignatureSeen = sig;
      if (sigChanged) {
        const appliedUS = await applyRemoveUSConnectionsIfNeeded(sig, 'sig-change');
        if (appliedUS) {
          setText(UI.status, 'Status: Waiting reload after Remove US…');
          const ready2 = await waitUntilReady();
          if (!ready2) {
            state.autoAttemptsThisState++;
            setText(UI.status, 'Status: Reload timeout after Remove US');
            return;
          }
        }
      }

      const best = getCheapestTabPrice();
      if (!best) {
        state.autoAttemptsThisState++;
        setText(UI.status, 'Status: No Cheapest price found');
        return;
      }

      await recordCheapest(step, best);
      setText(UI.debug, `Debug: loading=${loadingIndicatorExists() ? 1 : 0}`);

      // Advance
      state.planIndex++;
      stepsDone++;
      state.autoAttemptsThisState = 0;

      // Tiny delay to avoid hammering UI
      await sleep(300);
    }

    setText(UI.status, `Status: Batch complete ✓ (${stepsDone} records in this run)`);
  }

  /********************
   * SCHEDULER
   ********************/
  const state = {
    running: false,
    paused: false,

    // plan
    plan: [],
    planIndex: 0,

    // throttles & state
    debounceTimer: null,
    lastCheapestClickTs: 0,
    lastConnDialogTs: 0,
    lastStateKey: '',
    autoAttemptsThisState: 0,

    // signature tracking
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

    // while paused ignore auto triggers; allow manual
    if (state.paused && !String(reason || '').startsWith('manual')) {
      setText(UI.status, 'Status: Paused (auto ignored)');
      return;
    }

    state.running = true;
    try {
      await runBatch(reason);
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

  /********************
   * BOOT
   ********************/
  async function boot() {
    await mountPanelOnce();
    startPanelKeeper();

    // Initialize plan
    state.plan = CFG.batchEnabled ? buildPlan() : [];
    state.planIndex = 0;

    setText(UI.plan, `Plan: ${state.plan.length ? `${state.plan.length} steps queued` : 'Batch disabled/empty'}`);
    setText(UI.history, 'History: —');

    // Load paused state
    const pausedPref = await gmGet(CFG.prefPausedKey, '0');
    state.paused = (pausedPref === '1');
    const pbtn = document.getElementById(UI.pauseBtn);
    if (pbtn) pbtn.textContent = state.paused ? 'Pause: ON' : 'Pause: OFF';
    setText(UI.status, state.paused ? 'Status: Ready (Paused)' : 'Status: Ready');

    observeSpa();
    startPolling();

    // Kick off automatically once on boot (if not paused)
    schedule('boot');
  }

  boot().catch(err);

})();
