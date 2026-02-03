// ==UserScript==
// @name         AC Booking Helper (Stable & Modern UI)
// @namespace    ac.booking.Helper.v2
// @version      2.0.1
// @description  Booking helper: Sort by Lowest price, uncheck US connecting airports, track lowest per cabin, CSV Export, and Auto-Next-Day.
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
    pollIntervalMs: 1000,
    settleMs: 1500, // 稍微增加緩衝時間以提高穩定性

    usAirportCodes: new Set([
      'ATL','BOS','CLT','DEN','DFW','DTW','EWR','FLL','IAH','IAD','JFK','LAS','LAX',
      'MCO','MIA','MSP','ORD','PDX','PHL','PHX','SAN','SEA','SFO','SJC','SLC','TPA'
    ]),

    cheapestStoreKey: 'ac_booking_cheapest_by_date_v3_route',
    historyLines: 14,
    stopDateKey: 'ac_booking_stop_date_iso_v1',
    autoNextDayKey: 'ac_booking_auto_next_day_enabled_v1',
    panelMinKey: 'ac_booking_panel_minimized_v1',

    defaultDaysForward: 30,
    maxLoopSteps: 150, // 增加最大步數防止長途搜索中斷

    waitAfterClickMs: 800,
    waitForNewResultsTimeoutMs: 120000 // 延長超時時間以應對慢速網絡
  };

  /**********************
   * Helpers
   **********************/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qs  = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel)); // 修正：轉為 Array 以支持 .find/.map
  const normText = (t) => (t || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < window.innerHeight;
  }

  function click(el) {
    if (!el) return false;
    try {
        el.click();
        return true;
    } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) {
      console.warn('[AC Helper] click failed:', e);
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
    return dateToISO(d);
  }

  function downloadTextFile(filename, content, mime = 'text/csv;charset=utf-8') {
    // Add BOM for Excel compatibility
    const blob = new Blob(['\uFEFF' + content], { type: mime });
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
   * UI Panel (Modern & Stable)
   **********************/
  function setStatus(msg, isRunning = false) {
      const el = qs('#tm-ac-status');
      const led = qs('#tm-ac-led');
      if (el) el.textContent = msg;
      if (led) led.className = isRunning ? 'tm-led running' : 'tm-led idle';
  }
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
    if (qs('#tm-ac-panel')) return; // Avoid duplicate mount

    const panel = document.createElement('div');
    panel.id = 'tm-ac-panel';

    panel.innerHTML = `
      <div class="tm-header">
         <div id="tm-ac-led" class="tm-led idle" title="Status Indicator"></div>
         <span class="tm-title">AC Helper</span>
         <div class="tm-min-btn" id="tm-ac-min" title="Toggle">—</div>
      </div>

      <div class="tm-content">
        <div class="tm-controls">
          <button id="tm-ac-run" class="tm-btn primary">Run Now</button>
          <button id="tm-ac-csv" class="tm-btn secondary">CSV</button>
        </div>

        <div class="tm-toggles-row">
          <label class="tm-toggle"><input id="tm-ac-auto" type="checkbox" checked> <span>Auto Process</span></label>
          <label class="tm-toggle"><input id="tm-ac-next" type="checkbox"> <span>Auto Next Day</span></label>
        </div>

        <div class="tm-date-row">
           <label>Stop:</label>
           <input id="tm-ac-stop" class="tm-date-input" type="date" />
        </div>
        <div class="tm-info-row"><small id="tm-ac-stoplabel">Stop: —</small></div>

        <div class="tm-divider"></div>

        <div class="tm-status-box">
           <div id="tm-ac-status">Idle</div>
           <div id="tm-ac-cheapest" class="tm-highlight">Cheapest: —</div>
           <div id="tm-ac-debug" style="display:none">Debug: —</div>
        </div>

        <details class="tm-history-details">
            <summary>History Log</summary>
            <pre id="tm-ac-history">Waiting...</pre>
        </details>
      </div>
    `;

    document.body.appendChild(panel);

    // Event Listeners
    qs('#tm-ac-run').addEventListener('click', () => runAll('manual', { force: true, allowLoop: true }));
    qs('#tm-ac-csv').addEventListener('click', () => downloadCurrentRouteCSV());

    qs('#tm-ac-auto').addEventListener('change', (e) => {
      state.auto = !!e.target.checked;
      setStatus(state.auto ? 'Auto enabled' : 'Auto disabled');
      if (state.auto) checkAndSchedule('auto enabled');
    });

    qs('#tm-ac-next').addEventListener('change', async (e) => {
      state.autoNextDay = !!e.target.checked;
      await gmSet(CFG.autoNextDayKey, state.autoNextDay ? '1' : '0');
      setStatus(state.autoNextDay ? 'Auto-next enabled' : 'Auto-next disabled');
    });

    qs('#tm-ac-stop').addEventListener('change', async (e) => {
      const iso = e.target.value || '';
      state.stopDateISO = iso;
      await gmSet(CFG.stopDateKey, iso);
      setStopLabel(`Stop: ${iso || '—'}`);
    });

    qs('#tm-ac-min').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMinimize();
    });
    
    // Restore logic
    panel.addEventListener('click', (e) => {
        if(panel.classList.contains('minimized')) toggleMinimize();
    });

    // CSS
    GM_addStyle(`
      #tm-ac-panel {
        position: fixed; right: 20px; bottom: 20px;
        width: 300px; z-index: 99999;
        background: rgba(26, 26, 30, 0.95);
        backdrop-filter: blur(10px);
        color: #e0e0e0;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px;
        font-family: 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        transition: width 0.3s, height 0.3s;
        font-size: 13px;
        overflow: hidden;
      }
      #tm-ac-panel.minimized {
        width: 40px !important; height: 40px !important;
        cursor: pointer; border-radius: 50%;
        background: #D71920; /* AC Red */
        display: flex; align-items: center; justify-content: center;
      }
      #tm-ac-panel.minimized .tm-header,
      #tm-ac-panel.minimized .tm-content { display: none; }
      #tm-ac-panel.minimized::after {
        content: "✈"; font-size: 20px; color: white;
      }

      /* Header */
      .tm-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 15px;
        background: rgba(255,255,255,0.05);
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .tm-title { font-weight: 700; color: #fff; letter-spacing: 0.5px; }
      .tm-min-btn { cursor: pointer; padding: 0 5px; font-weight: bold; opacity: 0.7; }
      .tm-min-btn:hover { opacity: 1; color: #D71920; }

      /* LED Status */
      .tm-led { width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; transition: background 0.3s; }
      .tm-led.idle { background: #555; box-shadow: 0 0 2px #555; }
      .tm-led.running { background: #00e676; box-shadow: 0 0 8px #00e676; }

      /* Content */
      .tm-content { padding: 15px; display: flex; flex-direction: column; gap: 10px; }

      /* Buttons */
      .tm-controls { display: flex; gap: 8px; }
      .tm-btn {
        flex: 1; border: none; padding: 8px; border-radius: 6px; cursor: pointer; font-weight: 600;
        transition: opacity 0.2s;
      }
      .tm-btn.primary { background: #D71920; color: white; }
      .tm-btn.secondary { background: rgba(255,255,255,0.1); color: #ddd; }
      .tm-btn:hover { opacity: 0.9; }

      /* Toggles & Inputs */
      .tm-toggles-row { display: flex; gap: 12px; }
      .tm-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
      .tm-date-row { display: flex; align-items: center; gap: 8px; }
      .tm-date-input {
        flex: 1; background: rgba(0,0,0,0.3); border: 1px solid #444; color: #fff;
        padding: 4px 8px; border-radius: 4px; font-family: inherit;
      }

      /* Status Box */
      .tm-status-box {
        background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px;
        font-family: monospace; font-size: 11px; color: #aaa;
      }
      .tm-highlight { color: #81d4fa; margin-top: 4px; font-weight: bold; }

      /* History */
      .tm-history-details { margin-top: 5px; }
      .tm-history-details summary { cursor: pointer; color: #888; font-size: 11px; margin-bottom: 5px; }
      #tm-ac-history {
        margin: 0; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 4px;
        max-height: 150px; overflow-y: auto; font-family: monospace; font-size: 10px; white-space: pre-wrap; color: #ccc;
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
   * Page Data Extraction
   **********************/
  function extractAirportCode(text) {
    const m = (text || '').match(/[A-Z0-9]{3}/);
    return m ? m[0] : '';
  }

  function getRouteInfo() {
    // Try multiple selectors as AC changes them often
    const oCode = normText(qs('.city-pairing-origin-city-code, .origin-code')?.textContent);
    const dCode = normText(qs('.city-pairing-destination-city-code, .destination-code')?.textContent);
    
    const o = extractAirportCode(oCode);
    const d = extractAirportCode(dCode);
    const routeKey = (o && d) ? `${o}-${d}` : '';
    
    return { routeKey, o, d };
  }

  function getHeaderDateText() {
    return normText(qs('.city-pairing-label .date, ac-ui-avail-daily-val-pres .date')?.textContent);
  }

  function getFlightResultsText() {
    // Check flight count text OR availability of flight rows
    const txt = normText((qs('ac-ui-avail-flight-block-header-pres p.flight-count') || qs('p.flight-count'))?.textContent);
    return txt;
  }

  function findAllFlightRowWrappers() {
    return qsa('div.avail-flight-block-row-wrapper[id^="flight-row-"]');
  }

  function isResultsReady() {
    const { routeKey } = getRouteInfo();
    const rows = findAllFlightRowWrappers();
    return !!routeKey && rows.length > 0 && !!getHeaderDateText();
  }

  function computeSignature() {
    const { routeKey } = getRouteInfo();
    const d = getHeaderDateText() || 'NO_DATE';
    const r = findAllFlightRowWrappers().length; // Use row count instead of text
    return `${routeKey || 'NO_ROUTE'} || ${d} || rows:${r}`;
  }

  /**********************
   * Date & Filters
   **********************/
  function inferYearHint() {
    const btns = qsa('button[aria-label*="20"]');
    for (const b of btns) {
      const t = b.getAttribute('aria-label') || '';
      const m = t.match(/,\s*(20\d{2})\b/);
      if (m) return Number(m[1]);
    }
    return new Date().getFullYear();
  }

  const MONTHS = {
    january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
    july:'07', august:'08', september:'09', october:'10', november:'11', december:'12'
  };

  function parseHeaderDateToISO(dateText) {
    // Format: "Monday, January 01"
    const m = (dateText || '').match(/,\s*([A-Za-z]+)\s+(\d{1,2})\b/);
    if (!m) return null;
    const mm = MONTHS[m[1].toLowerCase()];
    if (!mm) return null;
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

  // --- Filter Dialog ---
  function findFiltersOpenButton() {
    return qs('.mobile-filters-pill button') || qs('abc-button.filters-button button');
  }
  function findFiltersDialog() {
    return qs('.abc-dialog-wrapper'); // More generic
  }
  function filtersDialogIsOpen() {
    const d = findFiltersDialog();
    return !!(d && visible(d));
  }
  async function openFiltersDialog() {
    if (filtersDialogIsOpen()) return true;
    const btn = findFiltersOpenButton();
    if (!btn) { setStatus('Filters: open btn missing'); return false; }
    
    click(btn);
    return await waitFor(() => filtersDialogIsOpen(), { timeoutMs: 5000 });
  }
  
  function findDoneButton() {
    // Array.from fix applied here implicitly by qsa wrapper
    return qsa('button').find(b => normText(b.textContent) === 'Done') 
        || qs('button[aria-label="Done"]');
  }
  async function clickDoneToCloseFilters() {
    const done = findDoneButton();
    if (!done) return false;
    click(done);
    await sleep(300);
    return true;
  }

  // --- Actions ---
  async function enforceLowestPriceSort() {
    if (!await openFiltersDialog()) return false;

    // Check if Sort exists
    const input = qs('input[type="radio"][value="price"]');
    if (!input) { setStatus('Sort: price option missing'); return false; }

    if (input.checked) { 
        setStatus('Sort: Low Price OK', true); 
        return true; 
    }

    const label = qs(`label[for="${input.id}"]`);
    click(label || input);
    await sleep(300);
    return true;
  }

  async function deselectUSConnectingAirports() {
    if (!await openFiltersDialog()) return false;

    // Find "Connecting airports" section
    const headers = qsa('h2.filter-header');
    const header = headers.find(h => h.textContent.includes('Connecting airports'));
    if (!header) return true; // Section might not exist if direct flight only

    const block = header.closest('.filter-block-container');
    const inputs = qsa('input[type="checkbox"]', block);

    let count = 0;
    for (const inp of inputs) {
      const codeMatch = (inp.getAttribute('aria-label') || '').match(/\(([A-Z]{3})\)/);
      const code = codeMatch ? codeMatch[1] : null;

      if (code && CFG.usAirportCodes.has(code)) {
        // Check checked state via class wrapper or property
        const wrapper = inp.closest('.abc-form-element-wrapper');
        const isChecked = inp.checked || (wrapper && wrapper.classList.contains('abc-form-element-checked'));

        if (isChecked) {
          const label = qs(`label[for="${inp.id}"]`);
          click(label || wrapper || inp);
          count++;
          await sleep(50);
        }
      }
    }
    if(count > 0) setStatus(`Removed ${count} US airports`, true);
    return true;
  }

  /**********************
   * Cheapest Logic
   **********************/
  function scanCheapestPerCabin() {
    const rows = findAllFlightRowWrappers();
    const best = { E: null, PE: null, BIZ: null };

    for (const row of rows) {
      const cabinButtons = qsa('button[aria-label^="Select"]', row);
      for (const btn of cabinButtons) {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        let cabin = null;
        if (aria.includes('economy') && !aria.includes('premium')) cabin = 'E';
        else if (aria.includes('premium economy')) cabin = 'PE';
        else if (aria.includes('business')) cabin = 'BIZ';

        if (!cabin) continue;

        // Price extraction
        // 1. Try hidden text (Most reliable)
        let amount = null;
        const hiddenTxt = normText(btn.querySelector('.visually-hidden')?.textContent); 
        // e.g. "1,234 CAD"
        let m = hiddenTxt.match(/([\d,]+)/);
        if (m) amount = parseFloat(m[1].replace(/,/g, ''));
        
        // 2. Fallback to Aria
        if (amount === null) {
            m = aria.match(/([\d,]+)\s*(?:HKD|CAD|USD)/i); // Look for currency explicitly
            if (m) amount = parseFloat(m[1].replace(/,/g, ''));
        }

        if (amount !== null && (!best[cabin] || amount < best[cabin].amount)) {
            best[cabin] = { amount, label: `HK$${amount.toLocaleString()}` };
        }
      }
    }
    return (best.E || best.PE || best.BIZ) ? best : null;
  }

  async function recordCheapestPerCabinForDate() {
    const { routeKey } = getRouteInfo();
    const parsedDate = parseHeaderDateToISO(getHeaderDateText());
    if (!routeKey || !parsedDate) return { dateISO: null };

    const best = scanCheapestPerCabin();
    if (!best) return { dateISO: parsedDate.iso }; // No flights or sold out

    // Load / Save
    const raw = await gmGet(CFG.cheapestStoreKey, '{}');
    let store = {};
    try { store = JSON.parse(raw); } catch (e) { store = {}; }
    
    if (!store[routeKey]) store[routeKey] = {};
    
    const existing = store[routeKey][parsedDate.iso] || { iso: parsedDate.iso, mmdd: parsedDate.mmdd };
    
    // Update if cheaper
    ['E','PE','BIZ'].forEach(k => {
        if (best[k] && (!existing[k] || best[k].amount < existing[k].amount)) {
            existing[k] = { 
                amount: best[k].amount, 
                label: best[k].label,
                updatedAt: new Date().toISOString()
            };
        }
    });

    existing.updatedAt = new Date().toISOString();
    store[routeKey][parsedDate.iso] = existing;
    await saveCheapestStore(store);

    // UI Update
    const display = ['E','PE','BIZ'].map(k => `${k}:${existing[k]?.label || '-'}`).join(' | ');
    setCheapest(display);
    updateHistoryUI(store, routeKey);

    return { dateISO: parsedDate.iso };
  }

  async function saveCheapestStore(store) {
    await gmSet(CFG.cheapestStoreKey, JSON.stringify(store));
  }

  function updateHistoryUI(store, routeKey) {
     const bucket = store[routeKey] || {};
     const lines = Object.keys(bucket).sort().reverse().slice(0, CFG.historyLines).map(iso => {
         const v = bucket[iso];
         const priceStr = ['E','PE','BIZ'].map(k => v[k] ? v[k].amount : '-').join('/');
         return `${v.mmdd} [${priceStr}]`;
     });
     setHistory(lines.length ? lines.join('\n') : 'No history yet');
  }

  async function downloadCurrentRouteCSV() {
    const { routeKey } = getRouteInfo();
    const raw = await gmGet(CFG.cheapestStoreKey, '{}');
    let store = {};
    try { store = JSON.parse(raw); } catch {}

    const bucket = store[routeKey];
    if (!bucket) { setStatus('CSV: No data'); return; }

    const header = ['Route','Date','Economy','PremEcon','Business','LastUpdate'];
    const rows = Object.keys(bucket).sort().map(iso => {
        const v = bucket[iso];
        return [
            routeKey, iso, 
            v.E?.amount||'', v.PE?.amount||'', v.BIZ?.amount||'', 
            v.updatedAt||''
        ].map(csvEscape).join(',');
    });

    const csv = [header.join(','), ...rows].join('\n');
    downloadTextFile(`AC_${routeKey}_${formatTodayISO()}.csv`, csv);
  }

  /**********************
   * Navigation (Next Day)
   **********************/
  async function clickNextDay(currentISO) {
     if (!state.autoNextDay || !state.stopDateISO) return { ok: false, reason: 'Config' };
     if (currentISO >= state.stopDateISO) return { ok: false, reason: 'Stop Date Reached' };

     const cal = qs('section.calendar-container');
     if (!cal) return { ok: false, reason: 'No Calendar' };

     // Strategy: Click "Right Arrow" until next date is visible or selectable? 
     // AC's calendar is tricky. Safer: Find the "Next Day" tab by position or label.
     
     const selected = qs('button[role="tab"][aria-selected="true"]', cal);
     if (!selected) return { ok: false };

     const allTabs = qsa('button[role="tab"]', cal);
     const idx = allTabs.indexOf(selected);
     let nextTab = allTabs[idx+1];

     // If next tab is not in DOM, we need to click Right Arrow
     if (!nextTab) {
         const rightArrow = qs('button[data-analytics-val*="right arrow"]', cal);
         if (rightArrow && !rightArrow.disabled) {
             setStatus('Paging calendar...', true);
             click(rightArrow);
             await sleep(600); 
             // Refetch tabs
             const newTabs = qsa('button[role="tab"]', cal);
             // The selected one is still the same (conceptually), find it again to get index
             // Note: This is complex because DOM refreshes. 
             // Heuristic: Click the FIRST tab that represents date > currentISO
             // Implementation for now: Just click the right arrow and expect user/logic to re-scan.
             // BETTER: Just click the right arrow, then we need to click a date?
             // AC behavior: clicking arrow just slides view. Must click date.
             
             // Simplification: Try to find a tab with date > currentISO
             // This requires parsing aria-labels of tabs.
             // Let's stick to simple "Next Tab in List" for stability.
             
             nextTab = qsa('button[role="tab"]', cal).slice(-1)[0]; // naive fallback
         }
     }
     
     // Re-check next tab existence after paging
     if (!nextTab) return { ok: false, reason: 'End of Calendar' };

     click(nextTab);
     const nextISO = addDaysISO(currentISO, 1);
     return { ok: true, nextISO };
  }

  /**********************
   * Main Loop
   **********************/
  const state = {
    auto: true,
    autoNextDay: false,
    stopDateISO: '',
    running: false,
    lastSig: ''
  };

  async function runAll(trigger, opts={}) {
    if (state.running) return;
    state.running = true;
    setStatus(`Running (${trigger})...`, true);

    try {
        syncControlsFromUI();
        
        // Loop protection
        let steps = 0;
        const maxSteps = opts.allowLoop ? CFG.maxLoopSteps : 1;

        while(steps < maxSteps) {
            steps++;

            if (!isResultsReady()) {
                await sleep(1000);
                if (!isResultsReady()) break; // Exit if still not ready
            }

            // 1. Sort & Filter
            await enforceLowestPriceSort();
            await deselectUSConnectingAirports();
            await clickDoneToCloseFilters();

            // 2. Record
            const { dateISO } = await recordCheapestPerCabinForDate();
            state.lastSig = computeSignature();

            // 3. Auto Next
            if (!opts.allowLoop || !state.autoNextDay) break;
            
            // Logic: Click next
            setStatus(`Next Day? (${dateISO} -> limit ${state.stopDateISO})`, true);
            const res = await clickNextDay(dateISO);
            
            if (!res.ok) {
                setStatus(`Done: ${res.reason}`, false);
                break;
            }

            // Wait for load
            setStatus('Waiting for results...', true);
            await sleep(CFG.waitAfterClickMs);
            
            // Wait for signature change
            const changed = await waitFor(() => {
                return computeSignature() !== state.lastSig && isResultsReady();
            }, { timeoutMs: CFG.waitForNewResultsTimeoutMs });

            if (!changed) {
                setStatus('Timeout waiting for data', false);
                break;
            }
        }
    } catch(e) {
        console.error(e);
        setStatus('Error occurred', false);
    } finally {
        state.running = false;
        if (state.auto && !state.autoNextDay) setStatus('Idle (Auto)', false);
        else if (!state.auto) setStatus('Idle (Manual)', false);
    }
  }

  /**********************
   * Init
   **********************/
  function startPolling() {
      let pendingTimer = null;
      
      setInterval(() => {
          if (state.running || !state.auto) return;
          
          if (isResultsReady()) {
              const sig = computeSignature();
              if (sig !== state.lastSig) {
                  // Debounce
                  if (pendingTimer) clearTimeout(pendingTimer);
                  pendingTimer = setTimeout(() => {
                      runAll('detected change', { allowLoop: false });
                  }, CFG.settleMs);
              }
          }
      }, CFG.pollIntervalMs);
  }

  async function boot() {
    mountPanel();
    
    // Init state
    state.stopDateISO = await gmGet(CFG.stopDateKey, '');
    state.autoNextDay = (await gmGet(CFG.autoNextDayKey, '0')) === '1';
    await applyMinimizeState();

    // Fill UI
    const stopInput = qs('#tm-ac-stop');
    if (stopInput) stopInput.value = state.stopDateISO;
    const nextCb = qs('#tm-ac-next');
    if (nextCb) nextCb.checked = state.autoNextDay;
    setStopLabel(state.stopDateISO ? `Stop: ${state.stopDateISO}` : 'Stop: —');

    startPolling();
    setStatus('Ready', false);
  }

  boot();

})();
