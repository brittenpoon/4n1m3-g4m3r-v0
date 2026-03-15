// ==UserScript==
// @name         Jalan Helper - Auto Next & Intent Catcher
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  Tab isolation, infinite memory, manual click recovery, and auto "Next" within 1 min of batch open
// @author       Gemini
// @match        *://www.jalan.net/*
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // --- 0. Unique Tab ID Generation ---
    const TAB_ID = sessionStorage.getItem('JALAN_TAB_ID') || (() => {
        const id = "IT" + Math.random().toString(36).substring(2, 5).toUpperCase();
        sessionStorage.setItem('JALAN_TAB_ID', id);
        return id;
    })();

    // --- 0.1 Sync Logger for Debugging ---
    function logEvent(type, message, status = "info") {
        let logs = JSON.parse(localStorage.getItem("jalan_retry_logs") || "[]");
        const time = new Date().toLocaleTimeString('en-GB');

        logs.unshift({ time, type, message, tab: TAB_ID, status });
        if (logs.length > 100) logs.pop(); // 儲存多啲，但顯示會 Filter

        localStorage.setItem("jalan_retry_logs", JSON.stringify(logs));
        renderLogs();
    }

    function saveIntent(url) {
        if (!url || !url.startsWith('http') || url.includes("service_error")) return;
        const cleanUrl = url.split('#j_intent=')[0].split('&j_intent=')[0];
        sessionStorage.setItem("jalan_last_valid_url", cleanUrl);
    }

// --- 0.2 Universal Console Interceptor (Violentmonkey Optimized) ---
    (function() {
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const originalLog = win.console.log;

        // 使用 defineProperty 確保攔截器唔會被輕易 overwrite
        Object.defineProperty(win.console, 'log', {
            value: function(...args) {
                // 先執行原本嘅 log，等你在 DevTools 睇到嘢
                originalLog.apply(win.console, args);

                try {
                    const firstArg = args[0] ? args[0].toString() : "";

                    // 匹配 "開始日"
                    if (firstArg.includes("開始日")) {
                        // 尋找 Date 物件
                        const dateObj = args.find(arg =>
                            arg && (Object.prototype.toString.call(arg) === '[object Date]' || typeof arg.getTime === 'function')
                        );

                        if (dateObj) {
                            const label = firstArg.trim();
                            const subLabel = args[1] ? args[1].toString().trim() : "Unknown";
                            const eventName = `specialweek ${label} (${subLabel})`;
                            const eventTime = dateObj.getTime();

                            let schedule = JSON.parse(localStorage.getItem("jalan_all_schedule") || "[]");

                            // 避免重複
                            if (!schedule.some(s => s.name === eventName && s.time === eventTime)) {
                                schedule.push({ name: eventName, time: eventTime });
                                schedule.sort((a, b) => a.time - b.time);
                                localStorage.setItem("jalan_all_schedule", JSON.stringify(schedule));

                                // 即時觸發 UI 更新
                                if (window.updateScheduleUI) window.updateScheduleUI();

                                // 喺 Console 俾個成功提示你
                                originalLog.info(`%c[Jalan Helper] Captured: ${eventName}`, "color: #00ff00; font-weight: bold;");
                            }
                        }
                    }
                } catch (e) {
                    // 避免報錯干擾網頁運作
                }
            },
            configurable: true,
            writable: true
        });
    })();

    // --- 0.5 Tab-Specific Error Recovery (Runs instantly) ---
    const currentUrl = window.location.href;
    const isErrorPage = currentUrl.includes("service_error/index.html");
    const isLoginPage = currentUrl.includes("jit6001Login.do");

    if (isErrorPage) {
        let intendedUrl = null;

        const hashMatch = window.location.hash.match(/j_intent=([^&]+)/);
        if (hashMatch) {
            intendedUrl = decodeURIComponent(hashMatch[1]);
        }

        if (!intendedUrl) intendedUrl = sessionStorage.getItem("jalan_last_valid_url");

        if (intendedUrl && intendedUrl !== currentUrl && !intendedUrl.includes("service_error")) {
            sessionStorage.setItem("jalan_last_valid_url", intendedUrl);

            console.log(`[${TAB_ID}] Error detected. Recovering to: ${intendedUrl}`);
            logEvent("RETRYING", intendedUrl);

            sessionStorage.setItem("jalan_just_recovered", "true");

            setTimeout(() => {
                window.location.replace(intendedUrl);
            }, 1000);
        } else {
            console.warn(`[${TAB_ID}] No saved url found for this tab.`);
            logEvent("ERROR -> NO URL", currentUrl);
        }
    } else {
        if (sessionStorage.getItem("jalan_just_recovered") === "true") {
            logEvent("RECOVERED SUCCESS", currentUrl);
            sessionStorage.removeItem("jalan_just_recovered");
        }

        if (window.location.hash.includes('j_intent=')) {
            const cleanUrl = currentUrl.split('#j_intent=')[0].split('&j_intent=')[0];
            history.replaceState(null, "", cleanUrl);
        }

        saveIntent(currentUrl);
    }

    // --- 0.6 Preemptive Link & Button Capturing ---
    document.addEventListener('mousedown', (e) => {
        const link = e.target.closest('a');
        if (link && link.href && link.href.startsWith('http')) {
            const cleanUrl = link.href.split('#j_intent=')[0].split('&j_intent=')[0];
            saveIntent(cleanUrl);

            if (!link.href.includes('j_intent=')) {
                link.href = cleanUrl + (cleanUrl.includes('#') ? '&' : '#') + 'j_intent=' + encodeURIComponent(cleanUrl);
            }
            return;
        }

        const btn = e.target.closest('button, input[type="submit"], input[type="image"], input[type="button"]');
        if (btn) {
            const form = btn.closest('form');
            if (form && form.action && form.action.startsWith('http')) {
                const cleanAction = form.action.split('#j_intent=')[0].split('&j_intent=')[0];
                saveIntent(cleanAction);

                if (!form.action.includes('j_intent=')) {
                    form.action = cleanAction + (cleanAction.includes('#') ? '&' : '#') + 'j_intent=' + encodeURIComponent(cleanAction);
                }
            }
        }
    }, true);

    // --- 1. Database Initialization ---
    let db;
    const DB_VERSION = 3;
    const request = indexedDB.open("JalanPanelDB", DB_VERSION);

    request.onupgradeneeded = (e) => {
        db = e.target.result;
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains("auth")) db.createObjectStore("auth", { keyPath: "type" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };

    request.onsuccess = (e) => {
        db = e.target.result;
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            initApp();
        } else {
            window.addEventListener('DOMContentLoaded', initApp);
        }
    };

    function initApp() {
        createUI();
        handleAutoLogin();
        checkPageSpecifics();
        renderLogs();
        updateScheduleUI();
    }

