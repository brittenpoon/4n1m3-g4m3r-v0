// ==UserScript==
// @name         AC Booking Helper - Sort Lowest Price + Remove US + Cheapest (E/PE/BIZ) + Auto Next Day + CSV + Minimize
// @namespace    ac.booking.Helper
// @version      1.4.0
// @description  Booking helper: Sort by Lowest price, uncheck US connecting airports, track lowest per cabin (Economy/Premium Economy/Business) per date, per route history, CSV (amount-only columns), auto-next-day via calendar tabs, and a persisted minimize/restore panel.
// @match        https://www.aircanada.com/booking/*/*/aco/availability/*
// @match        https://www.aircanada.com/booking/*/*/aco/availability/*/*
// @match        https://www.aircanada.com/booking/*/*/aco/availability/*/*/*
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
    pollIntervalMs: 900,
    settleMs: 1200,

    usAirportCodes: new Set([
      'ATL','BOS','CLT','DEN','DFW','DTW','EWR','FLL','IAH','IAD','JFK','LAS','LAX',
      'MCO','MIA','MSP','ORD','PDX','PHL','PHX','SAN','SEA','SFO','SJC','SLC','TPA'
    ]),

    // Route-aware store format:
    // {
    //   "YYZ-HKG": {
    //     "2026-05-23": { iso, mmdd, E:{amount,currency,label}, PE:{...}, BIZ:{...}, updatedAt }
    //   }
    // }
    cheapestStoreKey: 'ac_booking_cheapest_by_date_v3_route',
    historyLines: 14,

    // Persisted UI state
    stopDateKey: 'ac_booking_stop_date_iso_v1',
    autoNextDayKey: 'ac_booking_auto_next_day_enabled_v1',
    panelMinKey: 'ac_booking_panel_minimized_v1',

    defaultDaysForward: 30,
    maxLoopSteps: 120,

    waitAfterClickMs: 600,
    waitForNewResultsTimeoutMs: 90000
  };

  /**********************
   * Helpers
   **********************/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qs  = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const normText = (t) => (t || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function click(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) {
      console.warn('[AC Booking Helper] click failed:', e);
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

  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function formatTodayISO() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function downloadTextFile(filename, content, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**********************
   * UI Panel (with minimize)
   **********************/
  function setStatus(msg) { const el = qs('#tm-ac-status'); if (el) el.textContent = msg; }
  function setDebug(msg)  { const el = qs('#tm-ac-debug'); if (el) el.textContent = msg; }
  function setCheapest(msg){ const el = qs('#tm-ac-cheapest'); if (el) el.textContent = msg; }
  function setHistory(text){ const el = qs('#tm-ac-history'); if (el) el.textContent = text; }
  function setStopLabel(text){ const el = qs('#tm-ac-stoplabel'); if (el) el.textContent = text; }

  async function applyMinimizeState() {
    const p = qs('#tm-ac-panel');
    if (!p) return;
    const saved = await gmGet(CFG.panelMinKey, '0');
    const minimized = saved === '1';
    p.classList.toggle('minimized', minimized);
  }

  async function toggleMinimize() {
    const p = qs('#tm-ac-panel');
    if (!p) return;
    const minimized = !p.classList.contains('minimized');
    p.classList.toggle('minimized', minimized);
    await gmSet(CFG.panelMinKey, minimized ? '1' : '0');
  }

  function mountPanel() {
    const panel = document.createElement('div');
    panel.id = 'tm-ac-panel';

    panel.innerHTML = `
      <div class="tm-min-btn" id="tm-ac-min" title="Minimize">—</div>

      <div class="tm-content">
        <div class="tm-title">AC Booking Helper</div>

        <div class="tm-row">
          <button id="tm-ac-run">Run now</button>
          <button id="tm-ac-csv">Download CSV</button>
        </div>

        <div class="tm-row">
          <label class="tm-toggle"><input id="tm-ac-auto" type="checkbox" checked> Auto</label>
          <label class="tm-toggle"><input id="tm-ac-next" type="checkbox"> Auto-next-day</label>
        </div>

        <div class="tm-row">
          <label class="tm-label">Stop date:</label>
          <input id="tm-ac-stop" class="tm-date" type="date" />
        </div>
        <div class="tm-row">
          <small id="tm-ac-stoplabel">Stop date: —</small>
        </div>

        <div class="tm-row"><small id="tm-ac-status">Idle</small></div>
        <div class="tm-row"><small id="tm-ac-debug">Debug: —</small></div>
        <div class="tm-row"><small id="tm-ac-cheapest">Cheapest: —</small></div>
        <pre id="tm-ac-history" class="tm-history">History: —</pre>
      </div>
    `;

    document.documentElement.appendChild(panel);

    // Button wiring
    qs('#tm-ac-run')?.addEventListener('click', () => runAll('manual', { force: true, allowLoop: true }));
    qs('#tm-ac-csv')?.addEventListener('click', () => downloadCurrentRouteCSV());

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

    // Minimize button (top-right)
    qs('#tm-ac-min')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    // Click minimized square to restore
    panel.addEventListener('click', () => {
      if (panel.classList.contains('minimized')) toggleMinimize();
    });

    GM_addStyle(`
      #tm-ac-panel{
        position: fixed; right: 14px; bottom: 14px;
        width: 420px; z-index: 2147483647;
        background: rgba(20,20,22,.92);
        color: #fff; border: 1px solid rgba(255,255,255,.15);
        border-radius: 12px; padding: 10px 12px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        box-shadow: 0 12px 30px rgba(0,0,0,.35);
      }
      #tm-ac-panel .tm-title{ font-weight: 700; margin-bottom: 8px; }
      #tm-ac-panel .tm-row{ display: flex; gap: 10px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      #tm-ac-panel button{
        flex: 1; cursor: pointer;
        border: 1px solid rgba(255,255,255,.2);
        background: rgba(255,255,255,.10);
        color: #fff; padding: 8px 10px; border-radius: 10px;
        min-width: 120px;
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
        max-height: 220px; overflow: auto;
        white-space: pre-wrap; font-size: 12px; line-height: 1.25;
      }

      /* Minimize UX */
      #tm-ac-panel .tm-min-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 22px;
        height: 22px;
        border-radius: 6px;
        background: rgba(255,255,255,.20);
        border: 1px solid rgba(255,255,255,.18);
        font-size: 14px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        user-select: none;
      }
      #tm-ac-panel .tm-min-btn:hover { background: rgba(255,255,255,.30); }

      #tm-ac-panel.minimized {
        width: 48px !important;
        height: 48px !important;
        padding: 0 !important;
        overflow: hidden !important;
        cursor: pointer;
      }
      #tm-ac-panel.minimized .tm-content { display: none !important; }
      #tm-ac-panel.minimized .tm-min-btn { display: none !important; }

      #tm-ac-panel.minimized::after {
        content: "☰";
        color: #fff;
        font-size: 24px;
        position: absolute;
        top: 10px;
        left: 12px;
      }
    `);
  }

  /**********************
   * Controls sync
   **********************/
  function syncControlsFromUI() {
    const nextCb = qs('#tm-ac-next');
    if (nextCb) state.autoNextDay = !!nextCb.checked;

    const stopInput = qs('#tm-ac-stop');
    if (stopInput && stopInput.value) state.stopDateISO = stopInput.value;
  }

  /**********************
   * Route + Date + Results
   **********************/
  function extractAirportCode(text) {
    const m = (text || '').match(/[A-Z0-9]{3}/);
    return m ? m[0] : '';
  }

  function getRouteInfo() {
    const originCodeText = normText(qs('.city-pairing-origin-city-code')?.textContent);
    const destCodeText   = normText(qs('.city-pairing-destination-city-code')?.textContent);

    const originCity = normText(qs('.city-pairing-origin-city')?.textContent);
    const destCity   = normText(qs('.city-pairing-destination-city')?.textContent);

    const o = extractAirportCode(originCodeText);
    const d = extractAirportCode(destCodeText);

    const routeKey = (o && d) ? `${o}-${d}` : '';
    const routeLabel = (originCity && destCity && o && d)
      ? `${originCity} (${o}) → ${destCity} (${d})`
      : routeKey;

    return { routeKey, routeLabel, o, d, originCity, destCity };
  }

  function getHeaderDateText() {
    return normText(qs('.city-pairing-label .date')?.textContent);
  }

  function getFlightResultsText() {
    return normText((qs('ac-ui-avail-flight-block-header-pres p.flight-count') || qs('p.flight-count'))?.textContent);
  }

  function findAllFlightRowWrappers() {
    return qsa('div.avail-flight-block-row-wrapper[id^="flight-row-"]');
  }

  function isResultsReady() {
    return !!getRouteInfo().routeKey && !!getHeaderDateText() && !!getFlightResultsText() && findAllFlightRowWrappers().length > 0;
  }

  function computeSignature() {
    const { routeKey } = getRouteInfo();
    const d = getHeaderDateText() || 'NO_DATE';
    const r = getFlightResultsText() || 'NO_RESULTS';
    return `${routeKey || 'NO_ROUTE'} || ${d} || ${r}`;
  }

  function refreshDebug() {
    const { routeKey } = getRouteInfo();
    const d = getHeaderDateText();
    const r = getFlightResultsText();
    const sig = computeSignature();
    setDebug(`Debug: route=${routeKey || '—'} | date=${d || '—'} | results=${r || '—'} | sig=${sig.slice(0, 150)}…`);
  }

  /**********************
   * Date parsing (year hint)
   **********************/
  function inferYearHint() {
    const btns = qsa('button[aria-label*="20"]');
    for (const b of btns) {
      const t = b.getAttribute('aria-label') || '';
      const m = t.match(/,\s*(20\d{2})\b/);
      if (m) return Number(m[1]);
    }
    return (new Date()).getFullYear();
  }

  const MONTHS = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
  };

  function parseHeaderDateToISO(dateText) {
    const m = (dateText || '').match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*,\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i);
    if (!m) return null;
    const mm = MONTHS[m[1].toLowerCase()];
    const dd = String(m[2]).padStart(2, '0');
    const yyyy = String(inferYearHint());
    return { iso: `${yyyy}-${mm}-${dd}`, mmdd: `${mm}/${dd}` };
  }

  function isoToDate(iso) {
    const m = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
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

  /**********************
   * Filters dialog
   **********************/
  function findFiltersOpenButton() {
    return qs('.mobile-filters-pill button[aria-haspopup="dialog"]')
      || qs('abc-button.filters-button button[aria-haspopup="dialog"]')
      || null;
  }
  function findFiltersDialog() {
    return qs('#filtersDetailsDialogBody')?.closest('.abc-dialog-wrapper')
      || qs('.abc-dialog-wrapper')
      || null;
  }
  function filtersDialogIsOpen() {
    const d = findFiltersDialog();
    return !!(d && visible(d));
  }
  async function openFiltersDialog() {
    if (filtersDialogIsOpen()) return true;
    const btn = findFiltersOpenButton();
    if (!btn) { setStatus('Filters: open button not found.'); return false; }
    setStatus('Filters: opening…');
    click(btn);
    const ok = await waitFor(() => filtersDialogIsOpen(), { timeoutMs: 12000, intervalMs: 200 });
    if (!ok) setStatus('Filters: failed to open (timeout).');
    return ok;
  }
  function findDoneButton() {
    return qs('button#filtersDetailsDialogButton0')
      || qs('button[aria-label="Done"]')
      || qsa('button').find(b => normText(b.textContent) === 'Done')
      || null;
  }
  async function clickDoneToCloseFilters() {
    const done = findDoneButton();
    if (!done) { setStatus('Filters: Done button not found (cannot close).'); return false; }
    setStatus('Filters: clicking Done…');
    click(done);
    await sleep(250);
    return true;
  }
  function findFilterBlockByHeaderText(headerText) {
    const headers = qsa('h2.filter-header');
    const h = headers.find(x => normText(x.textContent).toLowerCase() === headerText.toLowerCase());
    return h ? h.closest('.filter-block-container') : null;
  }

  /**********************
   * Sort: Lowest price
   **********************/
  async function enforceLowestPriceSort() {
    const opened = await openFiltersDialog();
    if (!opened) return false;

    const ok = await waitFor(() => !!qs('input[type="radio"][name="sortByFilterName"][value="price"]'),
      { timeoutMs: 12000, intervalMs: 200 });

    if (!ok) { setStatus('Sort: "Lowest price" radio not found.'); return false; }

    const input = qs('input[type="radio"][name="sortByFilterName"][value="price"]');
    if (input?.checked) { setStatus('Sort: already Lowest price ✓'); return true; }

    const label = input?.id ? qs(`label[for="${CSS.escape(input.id)}"]`) : null;
    setStatus('Sort: selecting Lowest price…');
    if (label) click(label); else click(input);

    await sleep(200);
    const nowChecked = !!qs('input[type="radio"][name="sortByFilterName"][value="price"]')?.checked;
    setStatus(nowChecked ? 'Sort: Lowest price ✓' : 'Sort: attempted (verify in UI)');
    return nowChecked;
  }

  /**********************
   * Remove US connecting airports
   **********************/
  function extractAirportCodeFromAriaLabel(ariaLabel) {
    const m = (ariaLabel || '').match(/\(([A-Z0-9]{3})\)/);
    return m ? m[1] : null;
  }
  function isAbcCheckboxChecked(inputEl) {
    if (!inputEl) return false;
    if (inputEl.checked) return true;
    const wrapper = inputEl.closest('.abc-form-element-wrapper');
    return !!(wrapper && wrapper.classList.contains('abc-form-element-checked'));
  }
  function toggleAbcCheckbox(inputEl) {
    if (!inputEl) return false;
    const label = inputEl.id ? qs(`label[for="${CSS.escape(inputEl.id)}"]`) : null;
    if (label) return click(label);
    const wrapper = inputEl.closest('.abc-form-element-wrapper');
    if (wrapper) return click(wrapper);
    return click(inputEl);
  }
  async function deselectUSConnectingAirports() {
    const opened = await openFiltersDialog();
    if (!opened) return { foundUS: 0, unchecked: 0, ok: false };

    const block = findFilterBlockByHeaderText('Connecting airports');
    if (!block) { setStatus('Remove US: "Connecting airports" section not found.'); return { foundUS: 0, unchecked: 0, ok: false }; }

    const inputs = qsa('input[type="checkbox"][aria-label]', block);
    if (!inputs.length) { setStatus('Remove US: no connecting airport checkboxes found.'); return { foundUS: 0, unchecked: 0, ok: false }; }

    let foundUS = 0, unchecked = 0;
    for (const inp of inputs) {
      const code = extractAirportCodeFromAriaLabel(inp.getAttribute('aria-label'));
      if (!code) continue;
      if (CFG.usAirportCodes.has(code)) {
        foundUS++;
        if (isAbcCheckboxChecked(inp)) {
          toggleAbcCheckbox(inp);
          unchecked++;
          await sleep(20);
        }
      }
    }

    setStatus(`Remove US: done ✓ (US found: ${foundUS}, unchecked: ${unchecked})`);
    return { foundUS, unchecked, ok: true };
  }

  /**********************
   * Cheapest per cabin (E / PE / BIZ)
   **********************/
  function parseNumberWithCommas(s) {
    const m = (s || '').match(/[\d,]+/);
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parseHiddenCurrencyText(hidden) {
    const t = normText(hidden);
    if (!t) return null;
    const m = t.match(/^([\d,]+)\s*([A-Z]{3})$/);
    if (!m) return null;
    const amount = parseNumberWithCommas(m[1]);
    const currency = m[2];
    if (amount == null) return null;
    return { amount, currency };
  }

  function formatMoneyHK(amount) {
    if (amount == null) return '—';
    return `HK$${amount.toLocaleString('en-US')}`;
  }

  function detectCabinKeyFromAriaLabel(aria) {
    const a = (aria || '').toLowerCase();
    if (a.includes('select economy')) return 'E';
    if (a.includes('select premium economy')) return 'PE';
    if (a.includes('select business class')) return 'BIZ';
    return null;
  }

  function extractCabinPriceFromButton(btn) {
    if (!btn) return null;

    const hidden = btn.querySelector('.cabin-price .visually-hidden, .cabin-price-amount .visually-hidden');
    const parsed = parseHiddenCurrencyText(hidden?.textContent);
    if (parsed) return parsed;

    const aria = btn.getAttribute('aria-label') || '';
    const amount = parseNumberWithCommas(aria);
    if (amount == null) return null;
    return { amount, currency: 'HKD' };
  }

  function scanCheapestPerCabin() {
    const rows = findAllFlightRowWrappers();
    if (!rows.length) return null;

    const best = { E: null, PE: null, BIZ: null };

    for (const row of rows) {
      const cabinButtons = qsa('button.button-cell-container[aria-label^="Select"]', row);
      for (const btn of cabinButtons) {
        const cabin = detectCabinKeyFromAriaLabel(btn.getAttribute('aria-label'));
        if (!cabin) continue;

        const price = extractCabinPriceFromButton(btn);
        if (!price || price.amount == null) continue;

        const current = best[cabin];
        if (!current || price.amount < current.amount) {
          best[cabin] = { amount: price.amount, currency: price.currency, label: formatMoneyHK(price.amount) };
        }
      }
    }
    if (!best.E && !best.PE && !best.BIZ) return null;
    return best;
  }

  async function loadCheapestStore() {
    const raw = await gmGet(CFG.cheapestStoreKey, '{}');
    try {
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch {
      return {};
    }
  }

  async function saveCheapestStore(store) {
    await gmSet(CFG.cheapestStoreKey, JSON.stringify(store));
  }

  function formatHistoryForRoute(store, routeKey) {
    const routeBucket = store?.[routeKey] || {};
    const keys = Object.keys(routeBucket).sort().reverse();
    const lines = keys.slice(0, CFG.historyLines).map(k => {
      const v = routeBucket[k];
      const mmdd = v.mmdd || k.slice(5);
      const e = v.E?.label ? `E: ${v.E.label}` : 'E: —';
      const pe = v.PE?.label ? `PE: ${v.PE.label}` : 'PE: —';
      const biz = v.BIZ?.label ? `BIZ: ${v.BIZ.label}` : 'BIZ: —';
      return `${mmdd}  ${e}, ${pe}, ${biz}`;
    });
    return lines.length ? `History (${routeKey}) (latest ${lines.length}):\n` + lines.join('\n') : `History (${routeKey || '—'}): —`;
  }

  async function recordCheapestPerCabinForDate() {
    const { routeKey } = getRouteInfo();
    if (!routeKey) { setCheapest('Cheapest: (route not found)'); return { dateISO: null }; }

    const parsedDate = parseHeaderDateToISO(getHeaderDateText());
    if (!parsedDate) { setCheapest(`Cheapest (${routeKey}): (date parse failed)`); return { dateISO: null }; }

    await sleep(250);

    const cheapest = scanCheapestPerCabin();
    if (!cheapest) { setCheapest(`Cheapest (${routeKey} ${parsedDate.mmdd}): not found`); return { dateISO: parsedDate.iso }; }

    const store = await loadCheapestStore();
    if (!store[routeKey] || typeof store[routeKey] !== 'object') store[routeKey] = {};

    const existing = store[routeKey][parsedDate.iso] || { iso: parsedDate.iso, mmdd: parsedDate.mmdd };

    for (const key of ['E','PE','BIZ']) {
      const cand = cheapest[key];
      if (!cand || cand.amount == null) continue;

      const prev = existing[key];
      if (!prev || prev.amount == null || cand.amount < prev.amount) {
        existing[key] = {
          amount: cand.amount,
          currency: cand.currency || 'HKD',
          label: formatMoneyHK(cand.amount),
          updatedAt: new Date().toISOString()
        };
      }
    }

    existing.updatedAt = new Date().toISOString();
    store[routeKey][parsedDate.iso] = existing;
    await saveCheapestStore(store);

    const e = existing.E?.label ? `E: ${existing.E.label}` : 'E: —';
    const pe = existing.PE?.label ? `PE: ${existing.PE.label}` : 'PE: —';
    const biz = existing.BIZ?.label ? `BIZ: ${existing.BIZ.label}` : 'BIZ: —';

    setCheapest(`Cheapest (${routeKey} ${existing.mmdd}): ${e}, ${pe}, ${biz}`);
    setHistory(formatHistoryForRoute(store, routeKey));

    return { dateISO: parsedDate.iso };
  }

  /**********************
   * CSV Export — amount only for ALL classes, label in header only
   **********************/
  async function downloadCurrentRouteCSV() {
    const { routeKey } = getRouteInfo();
    if (!routeKey) { setStatus('CSV: route not detected yet.'); return; }

    const store = await loadCheapestStore();
    const bucket = store?.[routeKey];
    if (!bucket || !Object.keys(bucket).length) { setStatus(`CSV: no saved history for ${routeKey}.`); return; }

    // Choose currency label from first record; fallback HK$
    const anyKey = Object.keys(bucket)[0];
    const anyRec = bucket[anyKey] || {};
    const cur = (anyRec.E?.currency || anyRec.PE?.currency || anyRec.BIZ?.currency || 'HKD');
    const currencyLabel = (cur === 'HKD') ? 'HK$' : cur;

    const header = [
      'Route',
      'DateISO',
      'MMDD',
      `Economy (${currencyLabel})`,
      `Premium Economy (${currencyLabel})`,
      `Business (${currencyLabel})`,
      'UpdatedAt'
    ];

    const dates = Object.keys(bucket).sort(); // ascending file
    const rows = dates.map(dateISO => {
      const v = bucket[dateISO] || {};
      return [
        routeKey,
        dateISO,
        v.mmdd || dateISO.slice(5),
        v.E?.amount ?? '',
        v.PE?.amount ?? '',
        v.BIZ?.amount ?? '',
        v.updatedAt ?? ''
      ];
    });

    const csv = [
      header.map(csvEscape).join(','),
      ...rows.map(r => r.map(csvEscape).join(','))
    ].join('\n');

    const filename = `ACBooking_${routeKey}_${formatTodayISO()}.csv`;
    downloadTextFile(filename, csv);
    setStatus(`CSV downloaded: ${filename}`);
  }

  /**********************
   * Auto-next-day via calendar tabs
   **********************/
  function findCalendarContainer() {
    return qs('section.calendar-container') || qs('ac-ui-avail-calendar-panel-pres section.calendar-container') || null;
  }
  function findCalendarTablistRoot(container) {
    return container?.querySelector('div[role="tablist"].abc-tab-list-buttons') || null;
  }
  function findSelectedTabButton(container) {
    return container?.querySelector('button[role="tab"][aria-selected="true"]') || null;
  }
  function findRightArrowButton(container) {
    return container?.querySelector('button[data-analytics-val*="right arrow"]') || null;
  }
  function tabButtonLooksDisabled(btn) {
    if (!btn) return true;
    const ariaDisabled = btn.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') return true;
    return !!btn.disabled;
  }
  function isElementInViewportHoriz(el, container) {
    if (!el || !container) return false;
    const r = el.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    return r.left >= c.left && r.right <= c.right;
  }
  function findNextTabButton(container) {
    const selected = findSelectedTabButton(container);
    if (!selected) return null;
    const tablist = findCalendarTablistRoot(container);
    if (!tablist) return null;
    const tabs = qsa('button[role="tab"]', tablist);
    const idx = tabs.indexOf(selected);
    if (idx < 0) return null;
    return tabs[idx + 1] || null;
  }

  async function waitForSignatureChange(prevSig, expectedISO) {
    return await waitFor(() => {
      const sig = computeSignature();
      if (sig && sig !== prevSig && isResultsReady()) return true;

      const parsed = parseHeaderDateToISO(getHeaderDateText());
      if (parsed?.iso && expectedISO && parsed.iso === expectedISO && isResultsReady()) return true;

      return false;
    }, { timeoutMs: CFG.waitForNewResultsTimeoutMs, intervalMs: 500 });
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

    const tablist = findCalendarTablistRoot(cal);
    if (!tablist) return { clicked: false, reason: 'calendar tablist not found' };

    let nextTab = findNextTabButton(cal);
    if (!nextTab) return { clicked: false, reason: 'next tab not found (already at end?)', nextISO };

    let guard = 0;
    while (nextTab && !isElementInViewportHoriz(nextTab, tablist) && guard < 12) {
      const right = findRightArrowButton(cal);
      if (!right || tabButtonLooksDisabled(right)) break;
      setStatus('Auto-next-day: paging calendar right…');
      click(right);
      await sleep(250);
      nextTab = findNextTabButton(cal);
      guard++;
    }

    if (!nextTab) return { clicked: false, reason: 'next tab not found after paging', nextISO };

    setStatus(`Auto-next-day: clicking next day (${nextISO})…`);
    click(nextTab);

    return { clicked: true, reason: 'clicked next day tab', nextISO };
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
   * Scheduler / State
   **********************/
  const state = {
    auto: true,
    autoNextDay: false,
    stopDateISO: '',
    running: false,
    lastProcessedSignature: '',
    pendingTimer: null,
    pendingSig: ''
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

        // Open Filters and apply actions
        const opened = await openFiltersDialog();
        if (!opened) { setStatus('Stopped: cannot open Filters dialog.'); break; }

        await enforceLowestPriceSort();
        await deselectUSConnectingAirports();
        await clickDoneToCloseFilters();

        // Record cheapest per cabin
        const parsed = parseHeaderDateToISO(getHeaderDateText());
        const currentISO = parsed?.iso || null;
        await recordCheapestPerCabinForDate();

        state.lastProcessedSignature = computeSignature();

        // Auto-next-day loop
        syncControlsFromUI();
        if (!allowLoop || !state.autoNextDay) {
          setStatus(!state.autoNextDay ? 'Done ✓ (auto-next-day off)' : 'Done ✓');
          break;
        }
        if (!state.auto) { setStatus('Stopped (Auto disabled)'); break; }

        const clickRes = await clickNextDayOnce(currentISO);
        if (!clickRes.clicked) { setStatus(`Done ✓ (${clickRes.reason})`); break; }

        setStatus(`Clicked next day (${clickRes.nextISO}) → waiting for results…`);
        await sleep(CFG.waitAfterClickMs);

        const ok = await waitForSignatureChange(sigBefore, clickRes.nextISO);
        refreshDebug();
        if (!ok) { setStatus(`Stopped (timeout waiting for ${clickRes.nextISO})`); break; }

        force = false;
        reason = 'auto-next loop';
      }
    } catch (e) {
      console.error('[AC Booking Helper] runAll ERROR', e);
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
   * BOOT
   **********************/
  async function boot() {
    mountPanel();
    observeSpa();
    startPolling();

    await initPersistedControlsBoot();
    await applyMinimizeState();

    setHistory('History: — (waiting for route/results)');
    setStatus('Waiting for route/date/results…');
    checkAndSchedule('boot');
  }

  boot();

})();
