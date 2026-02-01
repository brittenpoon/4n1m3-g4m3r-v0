// ==UserScript==
// @name         Aeroplan Helper - Route-Aware All Cabins + Download + Auto Next Day + Minimize
// @namespace    aeroplan.helper
// @version      3.8.0
// @description  Sort Business asc, uncheck US connection airports (always closes panel; skips if none exist for route), record cheapest per cabin per date per route (persisted), download CSV, auto-click next day until stop date (wait calendar loaded). Panel supports minimize/restore with persisted state.
// @match        https://www.aircanada.com/aeroplan/redeem/availability/*
// @match        https://www.aircanada.com/aeroplan/redeem/availability/
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  /**********************
   * CONFIG
   **********************/
  const CFG = {
    // Scheduler
    pollIntervalMs: 900,
    settleMs: 1200,
    waitUiTimeoutMs: 45000,

    // Feature 1: Sort Business
    maxSortClicks: 10,
    sortClickDelayMs: 250,

    // Feature 2: Uncheck US connection airports
    usAirportCodes: new Set([
      'ATL','BOS','CLT','DEN','DFW','DTW','EWR','FLL','IAH','IAD','JFK','LAS','LAX',
      'MCO','MIA','MSP','ORD','PDX','PHL','PHX','SAN','SEA','SFO','SJC','SLC','TPA'
    ]),

    // Feature 3: Persistent store (route-aware, all cabins)
    storeKey: 'aeroplan_history_by_route_v1',

    // Feature 2 cache: route -> "no US airports present in connection list"
    noUSCacheKey: 'aeroplan_no_us_connections_by_route_v1',

    historyLines: 14,

    // Feature 4: Stop date & loop control
    stopDateKey: 'aeroplan_stop_date_iso_v1',
    autoNextDayKey: 'aeroplan_auto_next_day_enabled_v1',
    defaultDaysForward: 30,
    maxLoopSteps: 120,
    waitAfterClickMs: 600,
    waitForNewResultsTimeoutMs: 90000,

    // Calendar load wait
    calendarLoadTimeoutMs: 25000,

    // Close retries for connection airports panel
    closeRetries: 6,
    closeRetryDelayMs: 120,

    // Panel minimize persistence
    panelMinKey: 'aeroplan_panel_minimized_v1'
  };

  /**********************
   * Helpers
   **********************/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qs  = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Safe click helper (no `view`)
  function click(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) {
      console.warn('[Aeroplan Helper] click failed:', e);
      return false;
    }
  }

  function waitFor(predicate, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        let ok = false;
        try { ok = !!predicate(); } catch {}
        if (ok) { clearInterval(timer); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
      }, intervalMs);
    });
  }

  async function gmGet(key, fallback) {
    try { return await Promise.resolve(GM_getValue(key, fallback)); }
    catch { return fallback; }
  }
  async function gmSet(key, value) {
    try { return await Promise.resolve(GM_setValue(key, value)); }
    catch {}
  }

  function parseIata(text) {
    const m = (text || '').match(/\(([A-Z0-9]{3})\)/);
    return m ? m[1] : null;
  }

  function getUrlParam(name) {
    try {
      const u = new URL(location.href);
      return u.searchParams.get(name) || '';
    } catch { return ''; }
  }

  /**********************
   * UI Panel + Minimize
   **********************/
  function setStatus(msg) { const el = qs('#tm-ac-status'); if (el) el.textContent = msg; }
  function setDebug(msg)  { const el = qs('#tm-ac-debug'); if (el) el.textContent = msg; }
  function setRouteLabel(msg) { const el = qs('#tm-ac-route'); if (el) el.textContent = msg; }
  function setCheapest(msg){ const el = qs('#tm-ac-cheapest'); if (el) el.textContent = msg; }
  function setHistory(text){ const el = qs('#tm-ac-history'); if (el) el.textContent = text; }
  function setStopLabel(text){ const el = qs('#tm-ac-stoplabel'); if (el) el.textContent = String(text ?? ''); }

  async function setMinimized(min) {
    state.panelMinimized = !!min;
    applyMinimizedState();
    await gmSet(CFG.panelMinKey, state.panelMinimized ? '1' : '0');
  }

  function applyMinimizedState() {
    const panel = qs('#tm-ac-panel');
    const body = qs('#tm-ac-body');
    const minBtn = qs('#tm-ac-min');

    if (!panel || !body || !minBtn) return;

    if (state.panelMinimized) {
      panel.classList.add('tm-min');
      body.style.display = 'none';
      minBtn.textContent = '☰';
      minBtn.setAttribute('aria-label', 'Restore Aeroplan Helper');
      // Click anywhere on minimized panel to restore
      panel.setAttribute('title', 'Click to restore');
    } else {
      panel.classList.remove('tm-min');
      body.style.display = '';
      minBtn.textContent = '—';
      minBtn.setAttribute('aria-label', 'Minimize Aeroplan Helper');
      panel.removeAttribute('title');
    }
  }

  function mountPanel() {
    const panel = document.createElement('div');
    panel.id = 'tm-ac-panel';

    panel.innerHTML = `
      <div class="tm-header">
        <div class="tm-title">Aeroplan Helper</div>
        <button id="tm-ac-min" class="tm-minbtn" type="button" aria-label="Minimize Aeroplan Helper">—</button>
      </div>

      <div id="tm-ac-body">
        <div class="tm-row">
          <button id="tm-ac-run">Run now</button>
          <button id="tm-ac-dl">Download CSV</button>
        </div>

        <div class="tm-row">
          <label class="tm-toggle"><input id="tm-ac-auto" type="checkbox" checked> Auto</label>
          <label class="tm-toggle"><input id="tm-ac-next" type="checkbox"> Auto-next-day</label>
        </div>

        <div class="tm-row">
          <label class="tm-label">Stop date:</label>
          <input id="tm-ac-stop" class="tm-date" type="date" />
        </div>

        <div class="tm-row"><small id="tm-ac-route">Route: —</small></div>
        <div class="tm-row"><small id="tm-ac-stoplabel">Stop date: —</small></div>
        <div class="tm-row"><small id="tm-ac-status">Idle</small></div>
        <div class="tm-row"><small id="tm-ac-debug">Debug: —</small></div>
        <div class="tm-row"><small id="tm-ac-cheapest">Cheapest (all cabins): —</small></div>
        <pre id="tm-ac-history" class="tm-history">History: —</pre>
      </div>
    `;

    document.documentElement.appendChild(panel);

    // Minimize/restore
    qs('#tm-ac-min')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await setMinimized(!state.panelMinimized);
    });

    // Click minimized square to restore
    panel.addEventListener('click', async () => {
      if (state.panelMinimized) await setMinimized(false);
    });

    // Buttons
    qs('#tm-ac-run')?.addEventListener('click', () => runAll('manual', { force: true, allowLoop: true }));
    qs('#tm-ac-dl')?.addEventListener('click', () => downloadCsv().catch(console.error));

    // Toggles
    qs('#tm-ac-auto')?.addEventListener('change', (e) => {
      state.auto = !!e.target.checked;
      setStatus(state.auto ? 'Auto enabled' : 'Auto disabled');
      if (state.auto) checkAndSchedule('auto enabled');
    });

    qs('#tm-ac-next')?.addEventListener('change', async (e) => {
      state.autoNextDay = !!e.target.checked;
      await gmSet(CFG.autoNextDayKey, state.autoNextDay ? '1' : '0');
      setStatus(state.autoNextDay ? 'Auto-next-day enabled' : 'Auto-next-day disabled');
    });

    qs('#tm-ac-stop')?.addEventListener('change', async (e) => {
      const iso = e.target.value || '';
      state.stopDateISO = iso;
      await gmSet(CFG.stopDateKey, iso);
      setStopLabel(`Stop date: ${iso || '—'}`);
    });

    GM_addStyle(`
      #tm-ac-panel{
        position: fixed; right: 14px; bottom: 14px;
        width: 460px; z-index: 2147483647;
        background: rgba(20,20,22,.92);
        color: #fff; border: 1px solid rgba(255,255,255,.15);
        border-radius: 12px; padding: 10px 12px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        box-shadow: 0 12px 30px rgba(0,0,0,.35);
      }

      #tm-ac-panel .tm-header{
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; margin-bottom: 8px;
      }
      #tm-ac-panel .tm-title{ font-weight: 700; }
      #tm-ac-panel .tm-minbtn{
        width: 34px; height: 30px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.2);
        background: rgba(255,255,255,.10);
        color: #fff; cursor: pointer;
        display: grid; place-items: center;
        font-size: 16px; line-height: 1;
      }
      #tm-ac-panel .tm-minbtn:hover{ background: rgba(255,255,255,.18); }

      #tm-ac-panel .tm-row{ display: flex; gap: 10px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      #tm-ac-panel button{
        flex: 1; cursor: pointer;
        border: 1px solid rgba(255,255,255,.2);
        background: rgba(255,255,255,.10);
        color: #fff; padding: 8px 10px; border-radius: 10px;
        min-width: 140px;
      }
      #tm-ac-panel button:hover{ background: rgba(255,255,255,.18); }

      #tm-ac-panel .tm-toggle{ display:flex; gap:6px; align-items:center; user-select:none; font-size: 12px; white-space:nowrap; }
      #tm-ac-panel .tm-label{ font-size: 12px; opacity: .9; }
      #tm-ac-panel .tm-date{
        background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.18);
        color: #fff;
        padding: 6px 8px;
        border-radius: 10px;
        font-size: 12px;
      }
      #tm-ac-panel small{ opacity: .92; display:block; }
      #tm-ac-panel .tm-history{
        margin: 0; padding: 8px; border-radius: 10px;
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.10);
        max-height: 260px; overflow: auto;
        white-space: pre-wrap; font-size: 12px; line-height: 1.25;
      }

      /* Minimized mode: small square with ☰ */
      #tm-ac-panel.tm-min{
        width: 48px !important;
        height: 48px !important;
        padding: 6px !important;
        border-radius: 12px !important;
        cursor: pointer;
      }
      #tm-ac-panel.tm-min .tm-header{
        margin-bottom: 0 !important;
        justify-content: center;
      }
      #tm-ac-panel.tm-min .tm-title{
        display: none;
      }
      #tm-ac-panel.tm-min .tm-minbtn{
        width: 36px; height: 36px;
        border-radius: 12px;
        font-size: 18px;
      }
    `);
  }

  function syncControlsFromUI() {
    const nextCb = qs('#tm-ac-next');
    if (nextCb) state.autoNextDay = !!nextCb.checked;

    const stopInput = qs('#tm-ac-stop');
    if (stopInput && stopInput.value) state.stopDateISO = stopInput.value;
  }

  /**********************
   * Route + header date + results (signature)
   **********************/
  const MONTH_RE = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i;

  function getRouteKey() {
    const routeNode = qs('.route-subheading[aria-hidden="true"]') || qs('.route-subheading');
    if (routeNode) {
      const strongs = Array.from(routeNode.querySelectorAll('strong')).map(s => (s.textContent || '').trim());
      if (strongs.length >= 2) {
        const o = parseIata(strongs[0]);
        const d = parseIata(strongs[1]);
        if (o && d) return `${o}-${d}`;
      }
      const t = routeNode.textContent || '';
      const codes = Array.from(t.matchAll(/\(([A-Z0-9]{3})\)/g)).map(m => m[1]);
      if (codes.length >= 2) return `${codes[0]}-${codes[1]}`;
    }
    const org = (getUrlParam('org0') || '').toUpperCase();
    const dest = (getUrlParam('dest0') || '').toUpperCase();
    if (org && dest) return `${org}-${dest}`;
    return 'UNKNOWN-ROUTE';
  }

  function getHeaderDateText() {
    const candidates = qsa('kilo-date span, kilo-date')
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => MONTH_RE.test(t));
    candidates.sort((a,b) => b.length - a.length);
    return candidates[0] || '';
  }

  function getFlightResultsText() {
    const c = qs('div.flights-count-container');
    if (c) return c.textContent.replace(/\s+/g, ' ').trim();
    const label = qsa('span').find(s => (s.textContent || '').trim() === 'Flight results:');
    if (label?.parentElement) return label.parentElement.textContent.replace(/\s+/g, ' ').trim();
    const any = qsa('div,span').find(n => (n.textContent || '').includes('Flight results:'));
    return any ? any.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function isResultsReady() {
    return getFlightResultsText().includes('Flight results:');
  }

  function computeSignature() {
    const route = getRouteKey();
    const d = getHeaderDateText() || 'NO_DATE';
    const r = getFlightResultsText() || 'NO_RESULTS';
    return `${route} || ${d} || ${r}`;
  }

  function refreshDebug() {
    const route = getRouteKey();
    setRouteLabel(`Route: ${route}`);
    const d = getHeaderDateText();
    const r = getFlightResultsText();
    const sig = computeSignature();
    setDebug(`Debug: route=${route} | date=${d ? 'yes' : 'no'} | results=${r ? 'yes' : 'no'} | sig=${sig.slice(0, 120)}…`);
  }

  /**********************
   * Points/Cash parsing and comparing
   **********************/
  function parsePointsToMiles(pointsLabel) {
    if (!pointsLabel) return null;
    const t = pointsLabel.trim().toUpperCase().replace(/,/g, '');
    const m = t.match(/^([\d.]+)\s*([KM])?$/);
    if (!m) return null;
    let val = parseFloat(m[1]);
    if (Number.isNaN(val)) return null;
    if (m[2] === 'K') val *= 1000;
    if (m[2] === 'M') val *= 1000000;
    return Math.round(val);
  }

  function parseCashToNumber(cashLabel) {
    if (!cashLabel) return null;
    const m = cashLabel.replace(/,/g, '').match(/([\d.]+)/);
    return m ? Math.round(parseFloat(m[1]) * 100) / 100 : null;
  }

  function betterOffer(a, b) {
    if (!b) return false;
    if (!a) return true;
    const aPts = (a.miles ?? Number.POSITIVE_INFINITY);
    const bPts = (b.miles ?? Number.POSITIVE_INFINITY);
    if (bPts < aPts) return true;
    if (bPts > aPts) return false;
    const aCash = (a.cash ?? Number.POSITIVE_INFINITY);
    const bCash = (b.cash ?? Number.POSITIVE_INFINITY);
    return bCash < aCash;
  }

  /**********************
   * Feature 1: Sort Business asc
   **********************/
  function findBusinessSortButton() {
    const candidates = qsa('div[role="button"].cabins.business, div[role="button"][aa-button].cabins.business');
    for (const el of candidates) {
      const heading = el.querySelector('.cabin-heading');
      if ((heading?.textContent || '').trim().toLowerCase() === 'business class') return el;
    }
    for (const el of qsa('div[role="button"]')) {
      const heading = el.querySelector('.cabin-heading');
      if ((heading?.textContent || '').trim().toLowerCase() === 'business class') return el;
    }
    return null;
  }

  function isBusinessSortedAscending(btn) {
    const live = btn?.querySelector('[aria-live="assertive"].cdk-visually-hidden, [aria-live="assertive"]');
    const text = (live?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text.includes('sorted ascending');
  }

  async function enforceBusinessAscending() {
    setStatus('Business sort: locating…');
    const ok = await waitFor(() => {
      const btn = findBusinessSortButton();
      return btn && visible(btn);
    }, { timeoutMs: CFG.waitUiTimeoutMs, intervalMs: 300 });

    if (!ok) { setStatus('Business sort: button not found (timed out).'); return; }

    let btn = findBusinessSortButton();
    if (isBusinessSortedAscending(btn)) { setStatus('Business sort: already ascending ✓'); return; }

    setStatus('Business sort: setting ascending…');
    for (let i = 0; i < CFG.maxSortClicks; i++) {
      click(btn);
      await sleep(CFG.sortClickDelayMs);
      btn = findBusinessSortButton() || btn;
      if (isBusinessSortedAscending(btn)) { setStatus(`Business sort: ascending ✓ (clicks: ${i + 1})`); return; }
    }
    setStatus(`Business sort: gave up after ${CFG.maxSortClicks} clicks.`);
  }

  /**********************
   * Feature 2: Connection airports (always close; cache no-US)
   **********************/
  async function loadNoUSCache() {
    const raw = await gmGet(CFG.noUSCacheKey, '{}');
    try { return JSON.parse(raw); } catch { return {}; }
  }
  async function saveNoUSCache(cache) {
    await gmSet(CFG.noUSCacheKey, JSON.stringify(cache));
  }

  function findConnectionFilterButton() {
    return qs('button.filter-button[data-analytics-val*="connecting airports"]')
      || qs('button.filter-button[aria-label*="Connection airports"]')
      || qs('button.filter-button[aria-label^="Exclude:"]')
      || null;
  }

  function findConnectionContainer() {
    return qs('.cdk-overlay-container div.connection-container.filter-content')
      || qs('.cdk-overlay-container div.connection-container')
      || qs('div.connection-container.filter-content')
      || qs('div.connection-container')
      || null;
  }

  async function openConnectionFilter() {
    const btn = findConnectionFilterButton();
    if (!btn) { setStatus('Remove US: Connection airports button not found.'); return false; }

    const existing = findConnectionContainer();
    if (existing && visible(existing)) return true;

    setStatus('Remove US: opening Connection airports…');
    for (let i = 0; i < 10; i++) {
      click(btn);
      await sleep(200);
      const container = findConnectionContainer();
      if (container && visible(container)) return true;
    }
    setStatus('Remove US: failed to open Connection airports panel.');
    return false;
  }

  async function closeConnectionFilterForce() {
    for (let i = 0; i < CFG.closeRetries; i++) {
      const container = findConnectionContainer();
      if (!container || !visible(container)) return true;

      const closeBtn =
        container.querySelector('[role="button"].close-icon-container[aria-label="Close"]')
        || container.querySelector('.close-icon-container[role="button"]');

      if (closeBtn) click(closeBtn);
      await sleep(CFG.closeRetryDelayMs);
    }

    // Fallback: ESC
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(120);
    } catch {}

    const still = findConnectionContainer();
    return !(still && visible(still));
  }

  function isCheckboxCheckedFast(matCheckboxEl) {
    if (!matCheckboxEl) return false;
    if (matCheckboxEl.classList.contains('mat-mdc-checkbox-checked')) return true;
    const aria = matCheckboxEl.getAttribute('aria-checked');
    if (aria === 'true') return true;
    const input = matCheckboxEl.querySelector('input[type="checkbox"]');
    if (!input) return false;
    if (input.checked) return true;
    if (input.classList.contains('mdc-checkbox--selected')) return true;
    return false;
  }

  function uncheckMatCheckbox(matCheckboxEl) {
    const touch = matCheckboxEl.querySelector('.mat-mdc-checkbox-touch-target');
    if (touch) return click(touch);
    const label = matCheckboxEl.querySelector('label.mdc-label');
    if (label) return click(label);
    const input = matCheckboxEl.querySelector('input[type="checkbox"]');
    if (input) return click(input);
    return click(matCheckboxEl);
  }

  async function deselectUSConnectionAirports() {
    const route = getRouteKey();
    const cache = await loadNoUSCache();

    if (cache?.[route] === true) {
      setStatus('Remove US: skipped (no US airports for this route)');
      return;
    }

    const opened = await openConnectionFilter();
    if (!opened) return;

    try {
      const ok = await waitFor(() => {
        const c = findConnectionContainer();
        return c && c.getBoundingClientRect().width > 0;
      }, { timeoutMs: 15000, intervalMs: 250 });

      if (!ok) {
        setStatus('Remove US: list not visible (skipping)');
        return;
      }

      const container = findConnectionContainer();
      const boxes = Array.from(container.querySelectorAll('mat-checkbox'));
      let usPresent = 0;
      let unchecked = 0;

      for (const box of boxes) {
        const label = box.querySelector('label.mdc-label');
        const labelText = (label?.textContent || '').trim();
        const code = parseIata(labelText);
        if (!code) continue;

        if (CFG.usAirportCodes.has(code)) {
          usPresent++;
          if (isCheckboxCheckedFast(box)) {
            uncheckMatCheckbox(box);
            unchecked++;
            await sleep(20);
          }
        }
      }

      if (usPresent === 0) {
        cache[route] = true;
        await saveNoUSCache(cache);
        setStatus('Remove US: no US airports in list → cached');
      } else {
        setStatus(`Remove US: done ✓ (US in list: ${usPresent}, unchecked: ${unchecked})`);
      }
    } finally {
      await closeConnectionFilterForce(); // ✅ always closes
    }
  }

  /**********************
   * Feature 3: Record cheapest per cabin per date per route (scan all flights)
   **********************/
  async function loadStore() {
    const raw = await gmGet(CFG.storeKey, '{}');
    try { return JSON.parse(raw); } catch { return {}; }
  }
  async function saveStore(store) {
    await gmSet(CFG.storeKey, JSON.stringify(store));
  }

  function monthToNumber(mon) {
    const map = {
      january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
      july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
    };
    return map[mon.toLowerCase()] || null;
  }

  function parseHeaderDateToISO(dateText) {
    const m = (dateText || '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i);
    if (!m) return null;
    const mm = monthToNumber(m[1]);
    const dd = String(m[2]).padStart(2, '0');
    const yyyy = m[3];
    if (!mm) return null;
    return { iso: `${yyyy}-${mm}-${dd}`, mmdd: `${mm}/${dd}` };
  }

  function extractCabinOfferFromCell(cell) {
    const pointsEl = cell.querySelector('.points-total');
    const pointsLabel = (pointsEl?.textContent || '').trim();
    if (!pointsLabel) return null;

    const cashEl = cell.querySelector('kilo-price span') || cell.querySelector('kilo-price');
    const cashLabel = (cashEl?.textContent || '').replace(/\s+/g, ' ').trim();

    return {
      miles: parsePointsToMiles(pointsLabel),
      cash: parseCashToNumber(cashLabel)
    };
  }

  function findCabinCell(row, cabinSlug) {
    return row.querySelector(`kilo-cabin-cell-pres[data-analytics-val*="${cabinSlug}"]`)
      || row.querySelector(`[data-analytics-val*="${cabinSlug}"]`);
  }

  function scanCheapestByCabin() {
    const rows = qsa('kilo-upsell-row-cont');
    const best = { eco: null, pe: null, biz: null, first: null };

    for (const row of rows) {
      const ecoCell = findCabinCell(row, 'economy class');
      if (ecoCell) {
        const off = extractCabinOfferFromCell(ecoCell);
        if (betterOffer(best.eco, off)) best.eco = off;
      }
      const peCell = findCabinCell(row, 'premium economy');
      if (peCell) {
        const off = extractCabinOfferFromCell(peCell);
        if (betterOffer(best.pe, off)) best.pe = off;
      }
      const bizCell = findCabinCell(row, 'business class');
      if (bizCell) {
        const off = extractCabinOfferFromCell(bizCell);
        if (betterOffer(best.biz, off)) best.biz = off;
      }
      const firstCell = findCabinCell(row, 'first class');
      if (firstCell) {
        const off = extractCabinOfferFromCell(firstCell);
        if (betterOffer(best.first, off)) best.first = off;
      }
    }

    return best;
  }

  function formatOfferShort(o) {
    if (!o || !o.miles) return '—';
    const cash = (o.cash != null) ? ` + CA$${o.cash}` : '';
    return `${o.miles}${cash}`;
  }

  function formatHistoryForRoute(routeStore) {
    const keys = Object.keys(routeStore || {}).sort().reverse();
    const lines = keys.slice(0, CFG.historyLines).map(dateISO => {
      const rec = routeStore[dateISO];
      return `${rec.mmdd}  eco:${formatOfferShort(rec.eco)}  pe:${formatOfferShort(rec.pe)}  biz:${formatOfferShort(rec.biz)}  first:${formatOfferShort(rec.first)}`;
    });
    return lines.length ? `History (latest ${lines.length}):\n` + lines.join('\n') : 'History: —';
  }

  async function recordAllCabinsForDate() {
    const route = getRouteKey();
    const parsed = parseHeaderDateToISO(getHeaderDateText());
    if (!parsed) {
      setCheapest('Cheapest (all cabins): (date parse failed)');
      return { routeKey: route, dateISO: null };
    }

    await sleep(300);

    const best = scanCheapestByCabin();

    const store = await loadStore();
    if (!store[route]) store[route] = {};
    const routeStore = store[route];
    const existing = routeStore[parsed.iso];

    const candidate = {
      route,
      iso: parsed.iso,
      mmdd: parsed.mmdd,
      eco: best.eco,
      pe: best.pe,
      biz: best.biz,
      first: best.first,
      updatedAt: new Date().toISOString()
    };

    const merged = existing ? { ...existing } : { ...candidate };
    if (existing) {
      merged.route = route;
      merged.iso = parsed.iso;
      merged.mmdd = parsed.mmdd;
      merged.updatedAt = candidate.updatedAt;

      if (betterOffer(existing.eco, candidate.eco)) merged.eco = candidate.eco;
      if (betterOffer(existing.pe, candidate.pe)) merged.pe = candidate.pe;
      if (betterOffer(existing.biz, candidate.biz)) merged.biz = candidate.biz;
      if (betterOffer(existing.first, candidate.first)) merged.first = candidate.first;
    }

    routeStore[parsed.iso] = merged;
    store[route] = routeStore;
    await saveStore(store);

    setCheapest(`Cheapest (all cabins) ${merged.mmdd} | eco:${formatOfferShort(merged.eco)} | pe:${formatOfferShort(merged.pe)} | biz:${formatOfferShort(merged.biz)} | first:${formatOfferShort(merged.first)}`);
    setHistory(formatHistoryForRoute(store[route]));

    return { routeKey: route, dateISO: parsed.iso };
  }

  /**********************
   * Download CSV (all routes)
   **********************/
  function csvEscape(s) {
    const t = String(s ?? '');
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  }

  async function downloadCsv() {
    const store = await loadStore();
    const header = ['route','date','eco_miles','eco_cash','pe_miles','pe_cash','biz_miles','biz_cash','first_miles','first_cash'];
    const lines = [header.join(',')];

    const routes = Object.keys(store).sort();
    for (const route of routes) {
      const routeStore = store[route] || {};
      const dates = Object.keys(routeStore).sort();
      for (const dateISO of dates) {
        const rec = routeStore[dateISO];
        const row = [
          route, dateISO,
          rec?.eco?.miles ?? '', rec?.eco?.cash ?? '',
          rec?.pe?.miles ?? '',  rec?.pe?.cash ?? '',
          rec?.biz?.miles ?? '', rec?.biz?.cash ?? '',
          rec?.first?.miles ?? '', rec?.first?.cash ?? ''
        ].map(csvEscape);
        lines.push(row.join(','));
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aeroplan-history-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Downloaded CSV ✓');
  }

  /**********************
   * Feature 4: Auto-next-day (calendar loaded wait)
   **********************/
  function findCalendarContainer() {
    return qs('div.calendar-container') || null;
  }

  function calendarHasLoadedPrices(container) {
    if (!container) return false;
    if (container.querySelector('div.calendar-item.loading')) return false;
    const p = container.querySelector('div.calendar-item .price .points');
    return !!p && (p.textContent || '').trim().length > 0;
  }

  async function waitForCalendarLoaded(container) {
    return await waitFor(() => calendarHasLoadedPrices(container), {
      timeoutMs: CFG.calendarLoadTimeoutMs,
      intervalMs: 250
    });
  }

  function findCalendarRightNav(container) {
    const btn = container?.querySelector('button.navigation-button[data-analytics-val*="low fare calendar"][data-analytics-val$="right"]')
      || container?.querySelector('button.navigation-button[aria-label*="following week"]')
      || null;
    if (!btn) return null;
    if (btn.disabled) return null;
    if (btn.classList.contains('disabled-navigation-button')) return null;
    return btn;
  }

  function isoToDate(iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function dateToISO(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function addDaysISO(iso, days) {
    const d = isoToDate(iso);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return dateToISO(d);
  }

  function findCalendarDayTileByISO(container, iso) {
    const d = isoToDate(iso);
    if (!d) return null;
    const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
    const month = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getMonth()];
    const ariaFrag = `${weekday}, ${month} ${d.getDate()}`;

    const tiles = Array.from(container.querySelectorAll('div.calendar-item[role="button"], div.calendar-item'));
    for (const t of tiles) {
      const aria = (t.getAttribute('aria-label') || '').trim();
      if (aria && aria.includes(ariaFrag)) return t;
    }
    return null;
  }

  async function clickNextDayOnce(currentISO) {
    if (!state.autoNextDay) return { clicked: false, reason: 'auto-next-day disabled' };
    if (!state.stopDateISO) return { clicked: false, reason: 'no stop date set' };
    if (!currentISO) return { clicked: false, reason: 'no current date ISO' };
    if (currentISO >= state.stopDateISO) return { clicked: false, reason: `reached stop date (${state.stopDateISO})` };

    const nextISO = addDaysISO(currentISO, 1);
    if (!nextISO) return { clicked: false, reason: 'failed to compute next date' };

    const cal = findCalendarContainer();
    if (!cal) return { clicked: false, reason: 'calendar not found' };

    setStatus('Auto-next-day: waiting calendar fully loaded…');
    const ready = await waitForCalendarLoaded(cal);
    if (!ready) return { clicked: false, reason: 'calendar not loaded (prices not ready)', nextISO };

    let tile = findCalendarDayTileByISO(cal, nextISO);
    if (tile) {
      setStatus(`Auto-next-day: clicking ${nextISO}…`);
      click(tile);
      return { clicked: true, reason: 'clicked next day tile', nextISO };
    }

    const right = findCalendarRightNav(cal);
    if (!right) return { clicked: false, reason: 'next day not visible and right nav disabled', nextISO };

    setStatus('Auto-next-day: paging week right…');
    click(right);

    setStatus('Auto-next-day: waiting calendar after week nav…');
    const ready2 = await waitForCalendarLoaded(cal);
    if (!ready2) return { clicked: false, reason: 'calendar not loaded after week nav', nextISO };

    tile = findCalendarDayTileByISO(cal, nextISO);
    if (!tile) return { clicked: false, reason: 'next day tile not found after week nav', nextISO };

    setStatus(`Auto-next-day: clicking ${nextISO}…`);
    click(tile);
    return { clicked: true, reason: 'paged + clicked next day tile', nextISO };
  }

  async function waitForNextDayResults(prevSig, expectedNextISO) {
    return await waitFor(() => {
      const sig = computeSignature();
      if (sig && sig !== prevSig && isResultsReady()) return true;

      const parsed = parseHeaderDateToISO(getHeaderDateText());
      if (parsed?.iso && expectedNextISO && parsed.iso === expectedNextISO && isResultsReady()) return true;

      return false;
    }, { timeoutMs: CFG.waitForNewResultsTimeoutMs, intervalMs: 500 });
  }

  /**********************
   * Persisted controls init
   **********************/
  async function initPersistedControlsBoot() {
    const stopISO = await gmGet(CFG.stopDateKey, '');
    const autoNext = await gmGet(CFG.autoNextDayKey, '0');

    state.stopDateISO = stopISO || '';
    state.autoNextDay = (autoNext === '1');

    const stopInput = qs('#tm-ac-stop');
    if (stopInput && state.stopDateISO) stopInput.value = state.stopDateISO;

    const nextCb = qs('#tm-ac-next');
    if (nextCb) nextCb.checked = state.autoNextDay;

    setStopLabel(`Stop date: ${state.stopDateISO || '—'}`);
  }

  async function ensureDefaultStopDateIfMissing() {
    if (state.stopDateISO) return;
    const parsed = parseHeaderDateToISO(getHeaderDateText());
    const baseISO = parsed?.iso || dateToISO(new Date());
    const stopISO = addDaysISO(baseISO, CFG.defaultDaysForward);
    if (!stopISO) return;

    state.stopDateISO = stopISO;
    await gmSet(CFG.stopDateKey, stopISO);

    const stopInput = qs('#tm-ac-stop');
    if (stopInput) stopInput.value = stopISO;

    setStopLabel(`Stop date: ${stopISO} (default +${CFG.defaultDaysForward}d)`);
  }

  /**********************
   * State + Scheduler
   **********************/
  const state = {
    auto: true,
    autoNextDay: false,
    stopDateISO: '',
    running: false,
    lastProcessedSignature: '',
    pendingTimer: null,
    pendingSig: '',
    panelMinimized: false
  };

  function checkAndSchedule(reason) {
    refreshDebug();

    if (!state.auto) return;
    if (!isResultsReady()) return;

    const sig = computeSignature();
    if (!sig) return;

    if (sig === state.lastProcessedSignature) return;
    if (sig === state.pendingSig) return;
    if (state.running) return;

    state.pendingSig = sig;
    setStatus(`Scheduled (${reason})`);

    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(() => {
      state.pendingSig = '';
      runAll(`auto ${reason}`, { force: false, allowLoop: false });
    }, CFG.settleMs);
  }

  async function runAll(reason, { force = false, allowLoop = true } = {}) {
    if (state.running) return;
    if (!force && !state.auto) return;
    if (!isResultsReady()) return;

    state.running = true;
    try {
      syncControlsFromUI();
      await ensureDefaultStopDateIfMissing();

      let steps = 0;
      while (true) {
        steps++;
        if (steps > CFG.maxLoopSteps) { setStatus(`Stopped (max steps ${CFG.maxLoopSteps})`); break; }

        const sigBefore = computeSignature();
        if (!force && sigBefore === state.lastProcessedSignature) { setStatus('Already processed this state ✓'); break; }

        setStatus(`Run: ${reason} (step ${steps})`);

        await enforceBusinessAscending();
        await deselectUSConnectionAirports();
        const { dateISO } = await recordAllCabinsForDate();

        state.lastProcessedSignature = computeSignature();

        if (!allowLoop || !state.autoNextDay) {
          setStatus(!state.autoNextDay ? 'Done ✓ (auto-next-day off)' : 'Done ✓');
          break;
        }

        const currentISO = dateISO || parseHeaderDateToISO(getHeaderDateText())?.iso || null;
        const clickRes = await clickNextDayOnce(currentISO);
        if (!clickRes.clicked) { setStatus(`Done ✓ (${clickRes.reason})`); break; }

        setStatus(`Clicked next day (${clickRes.nextISO}) → waiting for results…`);
        await sleep(CFG.waitAfterClickMs);

        const ok = await waitForNextDayResults(sigBefore, clickRes.nextISO);
        refreshDebug();
        if (!ok) { setStatus(`Stopped (timeout waiting for ${clickRes.nextISO})`); break; }

        force = false;
        reason = 'auto-next loop';

        syncControlsFromUI();
        if (!state.autoNextDay) { setStatus('Stopped (auto-next-day turned off)'); break; }
        if (!state.auto) { setStatus('Stopped (Auto disabled)'); break; }
      }
    } catch (e) {
      console.error('[Aeroplan Helper] runAll ERROR', e);
      setStatus('Error — check console.');
    } finally {
      state.running = false;
    }
  }

  /**********************
   * Observers + Polling
   **********************/
  function observeSpa() {
    const root = qs('main') || document.body;
    const mo = new MutationObserver(() => checkAndSchedule('mutation'));
    mo.observe(root, { childList: true, subtree: true });
  }

  function startPolling() {
    setInterval(() => checkAndSchedule('poll'), CFG.pollIntervalMs);
  }

  /**********************
   * Boot
   **********************/
  async function boot() {
    mountPanel();
    observeSpa();
    startPolling();

    // Load minimized state
    const min = await gmGet(CFG.panelMinKey, '0');
    state.panelMinimized = (min === '1');
    applyMinimizedState();

    // Load persisted toggle/stop
    await initPersistedControlsBoot();

    setStatus('Waiting for date/results change…');

    // show current route history
    const store = await loadStore();
    const route = getRouteKey();
    setHistory(formatHistoryForRoute(store[route] || {}));

    checkAndSchedule('boot');
  }

  boot();

})();
