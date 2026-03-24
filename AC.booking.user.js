// ==UserScript==
// @name         $700 Air Canada Scraper v2.9 (1s Beep Loop)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  AC Scraper: 1s Interval Beep & Flash on Deal, Stop on Minimize
// @author       Gemini
// @match        https://www.aircanada.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_listValues
// @grant        GM_deleteValue
// @connect      discord.com
// @connect      discordapp.com
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        searchParams: {
            org: 'YYZ', dest: 'HKG', orgType: 'A', destType: 'A',
            tripType: 'OneWay', adt: 2, yth: 0, chd: 0, inf: 0, ins: 0
        },
        databaseName: 'ac_booking_cheapest',
        defaultStopSearchDate: '2026-05-22',
        historyLines: 15,

        priceThreshold: 700,

        usAirportCodes: new Set([
            'ATL','BOS','CLT','DEN','DFW','DTW','EWR','FLL','IAH','IAD','JFK','LAS','LAX',
            'MCO','MIA','MSP','ORD','PDX','PHL','PHX','SAN','SEA','SFO','SJC','SLC','TPA',
            'HNL','OGG','KOA','LIH','ANC','FAI'
        ]),

        // ▼▼▼ Target Range ▼▼▼
        targetDatesConfig: [
            { start: '2026-05-20', end: '2026-05-23' }
        ],

        autoIntervalHours: 1,
        manualTimeoutHours: 1,
        waitElementTimeout: 30000
    };

    // --- Sound File ---
    const ALERT_SOUND_URL = "https://actions.google.com/sounds/v1/alarms/beep_short.ogg";
    const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1486124904230293575/MxWbHHCliHhiAqvft2zjeIS_9awvwiQXJ0Zgpfwvm5zzFOiYbgaMMci8e0XIUgqgCDGE";

    function processPriceUpdate(date, econ, prem, busi) {
        const storageKey = `lowest_prices_${date}`;
        const msgIdKey = `discord_msg_id_${date}`;

        // 1. 取得歷史最低價 (LocalStorage)
        let localLowest = JSON.parse(localStorage.getItem(storageKey)) || { econ: 99999, prem: 99999, busi: 99999 };

        const newEcon = parseInt(econ) || 99999;
        const newPrem = parseInt(prem) || 99999;
        const newBusi = parseInt(busi) || 99999;

        // 2. 檢查係咪有任何一個艙等創咗新低
        const isEconLower = newEcon < localLowest.econ;
        const isPremLower = newPrem < localLowest.prem;
        const isBusiLower = newBusi < localLowest.busi;
        const isNewLow = isEconLower || isPremLower || isBusiLower;


        // 3. 檢查係咪低過個人設定門檻 (Alert)
        const hitThreshold = (newEcon > 100 && newEcon <= CONFIG.priceThreshold);

            const updatedLow = {
                econ: Math.min(newEcon, localLowest.econ),
                prem: Math.min(newPrem, localLowest.prem),
                busi: Math.min(newBusi, localLowest.busi)
            };
            localStorage.setItem(storageKey, JSON.stringify(updatedLow));

            // 準備 Discord Payload
            const now = new Date().toLocaleString('zh-HK', { hour12: false });
            const lastMsgId = localStorage.getItem(msgIdKey);

            // 如果低過 Threshold，就發新 Message (Post)，唔係就 Edit (Patch)
            const method = (hitThreshold || !lastMsgId) ? "POST" : "PATCH";
            const url = (method === "PATCH") ? `${DISCORD_WEBHOOK}/messages/${lastMsgId}` : `${DISCORD_WEBHOOK}?wait=true`;

            const payload = {
                content: hitThreshold ? `🚨 **[DEAL ALERT]** $${newEcon} <@everyone>` : `📈 **Air Canada 監控中**`,
                embeds: [{
                    title: `日期: ${date}`,
                    color: hitThreshold ? 15158332 : 3447003,
                    description: isNewLow ? "✨ **發現更低價格！**" : "✅ 價格持平",
                    fields: [
                        { name: "Economy", value: `$${updatedLow.econ}${isEconLower ? " 📉" : ""}`, inline: true },
                        { name: "Premium", value: `$${updatedLow.prem}${isPremLower ? " 📉" : ""}`, inline: true },
                        { name: "Business", value: `$${updatedLow.busi}${isBusiLower ? " 📉" : ""}`, inline: true }
                    ],
                    footer: { text: `最後巡邏: ${now}` }
                }]
            };

            console.log(`[Discord] Sending ${method} to Webhook...`);

            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(payload),
                onload: function(res) {
                    if (res.status >= 200 && res.status < 300) {
                        if (method === "POST" && !hitThreshold) {
                            const response = JSON.parse(res.responseText);
                            localStorage.setItem(msgIdKey, response.id);
                        }
                    } else if (res.status === 404) {
                        localStorage.removeItem(msgIdKey);
                    } else {
                        console.error("[Discord] Error:", res.responseText);
                    }
                },
                onerror: (err) => console.error("[Discord] Request Failed", err)
            });

    }

    // --- State ---
    let state = GM_getValue('scraper_state', {
        status: 'IDLE',
        currentSearchDate: null,
        startDate: null,
        stopDate: CONFIG.defaultStopSearchDate,
        targetIndex: 0,
        logs: [],
        progress: '0/0',
        nextAutoRunTimestamp: 0,
        manualStartTime: 0,
        isMinimized: false
    });

    let isProcessing = false;
    let lastProcessedUrl = '';
    let isInTicketingMode = false;
    let expandedTargetList = [];

    // Runtime variables for Alerts
    let visualInterval = null;
    let soundInterval = null;
    let alertAudio = new Audio(ALERT_SOUND_URL);

    function generateTargetList() {
        let list = [];
        if (!CONFIG.targetDatesConfig) return [];
        CONFIG.targetDatesConfig.forEach(item => {
            if (typeof item === 'string') {
                list.push(item);
            } else if (typeof item === 'object' && item.start && item.end) {
                let current = new Date(item.start + "T12:00:00");
                const stop = new Date(item.end + "T12:00:00");
                while (current <= stop) {
                    list.push(current.toISOString().split('T')[0]);
                    current.setDate(current.getDate() + 1);
                }
            }
        });
        return [...new Set(list)].sort();
    }

    expandedTargetList = generateTargetList();

    function saveState() {
        GM_setValue('scraper_state', state);
    }

    function addLog(msg) {
        const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
        state.logs.unshift(`[${timestamp}] ${msg}`);
        if (state.logs.length > CONFIG.historyLines) state.logs.pop();
        saveState();
        updateUI();
    }

    // --- Alert Functions (Fixed for 1s Interval) ---
    function startAlert() {
        if (visualInterval) return; // Already running

        // 1. Play Sound Immediately & Loop every 1s
        const playSound = () => {
            alertAudio.currentTime = 0;
            alertAudio.play().catch(e => console.log("Audio play blocked:", e));
        };
        playSound();
        soundInterval = setInterval(playSound, 1000); // 1 Second Interval

        // 2. Flash Panel Visuals (Fast flash)
        const panelBody = document.querySelector('#ac-scraper-panel > div');
        let isRed = false;
        visualInterval = setInterval(() => {
            if (panelBody) {
                panelBody.style.borderColor = isRed ? '#93141d' : 'red';
                panelBody.style.backgroundColor = isRed ? 'white' : '#ffe6e6';
                panelBody.style.boxShadow = isRed ? '0 4px 12px rgba(0,0,0,0.25)' : '0 0 30px red';
            }
            isRed = !isRed;
        }, 500);
    }

    function stopAlert() {
        if (visualInterval) { clearInterval(visualInterval); visualInterval = null; }
        if (soundInterval) { clearInterval(soundInterval); soundInterval = null; }

        alertAudio.pause();
        alertAudio.currentTime = 0;

        // Reset Panel Styles
        const panelBody = document.querySelector('#ac-scraper-panel > div');
        if (panelBody) {
            panelBody.style.borderColor = '#93141d';
            panelBody.style.backgroundColor = 'white';
            panelBody.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
        }
    }

    // --- UI Creation ---
    const panel = document.createElement('div');
    panel.id = 'ac-scraper-panel';
    panel.style.cssText = "position:fixed; bottom:10px; right:10px; z-index:99999; font-family:Arial, sans-serif; font-size:12px;";
    document.body.appendChild(panel);

    function renderPanel() {
        if (state.isMinimized) {
            panel.innerHTML = `
                <div id="ac-min-btn" style="width:40px; height:40px; background:#93141d; color:white; border-radius:4px; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 8px rgba(0,0,0,0.3);" title="Expand Scraper">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <div style="width:20px; height:2px; background:white;"></div>
                        <div style="width:20px; height:2px; background:white;"></div>
                        <div style="width:20px; height:2px; background:white;"></div>
                    </div>
                </div>
            `;
            const btn = document.getElementById('ac-min-btn');
            if (btn) btn.onclick = () => {
                state.isMinimized = false;
                saveState();
                renderPanel();
                updateUI();
            };
        } else {
            panel.innerHTML = `
                <div style="background:white; border:2px solid #93141d; width:340px; box-shadow:0 4px 12px rgba(0,0,0,0.25); border-radius:4px; display:flex; flex-direction:column;">
                    <div style="background:#93141d; color:white; padding:8px 10px; display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-weight:bold;">AC Scraper v2.9</span>
                        <button id="btn-minimize" style="background:transparent; border:none; color:white; font-weight:bold; cursor:pointer; font-size:16px;">_</button>
                    </div>
                    <div style="padding:10px;">
                        <div id="status-area" style="background:#f0f0f0; padding:8px; margin-bottom:8px; border-radius:4px; border-left:4px solid #555;"></div>

                        <div id="stats-area" style="background:#e6f7ff; padding:6px; margin-bottom:8px; border-radius:4px; border:1px solid #91d5ff; font-size:11px;">
                            <div style="font-weight:bold; margin-bottom:2px; text-decoration:underline;">Lowest Price (Net):</div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:2px;">
                                <div><span style="color:#666">Econ:</span> <b id="stat-econ">---</b></div>
                                <div><span style="color:#666">Prem:</span> <b id="stat-prem">---</b></div>
                                <div><span style="color:#666">Biz:</span> <b id="stat-busi">---</b></div>
                            </div>
                        </div>

                        <div style="margin-bottom:5px; padding-bottom:5px;">
                             <div style="display:flex; gap:5px; align-items:center; margin-bottom:5px;">
                                <div>Start: <input type="date" id="start-date-input" style="width:95px; border:1px solid #ccc;"></div>
                                <div>Stop: <input type="date" id="stop-date-input" value="${CONFIG.defaultStopSearchDate}" style="width:95px; border:1px solid #ccc;"></div>
                            </div>
                        </div>

                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:5px; margin-bottom:5px;">
                            <button id="btn-manual" style="padding:5px; cursor:pointer; background:#eee; border:1px solid #999;">Manual Range</button>
                            <button id="btn-target" style="padding:5px; cursor:pointer; background:#d4edda; border:1px solid #28a745; font-weight:bold;">Target Loop (${expandedTargetList.length})</button>
                        </div>
                        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:5px; margin-bottom:8px;">
                            <button id="btn-resume" style="padding:4px; cursor:pointer; background:#eee; border:1px solid #999;">Resume</button>
                            <button id="btn-pause" style="padding:4px; cursor:pointer; background:#eee; border:1px solid #999;">Pause</button>
                            <button id="btn-download" style="padding:4px; cursor:pointer; background:#eee; border:1px solid #999;">CSV</button>
                        </div>

                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:5px; margin-bottom:8px;">
                             <button id="btn-sanitize" style="padding:4px; cursor:pointer; background:#fff8e1; border:1px solid #ffcc80; color:#d48806;">Sanitize DB</button>
                             <button id="btn-clear-progress" style="padding:4px; cursor:pointer; background:#fff8e1; border:1px solid #ffcc80; color:#d48806;">Clear Progress</button>
                        </div>

                        <hr style="border:0; border-top:1px solid #ccc; margin:5px 0;">
                        <div style="margin-bottom:8px;">
                            <button id="btn-clear-db" style="width:100%; padding:4px; cursor:pointer; background:#ffebeb; border:1px solid #ffbbbb; color:#d00; font-weight:bold;">Clear Entire Database</button>
                        </div>

                        <div style="border-top:1px solid #ccc; padding-top:5px;">
                            <div id="log-area" style="font-size:10px; height:90px; overflow-y:auto; color:#333; font-family:monospace;"></div>
                        </div>
                    </div>
                </div>
            `;

            document.getElementById('btn-minimize').onclick = () => {
                state.isMinimized = true;
                saveState();
                stopAlert(); // STOP SOUND AND FLASH ON MINIMIZE
                renderPanel();
            };
            document.getElementById('btn-manual').onclick = manualStart;
            document.getElementById('btn-target').onclick = targetListStart;
            document.getElementById('btn-resume').onclick = resumeSearch;
            document.getElementById('btn-pause').onclick = pauseSearch;
            document.getElementById('btn-download').onclick = downloadCSV;
            document.getElementById('btn-sanitize').onclick = sanitizeDB;
            document.getElementById('btn-clear-progress').onclick = clearProgress;
            document.getElementById('btn-clear-db').onclick = clearDB;

            if(state.startDate && document.getElementById('start-date-input')) document.getElementById('start-date-input').value = state.startDate;
            if(!document.getElementById('start-date-input').value) {
                 const t = new Date(); t.setDate(t.getDate()+1);
                 document.getElementById('start-date-input').value = t.toISOString().split('T')[0];
            }
        }
    }

    function updateUI() {
        if (document.getElementById('ac-scraper-panel').innerHTML === '') renderPanel();
        if (state.isMinimized) { renderPanel(); return; }

        const now = new Date();
        let nextRun = new Date(now);
        nextRun.setMinutes(0, 0, 0);
        let h = nextRun.getHours();
        let nextH = h + (CONFIG.autoIntervalHours - (h % CONFIG.autoIntervalHours));
        if (nextH <= h) nextH += CONFIG.autoIntervalHours;
        nextRun.setHours(nextH);

        if ((state.status === 'MANUAL' || state.status === 'TARGET_LOOP') && state.manualStartTime) {
            const manualEnd = state.manualStartTime + (CONFIG.manualTimeoutHours * 60 * 60 * 1000);
            while (nextRun.getTime() < manualEnd) {
                nextRun.setHours(nextRun.getHours() + CONFIG.autoIntervalHours);
            }
        }

        let statusText = state.status;
        let statusColor = '#000';
        let nextRunText = nextRun.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

        if (isInTicketingMode) {
            statusText = "TICKETING MODE";
            statusColor = '#007bff';
            nextRunText = "Paused (User Active)";
        } else if (state.status === 'FOUND_DEAL') {
            statusColor = 'red';
            nextRunText = "ALERT! (Deal)";
        } else if (state.status === 'TARGET_LOOP') {
            statusColor = 'green';
            nextRunText = "Ignored (Looping)";
        }

        const statusDiv = document.getElementById('status-area');
        if(statusDiv) {
            statusDiv.innerHTML = `
                <div style="display:flex; justify-content:space-between;">
                    <span><b>Status:</b> <span style="color:${statusColor}">${statusText}</span></span>
                    <span><b>Next Auto:</b> ${nextRunText}</span>
                </div>
                <div style="margin-top:4px;">
                    <b>Doing:</b> ${state.currentSearchDate || 'Idle'} <span style="float:right;"><b>Prog:</b> ${state.progress}</span>
                </div>
            `;
        }
        const logDiv = document.getElementById('log-area');
        if(logDiv) logDiv.innerHTML = state.logs.join('<br>');

        updateCheapestStatsUI();

        // Trigger Alert Logic in UI loop
        if (state.status === 'FOUND_DEAL') {
            startAlert();
        } else {
            stopAlert();
        }
    }

    function updateCheapestStatsUI() {
        const db = GM_getValue(CONFIG.databaseName, []);
        if(db.length === 0) {
             ['econ','prem','busi'].forEach(k => { if(document.getElementById(`stat-${k}`)) document.getElementById(`stat-${k}`).innerText = '---'; });
             return;
        }
        let minEcon = { p: Infinity, d: '' };
        let minPrem = { p: Infinity, d: '' };
        let minBusi = { p: Infinity, d: '' };

        db.forEach(r => {
            const parse = (val) => {
                if (!val || val === 'N/A') return Infinity;
                const num = parseInt(String(val).replace(/[^\d]/g, ''), 10);
                return (isNaN(num) || num < 50 || num > 100000) ? Infinity : num;
            };
            const eP = parse(r.econ); if(eP < minEcon.p) minEcon = { p: eP, d: r.date };
            const pP = parse(r.prem); if(pP < minPrem.p) minPrem = { p: pP, d: r.date };
            const bP = parse(r.busi); if(bP < minBusi.p) minBusi = { p: bP, d: r.date };
        });
        const fmtD = (dStr) => {
            if(!dStr) return '';
            const parts = dStr.split('-');
            return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
        };
        const setStat = (id, obj) => {
            const el = document.getElementById(id);
            if(el) el.innerHTML = obj.p !== Infinity ? `$${obj.p} <span style="font-weight:normal; font-size:9px">(${fmtD(obj.d)})</span>` : '-';
        };
        setStat('stat-econ', minEcon);
        setStat('stat-prem', minPrem);
        setStat('stat-busi', minBusi);
    }

    // --- Session Keeper ---
    setInterval(() => {
        const extendDialog = document.getElementById('extend-session-modal');
        if (extendDialog) {
            const continueBtn = document.querySelector('abc-dialog .continue-btn-wrapper button');
            if (continueBtn && continueBtn.innerText.includes('Continue')) {
                addLog("Session Timeout detected. Clicking Continue...");
                continueBtn.click();
            }
        }
    }, 10000);

    // --- Core Scraper Loop ---
    function isPageWhitelisted(url) {
        const safePatterns = [
            '/home/ca/en/aco/flights',
            '/booking/ca/en/aco/search',
            '/booking/ca/en/aco/availability',
            '/booking/ca/en/aco/no-flights-found',
            '/booking/ca/en/aco/error'
        ];
        return safePatterns.some(pattern => url.includes(pattern));
    }

    setInterval(() => {
        const currentUrl = window.location.href;

        if (!isPageWhitelisted(currentUrl)) {
            if (!isInTicketingMode) {
                isInTicketingMode = true;
                updateUI();
            }
            return;
        } else {
            if (isInTicketingMode) {
                isInTicketingMode = false;
                addLog("Resume from Ticketing Mode");
                updateUI();
            }
        }

        if (state.status !== 'TARGET_LOOP') {
            checkAutoSchedule();
        }

        if (['MANUAL', 'AUTO', 'TARGET_LOOP'].includes(state.status) && !isProcessing) {
            if (currentUrl.includes('/availability/')) {
                const flightRows = document.querySelectorAll('ac-ui-avail-flight-row-pres');
                if (flightRows && flightRows.length > 0) {
                    if (currentUrl !== lastProcessedUrl) {
                        isProcessing = true;
                        lastProcessedUrl = currentUrl;
                        addLog(`Loaded ${flightRows.length} flights. Verifying...`);
                        setTimeout(() => verifyAndExtract(flightRows, currentUrl), 1500);
                    }
                }
            }
            if (currentUrl.includes('/no-flights-found') || currentUrl.includes('/error')) {
                 if (currentUrl !== lastProcessedUrl) {
                    isProcessing = true;
                    lastProcessedUrl = currentUrl;
                    addLog("No flights/Error. Skipping.");
                    setTimeout(() => moveToNextDate(), 2000);
                 }
            }
        }

        if (!state.isMinimized) updateUI();

    }, 1000);

    function checkAutoSchedule() {
        if (state.status === 'FOUND_DEAL') return;
        const now = new Date();
        const currentHour = now.getHours();

        if (currentHour % CONFIG.autoIntervalHours === 0 && now.getMinutes() < 1) {
            const lastRunDate = new Date(state.nextAutoRunTimestamp);
            if (lastRunDate.getHours() !== currentHour || lastRunDate.getDate() !== now.getDate()) {
                if (['MANUAL'].includes(state.status)) {
                    if (!state.logs[0] || !state.logs[0].includes("Auto search skipped")) {
                        addLog("Auto search skipped (Manual Active)");
                    }
                } else {
                    state.status = 'AUTO';
                    state.nextAutoRunTimestamp = now.getTime();
                    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
                    state.currentSearchDate = tomorrow.toISOString().split('T')[0];
                    state.startDate = state.currentSearchDate;
                    state.stopDate = CONFIG.defaultStopSearchDate;
                    addLog("Auto Batch Started");
                    startSearching();
                }
            }
        }
    }

    function startSearching() {
        if (!state.currentSearchDate) return;
        isProcessing = false;

        if (state.status === 'TARGET_LOOP') {
             state.progress = `${state.targetIndex + 1}/${expandedTargetList.length} (Loop)`;
             saveState();
        } else {
            updateProgressString(state.currentSearchDate, state.startDate, state.stopDate);
        }

        addLog(`Searching: ${state.currentSearchDate}`);
        window.location.href = getSearchURL(state.currentSearchDate);
    }

    function getSearchURL(dateStr) {
        const parts = dateStr.split('-');
        const year = parts[0];
        const month = parts[1];
        const day = parts[2];
        const formattedDate = `${day}/${month}/${year}`;
        const p = CONFIG.searchParams;
        return `https://www.aircanada.com/booking/ca/en/aco/search?org0=${p.org}&dest0=${p.dest}&orgType0=${p.orgType}&destType0=${p.destType}&departureDate0=${formattedDate}&adt=${p.adt}&yth=${p.yth}&chd=${p.chd}&inf=${p.inf}&ins=${p.ins}&marketCode=INT&tripType=OneWay&isFlexible=false`;
    }

    function getPrice(row, cabinName) {
        const cabins = row.querySelectorAll('.cabin-fare-container');
        for (let c of cabins) {
            const btn = c.querySelector('button');
            if (btn && btn.getAttribute('aria-label') && btn.getAttribute('aria-label').includes(cabinName)) {
                const visibleSpan = btn.querySelector('.cabin-price > span[aria-hidden="true"]');
                const textToClean = visibleSpan ? visibleSpan.innerText : (btn.querySelector('.cabin-price')?.innerText || '');
                const cleanPrice = textToClean.replace(/[^\d]/g, '');
                if (cleanPrice && cleanPrice.length > 0) return cleanPrice;
            }
        }
        return 'N/A';
    }

    function verifyAndExtract(rows, pageUrl) {
        const targetParts = state.currentSearchDate.split('-');
        const targetDay = parseInt(targetParts[2]);
        const dateElement = document.querySelector('.city-pairing-label .date') || document.querySelector('.bound-summary .date') || document.querySelector('ac-ui-city-pairing + .date');

        if (dateElement) {
            const pageDateText = dateElement.innerText;
            const dayMatch = pageDateText.match(/(\d+)$/);
            if (dayMatch) {
                const pageDay = parseInt(dayMatch[1]);
                if (pageDay !== targetDay) {
                    addLog(`MISMATCH: Target ${targetDay}, Page ${pageDay}. Reloading...`);
                    window.location.href = getSearchURL(state.currentSearchDate);
                    return;
                }
            }
        }
        extractAndSave(rows, pageUrl);
    }

    function extractAndSave(rows, pageUrl) {
        let records = [];
        let foundDeal = false;

        // 先搵出呢一頁入面所有航班嘅最低價
        let pageMinEcon = 99999;
        let pageMinPrem = 99999;
        let pageMinBusi = 99999;
        const correctSearchLink = getSearchURL(state.currentSearchDate);

        rows.forEach(row => {
            const stopElems = row.querySelectorAll('.stop-details .airport-location-code');
            let stopsArray = [];
            stopElems.forEach(el => { if (el.innerText) stopsArray.push(el.innerText.trim()); });
            if (stopsArray.length === 0) stopsArray.push('DIRECT');

            const hasUS = stopsArray.some(code => CONFIG.usAirportCodes.has(code));
            if (hasUS) return;

            const stopString = stopsArray.join('-');
            const econPrice = getPrice(row, 'Economy');
            const premPrice = getPrice(row, 'Premium Economy');
            const busiPrice = getPrice(row, 'Business Class');

            const eVal = parseInt(econPrice) || 99999;
            const pVal = parseInt(premPrice) || 99999;
            const bVal = parseInt(busiPrice) || 99999;

            if (eVal < pageMinEcon) pageMinEcon = eVal;
            if (pVal < pageMinPrem) pageMinPrem = pVal;
            if (bVal < pageMinBusi) pageMinBusi = bVal;

            if (eVal < CONFIG.priceThreshold) foundDeal = true;
            records.push({
                date: state.currentSearchDate,
                stop: stopsArray.join('-'),
                econ: econPrice, prem: premPrice, busi: busiPrice,
                timestamp: new Date().toISOString(),
                link: pageUrl
            });
        });
        if (records.length > 0) {
            processPriceUpdate(state.currentSearchDate, pageMinEcon, pageMinPrem, pageMinBusi);
        }
        const db = GM_getValue(CONFIG.databaseName, []);
        GM_setValue(CONFIG.databaseName, db.concat(records));
        addLog(`Found ${records.length} flights. Min: $${pageMinEcon}`);

        if (foundDeal) {
            state.status = 'FOUND_DEAL';
            saveState();
            // 執到雞就停低，唔跳下一日住
        } else {
            addLog("Redirecting in 1.5s...");
            setTimeout(() => {
                moveToNextDate();
            }, 30000);
        }
    }


    function moveToNextDate() {
        if (state.status === 'TARGET_LOOP') {
            state.targetIndex++;
            if (state.targetIndex >= expandedTargetList.length) {
                state.targetIndex = 0;
                addLog("Loop complete. Restarting.");
            }
            state.currentSearchDate = expandedTargetList[state.targetIndex];
            saveState();
            startSearching();

        } else {
            const currentStr = state.currentSearchDate;
            const stopStr = state.stopDate;
            if(!currentStr || !stopStr) { state.status = 'IDLE'; return; }
            const current = new Date(currentStr + "T12:00:00");
            const stop = new Date(stopStr + "T12:00:00");

            if (current >= stop) {
                state.status = 'IDLE'; state.currentSearchDate = null;
                addLog("Done. Returning Home.");
                saveState();
                window.location.href = "https://www.aircanada.com/";
                return;
            }
            current.setDate(current.getDate() + 1);
            state.currentSearchDate = current.toISOString().split('T')[0];
            startSearching();
        }
    }

    function updateProgressString(current, start, stop) {
        const dCurrent = new Date(current + "T12:00:00");
        const dStart = new Date(start + "T12:00:00");
        const dStop = new Date(stop + "T12:00:00");
        const total = Math.round((dStop - dStart) / (1000 * 60 * 60 * 24)) + 1;
        const done = Math.round((dCurrent - dStart) / (1000 * 60 * 60 * 24)) + 1;
        state.progress = `${done}/${total}`;
        saveState();
    }

    function downloadCSV() {
        const data = GM_getValue(CONFIG.databaseName, []);
        if (!data || data.length === 0) { alert("Database empty"); return; }

        let csv = "Date,Stop,Economy,Premium,Business,Time,Link\n";
        data.forEach(r => {
            const cEcon = String(r.econ).replace(/[^\d]/g, '') || 'N/A';
            const cPrem = String(r.prem).replace(/[^\d]/g, '') || 'N/A';
            const cBusi = String(r.busi).replace(/[^\d]/g, '') || 'N/A';
            const cLink = r.link || 'N/A';
            csv += `${r.date},${r.stop},${cEcon},${cPrem},${cBusi},${r.timestamp},${cLink}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `AC_data_${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(link);
        link.click();
    }

    function sanitizeDB() {
        const db = GM_getValue(CONFIG.databaseName, []);
        if (!db || db.length === 0) { alert("DB Empty"); return; }
        const before = db.length;
        const cleanDB = db.filter(r => {
            const check = (val) => {
                if(!val || val === 'N/A') return true;
                const n = parseInt(String(val).replace(/[^\d]/g, ''), 10);
                if (n < 50 || n > 50000) return false;
                return true;
            };
            return check(r.econ) && check(r.prem) && check(r.busi);
        });
        const removed = before - cleanDB.length;
        if(confirm(`Remove ${removed} bad records?`)) {
            GM_setValue(CONFIG.databaseName, cleanDB);
            addLog(`Sanitized ${removed} records.`);
            updateCheapestStatsUI();
        }
    }

    function targetListStart() {
        state.status = 'TARGET_LOOP';
        state.targetIndex = 0;
        state.currentSearchDate = expandedTargetList[0];
        state.manualStartTime = Date.now();
        addLog("Target Loop Started");
        startSearching();
    }

    function manualStart() {
        const s = document.getElementById('start-date-input').value;
        const e = document.getElementById('stop-date-input').value;
        if(!s) return alert("Set Start Date");
        state.status = 'MANUAL'; state.startDate = s; state.stopDate = e; state.currentSearchDate = s;
        state.manualStartTime = Date.now();
        addLog("Manual Started");
        startSearching();
    }

    function resumeSearch() {
        if(state.currentSearchDate) {
            if (state.status === 'IDLE' || state.status === 'PAUSED') state.status = 'MANUAL';
            addLog(`Resumed`);
            startSearching();
        }
    }

    function pauseSearch() { state.status = 'PAUSED'; addLog("Paused"); }
    function clearDB() { if(confirm("DANGER: Delete ALL data?")) { GM_setValue(CONFIG.databaseName, []); addLog("DB Cleared"); updateCheapestStatsUI(); }}
    function clearProgress() { state.status='IDLE'; state.progress='0/0'; state.currentSearchDate=null; saveState(); }

    renderPanel();
    updateUI();
})();
