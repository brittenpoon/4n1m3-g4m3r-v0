// ==UserScript==
// @name         Google Flights Helper - All-in-One + Hamburger Minimize
// @namespace    google.flights.helper
// @version      2.1.0
// @description  Cheapest tab + grouped history + auto remove US connecting airports on signature change + auto-next-day until stop date + hamburger minimize/restore + Pause/Resume + Clear history. Trusted Types safe.
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
   * CONFIG
   ********************/
  const CFG = {
    // scheduling
    debounceMs: 800,
    pollIntervalMs: 2500,
    ensurePanelEveryMs: 2000,

    // storage
    storeKey: 'gf_store_grouped_signature_v3',
    historyLines: 40,

    // throttles (avoid freeze)
    cheapestClickCooldownMs: 5000,
    connDialogCooldownMs: 7000,
    nextDayClickCooldownMs: 1200,
    maxAutoAttemptsPerState: 2,
    maxLoopSteps: 200,

    // waits
    waitReadyTimeoutMs: 60000,
    waitReadyIntervalMs: 250,
    connOpenTimeoutMs: 12000,
    connCloseTimeoutMs: 8000,
    nextDayChangeTimeoutMs: 60000,

    // preference keys
    prefAutoRemoveUSKey: 'gf_pref_auto_remove_us_connections_v1',
    prefAutoNextDayKey: 'gf_pref_auto_next_day_v2',
    prefStopDateKey: 'gf_pref_stop_date_iso_v2',
    prefMinimizedKey: 'gf_pref_panel_minimized_v1',

    // NEW (A): Pause/resume automation (poll/mutation auto-run)
    prefPausedKey: 'gf_pref_paused_v1',

    defaultDaysForward: 30,

    // USA airports to uncheck (edit as needed)
    usaIata: new Set([
      "ATL","BOS","BWI","CLT","ORD","DFW","DEN","DTW","EWR",
      "IAD","JFK","LAX","LGA","MIA","MSP","PDX","PHL","PHX",
      "SEA","SFO","SLC","TPA","SAN","SJC","AUS","MCO","RDU",
      "FLL","LAS","IAH","MDW","OAK","CLE","CMH","STL","HNL"
    ])
  };

  const LOG = '[GF Helper]';
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

  function addDaysISO(iso, days) {
    const d = isoToDate(iso);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return dateToISO(d);
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /********************
   * UI
   ********************/
  const UI = {
    panelId: 'gf-helper-panel',
    miniBox: 'gf-helper-minibox',
    minBtn: 'gf-helper-minbtn',

    status: 'gf-helper-status',
    debug: 'gf-helper-debug',
    sig: 'gf-helper-sig',
    ctx: 'gf-helper-ctx',
    cheapest: 'gf-helper-cheapest',
    history: 'gf-helper-history',

    autoUS: 'gf-helper-autous',
    autoNext: 'gf-helper-autonext',
    stopDate: 'gf-helper-stopdate',
    stopLabel: 'gf-helper-stoplabel',

    // NEW (A + C)
    pauseBtn: 'gf-helper-pausebtn',
    clearSigBtn: 'gf-helper-clearsig',
    clearAllBtn: 'gf-helper-clearall'
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

    // Title
    panel.appendChild(mk('div', { class: 'title' }, 'Google Flights Helper'));

    // Minimize button (top-right)
    const minBtn = mk('button', { id: UI.minBtn, class: 'mini-btn', title: 'Minimize' }, '—');
    panel.appendChild(minBtn);

    // Buttons row
    const rowBtns = mk('div', { class: 'row' });
    const btnRun = mk('button', { id: 'gf-run' }, 'Run now');
    const btnCsv = mk('button', { id: 'gf-csv' }, 'Download CSV');
    rowBtns.appendChild(btnRun);
    rowBtns.appendChild(btnCsv);
    panel.appendChild(rowBtns);

    // NEW (A) Pause row
    const rowPause = mk('div', { class: 'row' });
    const pauseBtn = mk('button', { id: UI.pauseBtn }, 'Pause: OFF');
    rowPause.appendChild(pauseBtn);
    panel.appendChild(rowPause);

    // NEW (C) Clear history row
    const rowClear = mk('div', { class: 'row' });
    const clearSig = mk('button', { id: UI.clearSigBtn }, 'Clear this route history');
    const clearAll = mk('button', { id: UI.clearAllBtn }, 'Clear ALL history');
    rowClear.appendChild(clearSig);
    rowClear.appendChild(clearAll);
    panel.appendChild(rowClear);

    // Auto-remove US toggle
    const rowUS = mk('div', { class: 'row' });
    const labUS = mk('label', { class: 'toggle' });
    const cbUS = mk('input', { id: UI.autoUS, type: 'checkbox' });
    labUS.appendChild(cbUS);
    labUS.appendChild(mk('span', null, ' Auto-remove US connecting airports (on signature change)'));
    rowUS.appendChild(labUS);
    panel.appendChild(rowUS);

    // Auto-next-day + stop date
    const rowNext = mk('div', { class: 'row' });
    const labNext = mk('label', { class: 'toggle' });
    const cbNext = mk('input', { id: UI.autoNext, type: 'checkbox' });
    labNext.appendChild(cbNext);
    labNext.appendChild(mk('span', null, ' Auto-next-day'));
    rowNext.appendChild(labNext);

    const stop = mk('input', { id: UI.stopDate, type: 'date', class: 'date' });
    rowNext.appendChild(mk('span', { class: 'label' }, 'Stop:'));
    rowNext.appendChild(stop);
    panel.appendChild(rowNext);

    const rowStop = mk('div', { class: 'row-col' });
    rowStop.appendChild(mk('div', { class: 'line small', id: UI.stopLabel }, 'Stop date: —'));
    panel.appendChild(rowStop);

    // Info
    const rowInfo = mk('div', { class: 'row-col' });
    rowInfo.appendChild(mk('div', { class: 'line', id: UI.ctx }, 'Context: —'));
    rowInfo.appendChild(mk('div', { class: 'line', id: UI.sig }, 'Signature (grouped): —'));
    rowInfo.appendChild(mk('div', { class: 'line', id: UI.cheapest }, 'Cheapest: —'));
    rowInfo.appendChild(mk('div', { class: 'line small', id: UI.status }, 'Status: Idle'));
    rowInfo.appendChild(mk('div', { class: 'line small', id: UI.debug }, 'Debug: —'));
    panel.appendChild(rowInfo);

    // History
    panel.appendChild(mk('pre', { id: UI.history, class: 'history' }, 'History: —'));

    (document.body || document.documentElement).appendChild(panel);

    // Mini square (hamburger only)
    if (!miniExists()) {
      const mini = mk('div', { id: UI.miniBox, title: 'Open panel' }, '☰');
      mini.style.display = 'none';
      document.body.appendChild(mini);
      mini.addEventListener('click', () => setMinimized(false));
    }

    // Styles
    GM_addStyle(`
      #${UI.panelId}{
        right: 16px; bottom: 16px;
        width: 560px; z-index: 2147483647;
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
        min-width:160px;
      }
      #${UI.panelId} button:hover{background:rgba(255,255,255,.18);}
      #${UI.panelId} .toggle{display:flex;gap:6px;align-items:center;font-size:12px;user-select:none;white-space:nowrap;}
      #${UI.panelId} .label{font-size:12px;opacity:.85;}
      #${UI.panelId} .date{
        background:rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.18);
        color:#fff; padding:6px 8px; border-radius:10px;
        font-size:12px;
      }
      #${UI.panelId} .line{font-size:12px;opacity:.95;}
      #${UI.panelId} .small{opacity:.8;}
      #${UI.panelId} .history{
        margin:0;padding:8px;border-radius:10px;
        background:rgba(255,255,255,.06);
        border:1px solid rgba(255,255,255,.10);
        max-height:340px;overflow:auto;
        white-space:pre-wrap;font-size:12px;line-height:1.35;
      }

      /* minimize button */
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

      /* minimized square (hamburger icon only) */
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

    // Load prefs (defaults)
    const prefUS = await gmGet(CFG.prefAutoRemoveUSKey, '1');
    cbUS.checked = (prefUS === '1');

    const prefNext = await gmGet(CFG.prefAutoNextDayKey, '0');
    cbNext.checked = (prefNext === '1');

    const stopISO = await gmGet(CFG.prefStopDateKey, '');
    if (stopISO) stop.value = stopISO;
    setText(UI.stopLabel, `Stop date: ${stopISO || '—'}`);

    // Minimized state
    const minPref = await gmGet(CFG.prefMinimizedKey, '0');
    await setMinimized(minPref === '1');

    // NEW (A) Paused state
    const pausedPref = await gmGet(CFG.prefPausedKey, '0');
    state.paused = (pausedPref === '1');
    const pauseBtnEl = document.getElementById(UI.pauseBtn);
    if (pauseBtnEl) pauseBtnEl.textContent = state.paused ? 'Pause: ON' : 'Pause: OFF';

    // Bind events
    minBtn.addEventListener('click', () => setMinimized(true));

    cbUS.addEventListener('change', async (e) => {
      await gmSet(CFG.prefAutoRemoveUSKey, e.target.checked ? '1' : '0');
      setText(UI.status, e.target.checked ? 'Status: Auto-remove US enabled' : 'Status: Auto-remove US disabled');
    });

    cbNext.addEventListener('change', async (e) => {
      await gmSet(CFG.prefAutoNextDayKey, e.target.checked ? '1' : '0');
      setText(UI.status, e.target.checked ? 'Status: Auto-next-day enabled' : 'Status: Auto-next-day disabled');
    });

    stop.addEventListener('change', async (e) => {
      const iso = e.target.value || '';
      await gmSet(CFG.prefStopDateKey, iso);
      setText(UI.stopLabel, `Stop date: ${iso || '—'}`);
    });

    btnRun.addEventListener('click', () => runOnce('manual'));
    btnCsv.addEventListener('click', () => downloadCsv().catch(err));

    // NEW (A) Pause toggle (persisted)
    document.getElementById(UI.pauseBtn)?.addEventListener('click', async () => {
      state.paused = !state.paused;
      await gmSet(CFG.prefPausedKey, state.paused ? '1' : '0');

      const btn = document.getElementById(UI.pauseBtn);
      if (btn) btn.textContent = state.paused ? 'Pause: ON' : 'Pause: OFF';

      setText(UI.status, state.paused ? 'Status: Paused (auto-run disabled)' : 'Status: Resumed');
    });

    // NEW (C) Clear history: current signature
    document.getElementById(UI.clearSigBtn)?.addEventListener('click', async () => {
      const ctx = await computeContext();
      const store = await loadStore();

      if (store[ctx.signature]) delete store[ctx.signature];
      await saveStore(store);

      setText(UI.history, 'History: —');
      setText(UI.status, 'Status: Cleared history for this signature ✓');
    });

    // NEW (C) Clear history: all
    document.getElementById(UI.clearAllBtn)?.addEventListener('click', async () => {
      await saveStore({});
      setText(UI.history, 'History: —');
      setText(UI.status, 'Status: Cleared ALL history ✓');
    });

    return true;
  }

  function startPanelKeeper() {
    setInterval(async () => {
      // If panel vanished due to SPA rerender, remount it
      if (!panelExists()) {
        await mountPanelOnce();
      }
      // If mini box vanished, re-add
      if (!miniExists()) {
        const mini = mk('div', { id: UI.miniBox, title: 'Open panel' }, '☰');
        mini.style.display = 'none';
        document.body.appendChild(mini);
        mini.addEventListener('click', () => setMinimized(false));
      }
    }, CFG.ensurePanelEveryMs);
  }

  /********************
   * CONTEXT + SIGNATURE + DATE
   ********************/
  function findComboboxValue(labelRe) {
    const combos = qsa('[role="combobox"]');
    for (const cb of combos) {
      const labelled = cb.getAttribute('aria-labelledby') || '';
      if (!labelled) continue;
      for (const id of labelled.split(/\s+/).filter(Boolean)) {
        const labelEl = document.getElementById(id);
        const aria = labelEl ? (labelEl.getAttribute('aria-label') || '') : '';
        if (labelRe.test(aria)) {
          const valEl = cb.querySelector('span[jsname="Fb0Bif"]');
          const txt = norm(valEl ? valEl.textContent : cb.textContent);
          if (txt) return txt;
        }
      }
    }
    return '';
  }

  function getTripType() { return findComboboxValue(/ticket type/i) || 'UnknownTrip'; }
  function getCabinClass() { return findComboboxValue(/seating class|preferred seating class/i) || 'UnknownCabin'; }

  function getPassengersCount() {
    const btns = qsa('button[aria-label*="passengers"]');
    for (const btn of btns) {
      const aria = btn.getAttribute('aria-label') || '';
      const m = aria.match(/(\d+)\s+passengers?/i);
      if (m) return parseInt(m[1], 10);
      const span = btn.querySelector('span[jsname="xAX4ff"]');
      if (span && norm(span.textContent)) {
        const n = parseInt(norm(span.textContent), 10);
        if (!isNaN(n)) return n;
      }
    }
    return 1;
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

  function getFromToValues() {
    const fromInputs = qsa('input[aria-label="Where from?"], input[aria-label^="Where from"]');
    const toInputs = qsa('input[aria-label="Where to?"], input[aria-label^="Where to"]');
    return {
      from: norm(fromInputs[0] ? fromInputs[0].value : '') || 'NA_FROM',
      to: norm(toInputs[0] ? toInputs[0].value : '') || 'NA_TO'
    };
  }

  function getDepartureLabel() {
    const dep = qs('input[aria-label="Departure"], input[placeholder="Departure"]');
    return norm(dep ? dep.value : '');
  }

  async function getCurrentDepISOFromInput() {
    const depLabel = getDepartureLabel();
    if (!depLabel) return '';

    const stopISO = await gmGet(CFG.prefStopDateKey, '');
    const year = stopISO ? stopISO.slice(0, 4) : String(new Date().getFullYear());

    const d = new Date(`${depLabel} ${year}`);
    if (!isNaN(d.getTime())) return dateToISO(d);

    const stripped = depLabel.replace(/^[A-Za-z]{3,},\s*/g, '');
    const d2 = new Date(`${stripped} ${year}`);
    if (!isNaN(d2.getTime())) return dateToISO(d2);

    return '';
  }

  async function computeContext() {
    const tripType = getTripType();
    const pax = getPassengersCount();
    const cabin = getCabinClass();
    const loc = getLocationValue();
    const cur = getCurrencyCode();
    const rt = getFromToValues();

    const depLabel = getDepartureLabel();
    const depISO = await getCurrentDepISOFromInput();
    const dateKey = depISO || depLabel || 'NO_DATE';

    const signature =
      `trip=${tripType}` +
      `|pax=${pax}` +
      `|cabin=${cabin}` +
      `|start=${rt.from}` +
      `|end=${rt.to}` +
      `|loc=${loc}` +
      `|cur=${cur}`;

    return {
      signature,
      tripType, pax, cabin,
      start: rt.from, end: rt.to,
      loc, cur,
      depLabel, depISO,
      dateKey,
      pretty: `${rt.from}->${rt.to} ${depLabel || ''}`.trim()
    };
  }

  /********************
   * CHEAPEST + LOADING
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
      return { ok: false, reason: 'Cheapest click throttled (cooldown)' };
    }
    state.lastCheapestClickTs = now;
    state.autoAttemptsThisState++;
    clickReal(tab);
    return { ok: true, clicked: true };
  }

  async function waitUntilReady() {
    return await waitFor(() => (!loadingIndicatorExists() && !!getCheapestTabPrice()),
      CFG.waitReadyTimeoutMs, CFG.waitReadyIntervalMs);
  }

  /********************
   * CONNECTING AIRPORTS (auto uncheck US on signature change)
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
   * AUTO NEXT DAY (click delta=1)
   ********************/
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

  async function ensureDefaultStopDateIfMissing() {
    const existing = await gmGet(CFG.prefStopDateKey, '');
    if (existing) return existing;

    const depISO = await getCurrentDepISOFromInput();
    const base = depISO || dateToISO(new Date());
    const stop = addDaysISO(base, CFG.defaultDaysForward);
    if (stop) {
      await gmSet(CFG.prefStopDateKey, stop);
      const el = document.getElementById(UI.stopDate);
      if (el) el.value = stop;
      setText(UI.stopLabel, `Stop date: ${stop} (default +${CFG.defaultDaysForward}d)`);
      return stop;
    }
    return '';
  }

  async function clickNextDayOnce(currentISO) {
    const prefNext = await gmGet(CFG.prefAutoNextDayKey, '0');
    if (prefNext !== '1') return { clicked: false, reason: 'auto-next-day disabled' };

    const stopISO = await gmGet(CFG.prefStopDateKey, '');
    if (!stopISO) return { clicked: false, reason: 'no stop date set' };

    if (!currentISO) return { clicked: false, reason: 'current departure ISO not found' };
    if (currentISO >= stopISO) return { clicked: false, reason: `reached stop date (${stopISO})` };

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

    if (!okChange) return { clicked: false, reason: 'timeout waiting for departure label to change' };
    return { clicked: true, reason: 'clicked next day' };
  }

  /********************
   * STORE + HISTORY FORMAT (MM/DD  CA$X)
   ********************/
  async function loadStore() {
    const raw = await gmGet(CFG.storeKey, '{}');
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  async function saveStore(store) {
    await gmSet(CFG.storeKey, JSON.stringify(store));
  }

  function formatMMDD(dateKey) {
    if (!dateKey) return '??/??';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      const p = dateKey.split('-');
      return `${p[1]}/${p[2]}`;
    }
    const d = new Date(dateKey);
    if (!isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${mm}/${dd}`;
    }
    return String(dateKey);
  }

  function formatHistoryCompact(sigStore) {
    const keys = Object.keys(sigStore || {}).sort().reverse();
    const lines = keys.slice(0, CFG.historyLines).map(k => `${formatMMDD(k)}  ${sigStore[k].cheapestLabel}`);
    return lines.length ? lines.join('\n') : 'History: —';
  }

  function csvEscape(s) {
    const t = String(s == null ? '' : s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }

  async function downloadCsv() {
    const store = await loadStore();
    const header = ['signature','dateKey','tripType','pax','cabin','start','end','loc','cur','pretty','cheapest','cheapestLabel','updatedAt'];
    const lines = [header.join(',')];

    const sigs = Object.keys(store).sort();
    for (const sig of sigs) {
      const byDate = store[sig] || {};
      const dateKeys = Object.keys(byDate).sort();
      for (const dk of dateKeys) {
        const r = byDate[dk];
        lines.push([
          r.signature, r.dateKey, r.tripType, r.pax, r.cabin, r.start, r.end, r.loc, r.cur,
          r.pretty, r.cheapest, r.cheapestLabel, r.updatedAt
        ].map(csvEscape).join(','));
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gf-history-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setText(UI.status, 'Status: Downloaded CSV ✓');
  }

  /********************
   * MAIN LOOP
   ********************/
  async function recordAndMaybeLoop(reason) {
    await ensureDefaultStopDateIfMissing();

    let steps = 0;
    while (true) {
      steps++;
      if (steps > CFG.maxLoopSteps) {
        setText(UI.status, `Status: Stopped (max steps ${CFG.maxLoopSteps})`);
        break;
      }

      const ctx = await computeContext();
      setText(UI.ctx, `Context: ${ctx.tripType} | pax=${ctx.pax} | cabin=${ctx.cabin} | ${ctx.pretty} | loc=${ctx.loc} | cur=${ctx.cur}`);
      setText(UI.sig, `Signature (grouped): ${ctx.signature}`);
      setText(UI.cheapest, 'Cheapest: —');

      const sel = await ensureCheapestSelectedThrottled();
      if (!sel.ok) { setText(UI.status, `Status: ${sel.reason} (${reason})`); break; }
      if (sel.clicked) { setText(UI.status, 'Status: Clicked Cheapest (waiting…)'); break; }

      setText(UI.status, `Status: Waiting for load complete… (step ${steps})`);
      const readyBefore = await waitUntilReady();
      if (!readyBefore) { setText(UI.status, `Status: Ready timeout (${reason})`); break; }

      const sigChanged = (ctx.signature !== state.lastSignatureSeen);
      if (sigChanged) state.lastSignatureSeen = ctx.signature;

      if (sigChanged) {
        const applied = await applyRemoveUSConnectionsIfNeeded(ctx.signature, 'sig-change');
        if (applied) {
          setText(UI.status, 'Status: Waiting for reload after Remove US…');
          const readyAfter = await waitUntilReady();
          if (!readyAfter) { setText(UI.status, 'Status: Reload timeout after Remove US'); break; }
        }
      }

      const best = getCheapestTabPrice();
      if (!best) { setText(UI.status, `Status: Loaded but no Cheapest price (${reason})`); break; }

      const store = await loadStore();
      if (!store[ctx.signature]) store[ctx.signature] = {};

      const existing = store[ctx.signature][ctx.dateKey];
      const rec = {
        signature: ctx.signature,
        dateKey: ctx.dateKey,
        tripType: ctx.tripType,
        pax: ctx.pax,
        cabin: ctx.cabin,
        start: ctx.start,
        end: ctx.end,
        loc: ctx.loc,
        cur: ctx.cur,
        pretty: ctx.pretty,
        cheapest: best.cash,
        cheapestLabel: best.token,
        updatedAt: new Date().toISOString()
      };

      if (!existing || rec.cheapest < existing.cheapest) {
        store[ctx.signature][ctx.dateKey] = rec;
        await saveStore(store);
        setText(UI.status, `Status: Recorded ✓ (${reason})`);
      } else {
        setText(UI.status, `Status: Seen (no improvement) (${reason})`);
      }

      setText(UI.cheapest, `Cheapest: ${best.token} (dateKey=${ctx.dateKey})`);
      setText(UI.history, formatHistoryCompact(store[ctx.signature]));

      const stopISO = await gmGet(CFG.prefStopDateKey, '');
      setText(UI.debug, `Debug: depISO=${ctx.depISO || 'NONE'} stop=${stopISO || 'NONE'} loading=${loadingIndicatorExists() ? 1 : 0}`);

      const clickRes = await clickNextDayOnce(ctx.depISO);
      if (!clickRes.clicked) {
        const prefNext = await gmGet(CFG.prefAutoNextDayKey, '0');
        if (prefNext === '1') setText(UI.status, `Status: Done ✓ (${clickRes.reason})`);
        break;
      }

      setText(UI.status, 'Status: Clicked next day → waiting…');
      await sleep(350);
      reason = 'auto-next loop';
    }
  }

  /********************
   * SCHEDULER
   ********************/
  const state = {
    running: false,
    debounceTimer: null,
    lastCheapestClickTs: 0,
    lastConnDialogTs: 0,
    lastNextDayClickTs: 0,
    lastStateKey: '',
    autoAttemptsThisState: 0,
    lastSignatureSeen: '',
    lastSignatureAppliedForUS: '',

    // NEW (A)
    paused: false
  };

  function makeStateKey(signature, dateKey) {
    return `${signature}||${dateKey}`;
  }

  async function schedule(reason) {
    if (!panelExists()) return;

    // NEW (A): stop auto scheduling when paused
    if (state.paused) return;

    const ctx = await computeContext();
    const key = makeStateKey(ctx.signature, ctx.dateKey);

    if (key !== state.lastStateKey) {
      state.lastStateKey = key;
      state.autoAttemptsThisState = 0;
      state.lastCheapestClickTs = 0;
      state.lastNextDayClickTs = 0;
    }

    if (state.autoAttemptsThisState > CFG.maxAutoAttemptsPerState) {
      setText(UI.status, 'Status: Auto paused (too many attempts). Use "Run now".');
      setText(UI.debug, `Debug: attemptsThisState=${state.autoAttemptsThisState}`);
      return;
    }

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => runOnce('auto:' + reason), CFG.debounceMs);
  }

  async function runOnce(reason) {
    if (state.running) return;

    // NEW (A): while paused, ignore auto triggers but still allow manual run
    if (state.paused && !String(reason || '').startsWith('manual')) {
      setText(UI.status, 'Status: Paused (auto-run ignored)');
      return;
    }

    state.running = true;
    try {
      await recordAndMaybeLoop(reason);
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
    observeSpa();
    startPolling();

    const store = await loadStore();
    const ctx = await computeContext();
    setText(UI.ctx, `Context: ${ctx.tripType} | pax=${ctx.pax} | cabin=${ctx.cabin} | ${ctx.pretty} | loc=${ctx.loc} | cur=${ctx.cur}`);
    setText(UI.sig, `Signature (grouped): ${ctx.signature}`);
    setText(UI.history, formatHistoryCompact(store[ctx.signature] || {}));

    // Show paused state clearly on boot
    setText(UI.status, state.paused ? 'Status: Ready (Paused)' : 'Status: Ready');

    schedule('boot');
  }

  boot().catch(err);

})();