// --- 2. UI Creation (已優化刷新結構) ---
    function createUI() {
        if (document.getElementById('jalan-helper-root')) return;

        const container = document.createElement('div');
        container.id = "jalan-helper-root";
        Object.assign(container.style, {
            position: 'fixed', bottom: '20px', right: '20px',
            zIndex: '2147483647', fontFamily: 'sans-serif'
        });

        const lockedUrl = sessionStorage.getItem("jalan_last_valid_url") || "None (Browsing)";

        container.innerHTML = `
            <style>
                #jalan-main-panel { background: #fff; border: 2px solid #ff6600; border-radius: 8px; width: 260px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); overflow: hidden; }
                .j-section { padding: 10px; border-bottom: 1px solid #eee; }
                .j-btn { cursor: pointer; background: #ff6600; color: #fff; border: none; padding: 5px; border-radius: 3px; font-size: 11px; width: 100%; margin-top: 5px; }
                .j-input { width: 100%; font-size: 11px; margin-bottom: 4px; border: 1px solid #ccc; padding: 3px; box-sizing: border-box; }
                #jalan-minimized { display: none; background: #ff6600; color: white; width: 40px; height: 40px; border-radius: 50%; text-align: center; line-height: 40px; cursor: pointer; font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.3); }
                .log-entry { font-size: 10px; margin-bottom: 5px; word-break: break-all; line-height: 1.3; border-bottom: 1px dotted #ccc; padding-bottom: 4px; }
                #jalan-log-list, #jalan-schedule-list { max-height: 120px; overflow-y: auto; background: #f9f9f9; border: 1px solid #ddd; padding: 5px; }
            </style>

            <div id="jalan-main-panel">
                <div style="background: ${isErrorPage ? '#dc3545' : '#ff6600'}; color: white; padding: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: bold; font-size: 12px;">Jalan Assistant <span style="font-size:9px; background:rgba(0,0,0,0.2); padding:2px; border-radius:3px;">${TAB_ID}</span></span>
                    <span id="btn-minimize" style="cursor: pointer; font-size: 18px; padding: 0 5px;">&minus;</span>
                </div>

                <div class="j-section" style="background: #fdfdfd; padding: 5px 10px;">
                    <span style="font-size: 9px; color: #666;">Locked URL:</span><br>
                    <span style="font-size: 10px; color: #007bff; word-break: break-all; line-height: 1.2;">${lockedUrl}</span>
                </div>

                <div class="j-section">
                    <b style="font-size: 11px;">10 DAYS SCHEDULE</b>
                    <div id="jalan-schedule-container" style="font-size: 10px; margin-top: 5px; background: #fffde7; padding: 5px; border: 1px solid #ffe082; border-radius: 3px;">
                        <div id="j-next-event-name" style="font-weight:bold; color:#007bff;">Loading...</div>
                        <div id="j-countdown-timer" style="color:#dc3545; font-size:14px; font-weight:bold; margin: 2px 0;">--d --h --m --s</div>
                        <div id="jalan-schedule-list" style="margin-top: 5px; border-top: 1px dotted #ccc; padding-top: 3px;"></div>
                    </div>
                </div>

                <div class="j-section" id="batch-actions" style="display:none;">
                    <b style="font-size: 11px;">RESERVATION TOOLS</b>
                    <div id="wrapper-open-all" style="display:none;">
                        <button id="btn-open-all" class="j-btn" style="background: #007bff;">Open All 予約変更</button>
                    </div>
                </div>

                <div class="j-section" id="auth-section" style="display: ${isLoginPage ? 'block' : 'none'};">
                    <b style="font-size: 11px;">CREDENTIALS</b>
                    <input type="text" id="db-user" class="j-input" placeholder="Email">
                    <input type="password" id="db-pass" class="j-input" placeholder="Password">
                    <button id="save-auth" class="j-btn">Save Login</button>
                </div>

                <div class="j-section">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <b style="font-size: 11px;">HISTORY</b>
                        <span id="clear-logs" style="font-size: 10px; color: #007bff; cursor: pointer; text-decoration: underline;">Clear</span>
                    </div>
                    <div id="jalan-log-list"></div>
                </div>
            </div>
            <div id="jalan-minimized" style="background: ${isErrorPage ? '#dc3545' : '#ff6600'};">☰</div>
        `;

        document.body.appendChild(container);
        /* ... 其餘事件綁定代碼 ... */
        const mainPanel = document.getElementById('jalan-main-panel');
        const miniIcon = document.getElementById('jalan-minimized');
        const setUIState = (isMinimized) => {
            if (isMinimized) { mainPanel.style.display = 'none'; miniIcon.style.display = 'block'; }
            else { mainPanel.style.display = 'block'; miniIcon.style.display = 'none'; }
            db.transaction("settings", "readwrite").objectStore("settings").put({ key: "minimized", value: isMinimized });
        };
        db.transaction("settings", "readonly").objectStore("settings").get("minimized").onsuccess = (e) => {
            if (e.target.result) setUIState(e.target.result.value);
        };
        document.getElementById('btn-minimize').onclick = () => setUIState(true);
        miniIcon.onclick = () => setUIState(false);
        document.getElementById('clear-logs').onclick = () => {
            let allLogs = JSON.parse(localStorage.getItem("jalan_retry_logs") || "[]");
            localStorage.setItem("jalan_retry_logs", JSON.stringify(allLogs.filter(l => l.tab !== TAB_ID)));
            renderLogs();
        };
        if (isLoginPage) { document.getElementById('save-auth').onclick = saveAuth; loadAuthToUI(); }
    }

    // --- 2.8 Schedule Countdown UI ---
    function updateScheduleUI() {
        const nameEl = document.getElementById('j-next-event-name');
        const timerEl = document.getElementById('j-countdown-timer');
        const listEl = document.getElementById('jalan-schedule-list');
        if (!nameEl || !timerEl || !listEl) return;

        let lastScheduleJson = "";

        setInterval(() => {
            try {
                const rawData = localStorage.getItem("jalan_all_schedule");
                if (!rawData) {
                    nameEl.innerText = "No Schedule";
                    return;
                }

                const schedule = JSON.parse(rawData);
                const now = Date.now();

                // 只有當日程資料有變動時，才刷新下方的列表 (避免影響滾動)
                if (rawData !== lastScheduleJson) {
                    listEl.innerHTML = schedule.map(ev => {
                        const dateObj = new Date(ev.time);
                        const isPast = ev.time < now;
                        const timeStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${dateObj.getHours().toString().padStart(2, '0')}:${dateObj.getMinutes().toString().padStart(2, '0')}`;
                        const style = isPast ? 'color: #bbb; text-decoration: line-through;' : 'color: #333;';
                        return `<div style="${style}">• ${ev.name} (${timeStr})</div>`;
                    }).join('');
                    lastScheduleJson = rawData;
                }

                // 尋找下一個 Event
                const nextEvent = schedule.find(s => s.time > now);

                if (nextEvent) {
                    const diff = nextEvent.time - now;
                    const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
                    const m = Math.floor((diff / 1000 / 60) % 60);
                    const s = Math.floor((diff / 1000) % 60);

                    // 使用 .innerText 僅更新文字，不破毀 DOM，不會影響選取
                    if (nameEl.innerText !== "Next: " + nextEvent.name) {
                        nameEl.innerText = "Next: " + nextEvent.name;
                    }
                    timerEl.innerText = `${d}d ${h}h ${m}m ${s}s`;
                } else {
                    nameEl.innerText = "All events ended.";
                    timerEl.innerText = "--d --h --m --s";
                }
            } catch(e) { console.error("UI Update Error", e); }
        }, 1000);
    }

    function renderLogs() {
        const list = document.getElementById('jalan-log-list');
        if (!list) return;

        const allLogs = JSON.parse(localStorage.getItem("jalan_retry_logs") || "[]");
        // --- 核心改動：只顯示屬於呢個 TAB_ID 嘅 Log ---
        const myLogs = allLogs.filter(l => l.tab === TAB_ID);

        list.innerHTML = myLogs.map(l => {
            let color = "#333";
            if (l.status === "error") color = "#dc3545";
            if (l.status === "success") color = "#28a745";
            if (l.status === "warn") color = "#fd7e14";

            return `<div class="log-entry" style="color: ${color}; border-bottom: 1px dotted #eee; padding: 2px 0; font-size: 10px;">
                [${l.time}] <b>${l.type}</b>: ${l.message}
            </div>`;
        }).join('');
    }

    // --- Page F 專屬邏輯 ---
    function handleCouponBulkPage() {
        console.log(`[${TAB_ID}] Advanced Collector active...`);

        const scanData = () => {
            let ids = [];
            let startTime = null;

            // --- Layout 1: theme/coupon/general (Page F) ---
            const generalIds = Array.from(document.querySelectorAll('input.js-disCouponId')).map(i => i.value);
            if (generalIds.length > 0) ids = generalIds;

            // --- Layout 2: discountCoupon/CAM... (CAM Page) ---
            if (ids.length === 0) {
                const camLinks = document.querySelectorAll('a[href^="javascript:doGetCoupon"]');
                camLinks.forEach(link => {
                    const match = link.href.match(/'([^']+)'/);
                    if (match) ids.push(match[1]);
                });
                // 提取 CAM 頁面時間
                const td = Array.from(document.querySelectorAll('td')).find(el => el.innerText.includes('配布期間'));
                if (td && td.nextElementSibling) {
                    startTime = parseJalanDateString(td.nextElementSibling.innerText.split('～')[0]);
                }
            }

            // --- Layout 3: theme/coupon/kikaku (Kikaku Page) ---
            if (ids.length === 0) {
                const kikakuIds = Array.from(document.querySelectorAll('.js-disCouponId')).map(i => i.value);
                if (kikakuIds.length > 0) ids = kikakuIds;
            }

            if (ids.length > 0) {
                console.log(`[${TAB_ID}] Detected IDs:`, ids);
                updateBulkButtonInPanel(ids, startTime);
            } else {
                setTimeout(scanData, 1500);
            }
        };

        scanData();
    }

    // 輔助：解析 "2025年5月20日(火)10:00" 格式
    function parseJalanDateString(str) {
        const match = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*(\d{2}:\d{2})/);
        if (match) {
            return new Date(`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}T${match[4]}:00+0900`).getTime();
        }
        return null;
    }

    // 喺 Panel 加入呢粒掣
    function updateBulkButtonInPanel(ids, startTime) {
        const batchSection = document.getElementById('batch-actions');
        if (!batchSection) return;

        batchSection.style.display = 'block';

        const openAllWrapper = document.getElementById('wrapper-open-all');
        if (openAllWrapper) openAllWrapper.style.display = 'none';

        if (document.getElementById('btn-super-bulk')) return;

        // 1. 手動按鈕
        const btn = document.createElement('button');
        btn.id = 'btn-super-bulk';
        btn.className = 'j-btn';
        btn.style.background = '#28a745';
        btn.innerText = `Super Bulk Get (${ids.length})`;
        btn.onclick = () => executeSuperBulkGet(ids);
        batchSection.appendChild(btn);

        // 2. 自動調度邏輯
        if (startTime) {
            const timeToStart = startTime - Date.now();
            if (timeToStart > 0) {
                logEvent("SCHEDULE", `Auto-get in ${Math.round(timeToStart/1000)}s`, "warn");
                setTimeout(() => {
                    logEvent("AUTO TRIGGER", "Executing scheduled bulk get!", "success");
                    executeSuperBulkGet(ids);
                }, timeToStart);
            } else {
                logEvent("INFO", "Distribution already started.", "info");
            }
        }
    }
    // 執行一鍵領取 API
async function executeSuperBulkGet(ids) {
        const apiKey = "ari190d9149699";
        const SYSTEM_RETRY_CODES = ['F_MAS5033', 'W_MRS0003', 'BUSY'];
        const INVALID_ID_CODE = "W_MUW7961"; // Code for "Invalid Coupon ID at index X"
        const MAX_BATCH_SIZE = 20;

        // 1. Chunk IDs into groups of 20
        let batches = [];
        for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
            batches.push(ids.slice(i, i + MAX_BATCH_SIZE));
        }

        logEvent("BULK START", `Processing ${ids.length} coupons in ${batches.length} batches...`, "info");

        for (let i = 0; i < batches.length; i++) {
            let currentBatch = batches[i]; // Use 'let' because we might modify it
            let batchSuccess = false;
            let retryCount = 0;
            const maxRetries = 10;

            logEvent("BATCH", `Batch ${i + 1}/${batches.length} (Size: ${currentBatch.length})...`, "info");

            while (!batchSuccess && retryCount < maxRetries) {
                try {
                    const requestData = {
                        apiKey: apiKey,
                        couponInfo: currentBatch.map(id => ({ discountCouponId: id, cldmPermissionFlg: "0" })),
                        sendMailBulkFlg: "1"
                    };

                    const response = await fetch('/uw/uwa7200/uwa7214Bulk.do', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestData)
                    });
                    const data = await response.json();

                    // --- A. Handle Specific Poison Pill Error (Invalid ID) ---
                    if (data.result === "1" && data.errors?.[0]?.code === INVALID_ID_CODE) {
                        const errorMsg = data.errors[0].message;
                        // Extract the number from "11番目の割引クーポンID..."
                        const match = errorMsg.match(/(\d+)番目/);
                        if (match) {
                            const errorIndex = parseInt(match[1]) - 1; // Convert 1-based to 0-based
                            const badId = currentBatch[errorIndex];

                            logEvent("CLEANING", `Removing invalid ID: ${badId} at pos ${match[1]}`, "error");

                            // Remove the bad ID and immediately retry the loop with the smaller batch
                            currentBatch.splice(errorIndex, 1);
                            if (currentBatch.length === 0) break; // Batch is now empty
                            continue;
                        }
                    }

                    // --- B. Handle General System Busy Errors ---
                    if (data.result !== "0") {
                        const errorCode = data.errors?.[0]?.code || "UNKNOWN";
                        retryCount++;
                        const delay = errorCode === 'F_MAS5033' ? 5000 : 2000;

                        logEvent("SYS BUSY", `Batch ${i+1} Err: ${errorCode}. Retry ${retryCount}/${maxRetries} in ${delay/1000}s`, "warn");
                        await new Promise(res => setTimeout(res, delay));
                        continue;
                    }

                    // --- C. Parse Successful Coupon Results ---
                    if (data.couponInfo) {
                        data.couponInfo.forEach(info => {
                            const id = info.discountCouponId;
                            const resCode = info.couponResult;
                            let msg = (info.couponResultMessage || "").replace(/#lt;br#gt;|<br>|※/g, ' ').trim();

                            if (resCode === "0") logEvent("SUCCESS", `[${id}] Obtained`, "success");
                            else if (resCode === "1") logEvent("INFO", `[${id}] Already owned`, "warn");
                            else logEvent("FAIL", `[${id}] ${msg}`, "error");
                        });
                    }

                    batchSuccess = true;

                } catch (err) {
                    retryCount++;
                    logEvent("NET ERROR", `Attempt ${retryCount} failed. Waiting 5s...`, "error");
                    await new Promise(res => setTimeout(res, 5000));
                }
            }

            if (i < batches.length - 1) await new Promise(res => setTimeout(res, 1000));
        }
        logEvent("FINISH", "All batches processed.", "success");
    }

    // --- Page G function: Acquired Coupons List (uww7803.do) ---
    async function handleMasterBulkPage() {
        console.log(`%c[${TAB_ID}] Page G: Initializing Master Multi-Source Collector...`, "color: #007bff; font-weight: bold;");

        const searchFormJsUrl = '/theme/coupon/general/js/couponSearchForm.js';
        const masterMap = new Map();

        try {
            // 1. Scan the Search Form JS for all active area dictionaries
            const scriptText = await fetch(searchFormJsUrl).then(r => r.text());
            const pathRegex = /getJsonURL\s*=\s*(?:['"]|`)([^'"`]+\.json)/g;
            const jsonPaths = new Set();
            let match;
            while ((match = pathRegex.exec(scriptText)) !== null) jsonPaths.add(match[1]);

            // 2. Fetch all dictionaries concurrently
            await Promise.all(Array.from(jsonPaths).map(async (path) => {
                try {
                    const data = await (await fetch(path)).json();
                    if (data.couponList) {
                        data.couponList.forEach(item => {
                            if (item.couponID && item.couponID.trim() !== "") {
                                // --- ID Normalization Start ---
                                // Convert 'CCOU...' or other variations to standard 'COU...'
                                // This uses regex to find 'COU' and everything following it.
                                const normalizedMatch = item.couponID.match(/COU\d+/);
                                const finalId = normalizedMatch ? normalizedMatch[0] : item.couponID;
                                // --- ID Normalization End ---

                                if (!masterMap.has(finalId)) {
                                    masterMap.set(finalId, {
                                        id: finalId,
                                        name: item.couponName,
                                        source: path.split('/').pop(),
                                        originalId: item.couponID !== finalId ? item.couponID : null // Tracking for debug
                                    });
                                }
                            }
                        });
                    }
                } catch (e) {}
            }));

            const allFound = Array.from(masterMap.values());
            console.group(`[${TAB_ID}] Master Database: ${allFound.length} Unique Coupons`);
            console.table(allFound);
            console.groupEnd();

            // 3. Integrate with Super Bulk UI
            if (allFound.length > 0) {
                const ids = allFound.map(c => c.id);
                updateBulkUIForMaster(ids);
            }

        } catch (err) {
            console.error("Master extraction failed:", err);
        }
    }

    function updateBulkUIForMaster(ids) {
        const batchSection = document.getElementById('batch-actions');
        if (!batchSection) return;

        batchSection.style.display = 'block';
        // Hide Reservation Tools if visible
        const openAllWrapper = document.getElementById('wrapper-open-all');
        if (openAllWrapper) openAllWrapper.style.display = 'none';

        if (document.getElementById('btn-super-bulk-master')) return;

        const btn = document.createElement('button');
        btn.id = 'btn-super-bulk-master';
        btn.className = 'j-btn';
        btn.style.background = '#6f42c1'; // Purple to distinguish from Page F
        btn.innerText = `Super Bulk Get ALL (${ids.length})`;

        btn.onclick = () => {
            logEvent("MASTER ACTION", `Scanning and grabbing ${ids.length} potential coupons...`, "warn");
            executeSuperBulkGet(ids); // Reuses the same robust Logic from Page F
        };

        batchSection.appendChild(btn);
    }

// --- 3. Page Specific Logic (Background Tabs & Status) ---
    function checkPageSpecifics() {

        // --- Page A: Reservation List (Batch Opener) ---
        if (currentUrl.includes("uwp5100/uww5121.do")) {
            const batchSection = document.getElementById('batch-actions');
            const openAllWrapper = document.getElementById('wrapper-open-all');
            if (batchSection) batchSection.style.display = 'block';
            if (openAllWrapper) openAllWrapper.style.display = 'block';

            const btn = document.getElementById('btn-open-all');

            btn.onclick = () => {
                const links = Array.from(document.querySelectorAll('a.c-button--normally'))
                                   .filter(a => a.innerText.includes('予約変更'));

                const total = links.length;
                if (total === 0) return alert("No '予約変更' buttons found.");

                localStorage.setItem("jalan_batch_open_time", Date.now().toString());

                btn.disabled = true;
                let current = 0;
                btn.innerText = `Opening... (0/${total})`;

                const intervalId = setInterval(() => {
                    if (current >= total) {
                        clearInterval(intervalId);
                        btn.innerText = "Done!";
                        btn.style.background = "#28a745";

                        setTimeout(() => {
                            btn.innerText = "Open All 予約変更";
                            btn.style.background = "#007bff";
                            btn.disabled = false;
                        }, 3000);
                        return;
                    }

                    const targetUrl = links[current].href.split('#j_intent=')[0].split('&j_intent=')[0];
                    const safeUrl = targetUrl + (targetUrl.includes('#') ? '&' : '#') + 'j_intent=' + encodeURIComponent(targetUrl);

                    GM_openInTab(safeUrl, { active: false, insert: true });
                    current++;
                    btn.innerText = `Opening... (${current}/${total})`;

                }, 1000);
            };
        }

        // --- Page B: Modification Input Page (Auto Click '次へ') ---
        if (currentUrl.includes("uwp5100/uww5103init.do")) {
            const batchTime = localStorage.getItem("jalan_batch_open_time");

            if (batchTime && (Date.now() - parseInt(batchTime)) <= 180000) {
                const nextImg = document.querySelector('img[alt="次へ"], img[name="nx01"]');
                if (nextImg) {
                    console.log(`[${TAB_ID}] Within active batch window. Auto-clicking '次へ'...`);
                    setTimeout(() => {
                        nextImg.click();
                    }, 800);
                }
            }
        }

        // --- Page C: Coupon Application Page ---
        if (currentUrl.includes("uwp5100/uww5103next.do")) {
            console.log(`[${TAB_ID}] Coupon page detected. Starting Step 1...`);

            const wrapper = document.querySelector('.js-selectedCouponWrapper, .selectedCouponWrapper');

            if (!wrapper) {
                console.log(`[${TAB_ID}] Wrapper NOT found. Logging 'no applicable coupon'.`);
                logEvent("COUPON", "no applicable coupon");
                renderLogs(); // 更新 UI
            } else {
                console.log(`[${TAB_ID}] Wrapper found! Proceeding to Step 2...`);

                const listItems = wrapper.querySelectorAll('.selectedCouponList__item');
                const savedPrices = Array.from(listItems).map(li => {
                    const priceSpan = li.querySelector('.selectedCouponPrice');
                    return priceSpan ? (parseInt(priceSpan.textContent.replace(/[^0-9]/g, ''), 10) || 0) : 0;
                });

                console.log(`[${TAB_ID}] Extracted saved prices:`, savedPrices);
                logEvent("COUPON SAVED", savedPrices.map(p => p > 0 ? p : 'n/a').join(' | '));
                // 呢度唔需要 renderLogs()，因為 initApp() 隨後會 call 一次

                const changeBtn = wrapper.querySelector('.js-changeCouponBtn, .changeCouponBtn');
                if (changeBtn) {
                    console.log(`[${TAB_ID}] Found change button. Clicking it now!`);
                    changeBtn.click();

                    let attempts = 0;
                    const evalInterval = setInterval(() => {
                        attempts++;
                        console.log(`[${TAB_ID}] Polling attempt ${attempts}...`);

                        const selects = document.querySelectorAll('select[name="discountCouponListInfoValue"]');

                        if (selects.length > 0) {
                            const hasOptions = Array.from(selects).some(s => s.querySelector('option[data-coupon-price]'));

                            if (hasOptions) {
                                console.log(`[${TAB_ID}] Options found! Stopping poll and running comparison.`);
                                clearInterval(evalInterval);

                                let betterCouponFound = false;

                                selects.forEach((select, index) => {
                                    let highestAvailable = 0;
                                    const options = select.querySelectorAll('option[data-coupon-price]');

                                    options.forEach(opt => {
                                        const val = parseInt(opt.getAttribute('data-coupon-price'), 10) || 0;
                                        if (val > highestAvailable) highestAvailable = val;
                                    });

                                    const currentPrice = savedPrices[index] || 0;
                                    let comparisonText = highestAvailable > currentPrice ? "HIGHER" : (highestAvailable === currentPrice ? "SAME" : "LOWER");

                                    if (highestAvailable > currentPrice) betterCouponFound = true;

                                    console.log(`[${TAB_ID}] Slot ${index + 1}: Current (${currentPrice}) vs Highest (${highestAvailable}) => [${comparisonText}]`);
                                    logEvent("COMPARE", `Slot ${index + 1}: Cur ${currentPrice} vs Max ${highestAvailable} [${comparisonText}]`);
                                });

                                renderLogs(); // 強制即時更新 UI 面板

                                if (betterCouponFound) {
                                    console.log(`[${TAB_ID}] Higher coupon found! Triggering title flash.`);
                                    const originalTitle = document.title;
                                    let flashState = false;
                                    setInterval(() => {
                                        document.title = flashState ? "🚨 HIGHER COUPON! 🚨" : originalTitle;
                                        flashState = !flashState;
                                    }, 500);
                                }
                            }
                        }

                        if (attempts > 20) {
                            console.log(`[${TAB_ID}] Polling timed out after 10 seconds. Giving up.`);
                            clearInterval(evalInterval);
                            logEvent("COUPON ERROR", "Dropdown options failed to load in time.");
                            renderLogs(); // 更新 UI
                        }
                    }, 500);
                } else {
                    console.log(`[${TAB_ID}] ERROR: Change button not found!`);
                    logEvent("COUPON ERROR", "Change button not found.");
                    renderLogs(); // 更新 UI
                }
            }
        }

        // --- Page D: Global Theme Schedule Extractor ---
        if (currentUrl.includes("theme")) {
            console.log(`[${TAB_ID}] Theme page detected. Fetching all schedule sources...`);

            const now = new Date();
            const nowYear = now.getFullYear();
            const padMonth = String(now.getMonth() + 1).padStart(2, '0');

            // --- 1. Otoku 10 Days (保持背景 Fetch 邏輯) ---
            if (currentUrl.includes("otoku_10days")) {
                fetch('/theme/otoku_10days/js/close_coupon.js').then(r => r.text()).then(scriptText => {
                    const results = [];
                    const logMap = {};
                    const logRegex = /([^`\n:：]+)[：:]\s*\${([^}]+)}/g;
                    let m;
                    while ((m = logRegex.exec(scriptText)) !== null) { logMap[m[2].trim()] = m[1].trim().replace(/\\n/g, ''); }

                    Object.keys(logMap).forEach(v => {
                        const lowV = v.toLowerCase();
                        if (lowV.includes('start') && lowV.includes('date')) {
                            const pattern = v + "\\s*=[^`]*`\\$\\{nowYear\\}-\\$\\{padMonth\\}-([^\\+ `]+)";
                            const match = scriptText.match(new RegExp(pattern));
                            if (match) results.push({ name: `otoku_10days ${logMap[v]}`, time: new Date(`${nowYear}-${padMonth}-${match[1]}+0900`).getTime() });
                        }
                    });

                    let full = JSON.parse(localStorage.getItem("jalan_all_schedule") || "[]");
                    // 替換該主題的所有紀錄
                    full = full.filter(s => !s.name.includes("otoku_10days"));
                    localStorage.setItem("jalan_all_schedule", JSON.stringify([...full, ...results].sort((a, b) => a.time - b.time)));
                    if (typeof updateScheduleUI === 'function') updateScheduleUI();
                });
            }

            // --- 2. Special Week (清除舊數據，等待 Interceptor 捕捉) ---
            if (currentUrl.includes("specialweek")) {
                    console.log(`[${TAB_ID}] SpecialWeek detected. Waiting for Interceptor...`);

                    let full = JSON.parse(localStorage.getItem("jalan_all_schedule") || "[]");
                    // 清走舊嘅 specialweek 紀錄，達成 "Replace by new"
                    const filtered = full.filter(s => !s.name.includes("specialweek"));
                    localStorage.setItem("jalan_all_schedule", JSON.stringify(filtered));

                    // 唔使再 fetch HTML，因為攔截器會幫你搞掂晒
            }
        }

        // Page E: 處理連結還原 (專用於 otoku_10days)
        if (currentUrl.includes("otoku_10days")||currentUrl.includes("specialweek")) {
            console.log(`[${TAB_ID}] Link Revealer Active (Coupons & Banners)...`);
            const dbKey = "jalan_jot_link_db";
            let linkDB = JSON.parse(localStorage.getItem(dbKey) || "{}");

            const revealLinks = () => {
                let dbUpdated = false;

                // 輔助函數：處理單個元素的 儲存/還原 邏輯
                const processElement = (el, idKey) => {
                    const currentHref = el.getAttribute('href');
                    const isVoid = !currentHref || currentHref === "javascript:void(0)" || currentHref === "#";

                    // 1. 如果依家見到係真連結，儲存入 DB
                    if (!isVoid) {
                        if (linkDB[idKey] !== currentHref) {
                            linkDB[idKey] = currentHref;
                            dbUpdated = true;
                            console.log(`[${TAB_ID}] DB Saved: ${idKey} -> ${currentHref}`);
                        }
                    }
                    // 2. 如果係 void(0)，且 DB 有紀錄，強制還原
                    else if (isVoid && linkDB[idKey]) {
                        el.setAttribute('href', linkDB[idKey]);
                        el.setAttribute('target', '_blank');
                        el.classList.remove('closed'); // 移除 Jalan 常用嘅禁用樣式

                        // UI 反饋：Coupon 顯示標籤，Banner 顯示藍框
                        if (el.classList.contains('cpnitem__link')) {
                            const mask = el.querySelector('.close_mask');
                            if (mask && mask.innerText !== "REVEALED (Locked)") {
                                mask.innerText = "REVEALED (Locked)";
                                mask.style.background = "#007bff";
                                mask.style.color = "#fff";
                            }
                        } else {
                            // 為 Banner 加入藍色邊框標示已還原
                            el.style.outline = "2px solid #007bff";
                            el.style.outlineOffset = "-2px";
                        }
                    }
                };

                // 處理 Coupon 連結
                document.querySelectorAll('.cpnitem__link').forEach(el => {
                    const price = el.querySelector('.cpnitem__price-text')?.innerText.trim() || "";
                    const topText = el.closest('.cpnitem')?.querySelector('.cpnitem__top')?.innerText.trim() || "";
                    const stageLabel = el.closest('.cpnitem')?.querySelector('.cpnitem__stage_label')?.innerText.trim() || "";
                    const idKey = `cpn_${topText}_${stageLabel}_${price}`.replace(/\s+/g, '_');
                    processElement(el, idKey);
                });

                // 處理 Banner 區域連結 (檢查 href 為 void 後才還原)
                document.querySelectorAll('.banner_list a').forEach(el => {
                    const img = el.querySelector('img');
                    const alt = img?.getAttribute('alt') || "";
                    const src = img?.getAttribute('src')?.split('/').pop() || "";
                    // 以 alt 或圖片檔名作為 ID
                    const idKey = `bnr_${alt || src}`.replace(/\s+/g, '_');
                    processElement(el, idKey);
                });

                if (dbUpdated) localStorage.setItem(dbKey, JSON.stringify(linkDB));
            };

            // --- 強力監控模式 ---
            revealLinks();

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === "attributes" && mutation.attributeName === "href") {
                        if (mutation.target.getAttribute('href') === "javascript:void(0)") {
                            revealLinks();
                        }
                    }
                });
            });

            // 監控所有 Coupon 同 Banner 連結
            document.querySelectorAll('.cpnitem__link, .banner_list a').forEach(link => {
                observer.observe(link, { attributes: true });
            });

            // 首 3 秒快速修復
            let retryCount = 0;
            const fastFix = setInterval(() => {
                revealLinks();
                if (++retryCount > 6) clearInterval(fastFix);
            }, 500);
        }

        // --- Page F: Coupon General Bulk Collector ---
        if (currentUrl.includes("theme/coupon/") || currentUrl.includes("discountCoupon/")) {
            handleCouponBulkPage();
        }

        // --- Page G: Acquired Coupons Enhancer ---
        if (currentUrl.includes("uwp7800/uww7803.do")) {
            handleMasterBulkPage();
        }

        // --- Page H: Login Page (Credentials only) ---
        if (currentUrl.includes("ji/pc/jit6001Login.do")) {
            console.log(`[${TAB_ID}] Login page: Locking UI to Credentials.`);

            // Strictly control visibility
            const sections = {
                'auth-section': 'block',      // Show this
                'schedule-section': 'none',   // Hide others
                'batch-actions': 'none',
                'history-section': 'none'
            };

            Object.keys(sections).forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = sections[id];
            });

            // Start the Auto-Login process
            handleAutoLogin();
            return;
        }
    }

    // --- 4. Auto-Login Core ---
    function handleAutoLogin() {
        if (!isLoginPage) return;

        if (document.readyState !== 'complete') {
            window.addEventListener('load', executeLogin);
        } else {
            executeLogin();
        }

        function executeLogin() {
            const tx = db.transaction("auth", "readonly");
            tx.objectStore("auth").get("login").onsuccess = (e) => {
                const data = e.target.result;
                if (data?.email && data?.pass) {
                    const userField = document.querySelector('input[name="mainEmail"]');
                    const passField = document.querySelector('input[name="passwd"]');
                    const loginBtn = document.querySelector('input[name="fn_input"]');

                    if (userField && passField && loginBtn) {
                        userField.value = data.email;
                        passField.value = data.pass;
                        setTimeout(() => loginBtn.click(), 500);
                    }
                }
            };
        }
    }

    // --- 5. DB Helpers ---
    function saveAuth() {
        const email = document.getElementById('db-user').value;
        const pass = document.getElementById('db-pass').value;
        db.transaction("auth", "readwrite").objectStore("auth").put({ type: "login", email, pass });
        alert("Credentials saved.");
    }

    function loadAuthToUI() {
        db.transaction("auth", "readonly").objectStore("auth").get("login").onsuccess = (e) => {
            if (e.target.result) {
                document.getElementById('db-user').value = e.target.result.email;
                document.getElementById('db-pass').value = e.target.result.pass;
            }
        };
    }

})();
