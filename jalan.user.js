// ==UserScript==
// @name         Jalan Helper - Auto Next & Intent Catcher
// @namespace    http://tampermonkey.net/
// @version      3.6
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
/*
    function saveIntent(url) {
        if (!url || !url.startsWith('http') || url.includes("service_error")) return;
        const cleanUrl = url.split('#j_intent=')[0].split('&j_intent=')[0];
        sessionStorage.setItem("jalan_last_valid_url", cleanUrl);
    }
*/

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


  // --- 0.5 Infinite Watcher Logic (0.1s interval) ---

  const currentUrl = window.location.href;
  const isLoginPage = currentUrl.includes("jit6001Login.do");
  const isErrorPage = currentUrl.includes("error");

// --- 0.5 Infinite Watcher (3.3 Multi-Message Detection) ---
    let isRedirecting = false;

    const JALAN_WATCHER_ID = setInterval(() => {
        const loopActive = sessionStorage.getItem("jalan_loop_active") === "true";
        const lockedUrl = sessionStorage.getItem("jalan_last_valid_url");

        if (!loopActive || !lockedUrl) return;

        const nowUrl = window.location.href;
        const nowTitle = document.title;

        // --- 錯誤訊息清單 (可隨時增加) ---
        const errorMessages = [
            "情報の読み込みが正常に行えませんでした", // Modal 錯誤
            "該当ページが存在しません",               // 頁面不存在 (404 類)
            "セッションがタイムアウトしました",       // Session Timeout
            "アクセスが集中しています",                // Server Busy
            "Hmmm… can't reach this page"
        ];

        // 檢查頁面內容是否包含任一錯誤訊息
        const hasErrorInContent = document.body && errorMessages.some(msg => document.body.innerText.includes(msg));

        // 綜合判斷：URL、標題或內容
        const isError = nowUrl.includes("error") ||
                        nowUrl.includes("service_error") ||
                        nowTitle.includes("エラー") ||
                        nowTitle.includes("Error") ||
                        hasErrorInContent;

        // --- Soft Redirect 自我修復 ---
        if (!isError && isRedirecting) {
            isRedirecting = false;
            console.log(`[${TAB_ID}] Clean page detected. Watcher Unlocked.`);
        }

        // --- 觸發重試跳轉 ---
        if (isError && !isRedirecting) {
            isRedirecting = true;
            console.log(`[${TAB_ID}] 🚨 ERROR DETECTED: ${nowUrl}. Redirecting to Locked URL...`);

            // 停止所有當前加載
            window.stop();

            setTimeout(() => {
                window.location.replace(lockedUrl);
            }, 50);
        }
    }, 100);

    // 60 分鐘保護機制
    setTimeout(() => {
        sessionStorage.removeItem("jalan_loop_active");
        clearInterval(JALAN_WATCHER_ID);
    }, 3600000);

    function keepAlive() {
        if (document.getElementById('hidden-nosleep-video')) return;

        const video = document.createElement('video');
        video.id = 'hidden-nosleep-video';
        video.loop = true;
        video.muted = true;
        video.setAttribute('playsinline', '');
        video.style.display = 'none';

        // 使用一個極小的 Base64 影片檔（1秒空白影片）
        video.src = "data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAAzphdmMxAGIAYv//AAAAGmF2Y0MBYgBi//+AABp/+EAB9v6P8AAAABh0cmFrAAAAXHRraGQAAAAHAAAAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAABAAEAAAAAAZBtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB1MAAA1cAF1Zf///zgA";

        document.body.appendChild(video);

        // 必須由用戶觸發（例如你撳 SET & GO 嗰陣啟動）
        video.play().catch(e => console.log("Video Play Blocked: Need user interaction first."));
    }

  /*
    // --- 0.5 Tab-Specific Error Recovery (Runs instantly) ---
    if (isErrorPage) {
        const intendedUrl = sessionStorage.getItem("jalan_last_valid_url");

        if (intendedUrl) {
            console.log(`[${TAB_ID}] Error! Retrying Locked URL in 0.1s...`);
            // 使用 replace 防止在 history 堆疊產生大量 error 紀錄
            setTimeout(() => {
                window.location.replace(intendedUrl);
            }, 100);
        }
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
    */

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

window.addEventListener('storage', (e) => {
    // 監聽 REFRESH ALL 指令
    if (e.key === "jalan_cmd_refresh_all" && e.newValue) {
        const loopActive = sessionStorage.getItem("jalan_loop_active") === "true";
        const lockedUrl = sessionStorage.getItem("jalan_last_valid_url");

        // 核心判斷：只有當前 Tab 正在運行 Loop 時才響應刷新
        if (loopActive && lockedUrl) {
            console.log(`[${TAB_ID}] 收到全域刷新指令，執行 Reload...`);

            // 為了避免所有 Tab 同時請求導致 Server 封鎖，可以加一個極小的隨機延遲 (0-300ms)
            setTimeout(() => {
                window.location.reload();
            }, Math.random() * 300);
        } else {
            console.log(`[${TAB_ID}] 收到刷新指令，但此 Tab 未啟動 Loop，忽略。`);
        }
    }

    // 監聽 STOP ALL 指令 (如有需要)
    if (e.key === "jalan_cmd_stop_all") {
        sessionStorage.removeItem("jalan_loop_active");
        const statusEl = document.getElementById('loop-status');
        if (statusEl) statusEl.innerText = "Status: STOPPED";
    }
});

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
                <div class="j-section" style="background: #fff3cd; border: 1px solid #ffeeba; padding: 8px;">
                    <b style="font-size: 11px; color: #856404;">🔗 MANUAL URL LOCK</b>
                    <input type="text" style="display:none;" aria-hidden="true">
                    <input type="password" style="display:none;" aria-hidden="true">
                    <input type="text"
                           id="manual-locked-url"
                           name="no_fill_${Math.random().toString(36).substring(7)}"
                           autocomplete="new-password"
                           readonly
                           onfocus="this.removeAttribute('readonly');"
                           spellcheck="false"
                           style="width:100%; font-size: 11px; margin-top:5px; border:1px solid #ffe082; padding:5px; box-sizing:border-box; background: #fff;"
                           placeholder="Click to paste Booking URL..."
                           value="${sessionStorage.getItem("jalan_last_valid_url") || ""}">
                    <div style="display:flex; flex-direction:column; gap:3px; margin-top:3px;">
                        <div style="display:flex; gap:2px;">
                            <button id="btn-set-go" class="j-btn" style="background: #28a745; flex:2; font-weight:bold;">SET & GO</button>
                            <button id="btn-stop-loop" class="j-btn" style="background: #6c757d; flex:1;">STOP</button>
                        </div>
                        <button id="btn-refresh-all" class="j-btn" style="background: #007bff; font-weight:bold; margin-top:0;">REFRESH ALL ACTIVE TABS</button>
                    </div>
                    <div id="loop-status" style="font-size: 10px; margin-top: 5px; text-align:center; font-weight:bold;">Status: Ready</div>
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
        document.getElementById('btn-set-go').onclick = () => {
            const inputUrl = document.getElementById('manual-locked-url').value.trim();
            if (inputUrl.startsWith('http')) {
                sessionStorage.setItem("jalan_last_valid_url", inputUrl);
                sessionStorage.setItem("jalan_loop_active", "true");
                logEvent("LOOP START", "Target Locked: " + inputUrl, "success");
                isRedirecting = true;
                window.location.href = inputUrl;
            }
        };
        document.getElementById('btn-refresh-all').onclick = () => {
            console.log(`[${TAB_ID}] 发出全域刷新指令...`);
            localStorage.setItem("jalan_cmd_refresh_all", Date.now().toString());
            const loopActive = sessionStorage.getItem("jalan_loop_active") === "true";
            if (loopActive) {
                window.location.reload();
            }
        };
        document.getElementById('btn-stop-loop').onclick = () => {
            sessionStorage.removeItem("jalan_loop_active");
            localStorage.setItem("jalan_cmd_stop_all", Date.now().toString());
            document.getElementById('loop-status').innerText = "Status: Stopped";
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

        // --- Layout 4: Hotel Specific Coupon Page (Moved inside the logic flow) ---
        if (ids.length === 0 && currentUrl.includes("/yad") && currentUrl.includes("/coupon/")) {
            const hotelCouponItems = document.querySelectorAll('.cassetteList-list .item');
            hotelCouponItems.forEach(item => {
                const link = item.querySelector('.item-title a, .item-btnArea a');
                if (link) {
                    const idMatch = link.href.match(/discountCouponId=(COU\d+)/);
                    if (idMatch) {
                        const id = idMatch[1];
                        ids.push(id); // Push to the main 'ids' array

                        // Extract startTime if not already set (uses the first one found)
                        if (!startTime) {
                            const detailTexts = item.querySelectorAll('.item-detail');
                            detailTexts.forEach(detail => {
                                if (detail.querySelector('dt')?.innerText.includes('配布期間')) {
                                    const timeStr = detail.querySelector('dd')?.innerText.split('～')[0];
                                    startTime = parseJalanDateString(timeStr);
                                }
                            });
                        }
                    }
                }
            });
        }

        // Final Check and UI Update
        if (ids.length > 0) {
            // Deduplicate IDs just in case
            const uniqueIds = [...new Set(ids)];
            console.log(`[${TAB_ID}] Detected IDs:`, uniqueIds);
            updateBulkButtonInPanel(uniqueIds, startTime);
        } else {
            // Retry scanning if nothing found yet
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
            const maxRetries = 100;

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
                        const delay = errorCode === 'F_MAS5033' ? 1000 : 1000;

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
                    await new Promise(res => setTimeout(res, 1000));
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

function addDirectBookingButton() {
        const wrap = document.querySelector('.p-planOverview__reservationWrap');
        if (!wrap) return;

        // 避免重複添加按鈕
        if (document.getElementById('jalan-direct-booking-btn')) return;

        const originalBtn = wrap.querySelector('a[href^="JavaScript:onLogin"]');
        if (!originalBtn) return;

        // 1. 提取 onLogin 傳入的原始參數
        const paramsMatch = originalBtn.getAttribute('href').match(/onLogin\((.*?)\)/);
        if (!paramsMatch) return;

        // 參數順序: yyyy, mm, dd, totalPrice, campaignPoint, stgPoint, score, position, promotionPlanJudgeFlg
        const p = paramsMatch[1].split(',').map(s => s.trim().replace(/'/g, ""));
        const [yyyy, mm, dd, totalPrice, campaignPoint, stgPoint, score, position, promotionPlanJudgeFlg] = p;

        // 2. 假設已登入狀態，設置 ccnt 後綴為 _input
        const ccntPcYadPlan = "pc_yad_planDetail_yoyakuBtn" + (position || '') + "_input";

        // 3. 從當前 URL 提取 ID 類參數以確保準確性
        const urlParams = new URLSearchParams(window.location.search);
        const yadNo = urlParams.get('yadNo') || "327710";
        const planCd = urlParams.get('planCd') || "03545138";
        const roomTypeCd = urlParams.get('roomTypeCd') || "0483008";
        const roomCrack = urlParams.get('roomCrack') || "400000";
        const adultNum = urlParams.get('adultNum') || "4";
        const stayCount = urlParams.get('stayCount') || "1";
        const roomCount = urlParams.get('roomCount') || "1";

        // 4. 嚴格依照 onLogin 原始碼拼接 TEMP1 (使用 %2B 代表 + 和 %23 代表 #)
        let a1 = `yadNo%2B${yadNo}%23` +
                 `planCd%2B${planCd}%23` +
                 `stayYear%2B${yyyy}%23stayMonth%2B${mm}%23stayDay%2B${dd}%23` +
                 `rootCd%2B%23` +
                 `roomCount%2B${roomCount}%23` +
                 `stayCount%2B${stayCount}%23` +
                 `roomTypeCd%2B${roomTypeCd}%23` +
                 `dreportId%2B%23` +
                 `adultNum%2B${adultNum}%23` +
                 `child1Num%2B%23` +
                 `child2Num%2B%23` +
                 `child3Num%2B%23` +
                 `child4Num%2B%23` +
                 `child5Num%2B%23` +
                 `roomCrack%2B${roomCrack}%23` +
                 `afCd%2B%23` +
                 `dateUndecided%2B%23` +
                 `promotionPlanJudgeFlg%2B${promotionPlanJudgeFlg}%23` +
                 `ccnt%2B${ccntPcYadPlan}`;

        // 5. 組合成最終的 Login Redirect URL
        let finalUrl = `https://www.jalan.net/ji/pc/jit6001Login.do?` +
                       `TEMP1=${a1}` +
                       `&TEMP2=https://www.jalan.net/uw/uwp5200/uww5201init.do` +
                       `&TEMP4=LEVEL_R` +
                       `&TEMP5=https://www.jalan.net/uw/uwp5000/uww5001init.do` +
                       `&TEMP6=${campaignPoint}`;

        if (stgPoint) finalUrl += `&stgp=${stgPoint}`;
        if (score) finalUrl += `&score=${score}`;
        finalUrl += `&ccnt=${ccntPcYadPlan}`;

        // 6. 建立 UI 按鈕
        const btn = document.createElement('button');
        btn.id = 'jalan-direct-booking-btn';
        btn.innerText = "📋 Copy Direct Booking URL";
        btn.style.cssText = "display:block; width:100%; margin-top:10px; padding:10px; background:#28a745; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; font-family: sans-serif;";

        btn.onclick = (e) => {
            e.preventDefault();
            navigator.clipboard.writeText(finalUrl).then(() => {
                const originalText = btn.innerText;
                btn.innerText = "✅ URL Copied!";
                btn.style.background = "#155724";
                setTimeout(() => {
                    btn.innerText = originalText;
                    btn.style.background = "#28a745";
                }, 2000);
            });
        };

        wrap.appendChild(btn);
    }

function selectbookingdetail() {
    let attempts = 0;
    const maxAttempts = 10; // 500ms 一次，10 次即係 5 秒

    const interval = setInterval(() => {
        try {
            attempts++;
            console.log(`正在嘗試自動填表... (第 ${attempts} 次)`);

            // 1. 處理彈窗 (用文字定位)
            const allButtons = Array.from(document.querySelectorAll('button'));
            const continueButton = allButtons.find(btn => btn.textContent.trim() === '予約を続ける');
            if (continueButton) {
                continueButton.click();
                // 撳咗之後唔好即刻 Stop，俾下一次 Loop 嚟填表
                return;
            }

            // 2. 檢查關鍵元素是否存在 (用男人人數 Select 嚟做指標)
            const manSelect0 = document.querySelector('select[name="rsvInfoList[0].adultManNum"]');
            if (!manSelect0) {
                if (attempts >= maxAttempts) clearInterval(interval);
                return; // 仲未見到表單，跳去下一次 Loop
            }

            // --- 開始填表邏輯 ---

            // 偵測房數
            const roomCount = document.querySelectorAll('select[name$=".adultManNum"]').length;

            const setVal = (name, val) => {
                const el = document.querySelector(`select[name="${name}"]`);
                if (el) {
                    const exists = Array.from(el.options).some(o => o.value === String(val));
                    el.value = exists ? String(val) : el.options[el.options.length - 1].value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            };

            // 執行不同 Case
            if (roomCount === 1) {
                const maxMan = Math.max(...Array.from(manSelect0.options).map(o => parseInt(o.value) || 0));
                if (maxMan >= 3) {
                    setVal('rsvInfoList[0].adultManNum', 3);
                    setVal('rsvInfoList[0].adultWomanNum', 1);
                } else {
                    setVal('rsvInfoList[0].adultManNum', 1);
                    setVal('rsvInfoList[0].adultWomanNum', 1);
                }
            } else if (roomCount >= 2) {
                setVal('rsvInfoList[0].adultManNum', 1);
                setVal('rsvInfoList[0].adultWomanNum', 1);
                setVal('rsvInfoList[1].adultManNum', 2);
                setVal('rsvInfoList[1].adultWomanNum', 0);
            }

            // 其他通用項
            const checkin = document.querySelector('select[name="checkinTime"]');
            if (checkin) {
                checkin.value = "18:00";
                checkin.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const repay = document.querySelector('textarea[name="repay"]');
            if (repay) {
                repay.value = ".";
                repay.dispatchEvent(new Event('input', { bubbles: true }));
            }

            const localPay = document.querySelector('input[name="localPayCardFlg"][value="0"]');
            if (localPay) {
                localPay.checked = true;
                localPay.click();
            }

            // 如果行到呢度都無 Error，代表填表完成，可以停咗個 Interval
            console.log("自動填表完成！");
            clearInterval(interval);

        } catch (e) {
            console.error("嘗試填表時出錯:", e);
            if (attempts >= maxAttempts) clearInterval(interval);
        }
    }, 500); // 每 0.5 秒跑一次
}

function confirmbookingdetail() {
    let attempts = 0;
    const maxAttempts = 10; // 5秒內嘗試 (每 500ms 一次)

    const interval = setInterval(() => {
        try {
            attempts++;
            console.log(`正在嘗試提交預約... (第 ${attempts} 次)`);

            // 定義目標：包含 "予約を完了する" 字眼的 <a> 標籤
            const allLinks = Array.from(document.querySelectorAll('a.alert_button.reserve_button'));
            const finishButton = allLinks.find(a => a.textContent.includes('予約を完了する'));

            if (finishButton) {
                console.log("搵到確認按鈕，正在點擊...");
                // 由於佢係 <a href="#noMove" onclick="doNext()">，直接 click() 就會觸發 doNext()
                finishButton.click();

                clearInterval(interval);
                return;
            }

            if (attempts >= maxAttempts) {
                console.log("超過 5 秒未發現確認按鈕，停止嘗試。");
                clearInterval(interval);
            }
        } catch (e) {
            console.error("confirmbookingdetail 執行出錯:", e);
            if (attempts >= maxAttempts) clearInterval(interval);
        }
    }, 500);
}

function editduplicatenext() {
    let attempts = 0;
    const maxAttempts = 20; // 5秒內嘗試

    const interval = setInterval(() => {
        try {
            attempts++;
            console.log(`正在嘗試點擊繼續... (第 ${attempts} 次)`);

            // 1. 透過圖片的 alt 屬性定位
            const continueImg = document.querySelector('img[alt="続ける"]');

            if (continueImg) {
                const continueLink = continueImg.closest('a');
                if (continueLink) {
                    console.log("搵到「続ける」按鈕，正在點擊...");
                    continueLink.click();
                    clearInterval(interval);

                }
            }

            // 2. 備用方案：如果 img 定位唔到，試吓搵 onclick 包含 doNext 的連結
            const allLinks = Array.from(document.querySelectorAll('a[onclick]'));
            const doNextLink = allLinks.find(a => a.getAttribute('onclick').includes('doNext'));

            if (doNextLink) {
                console.log("透過 onclick 定位到繼續按鈕，正在點擊...");
                doNextLink.click();
                clearInterval(interval);
                return;
            }

            if (attempts >= maxAttempts) {
                console.log("超過 5 秒未發現繼續按鈕。");
                clearInterval(interval);
            }
        } catch (e) {
            console.error("editduplicatenext 執行出錯:", e);
            if (attempts >= maxAttempts) clearInterval(interval);
        }
    }, 500);
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

                    const targetUrl = links[current].href;
                    const lockableUrl = targetUrl + "#j_lock=" + encodeURIComponent(targetUrl);

                    console.log(`[${TAB_ID}] Opening with Lock Intent: ${lockableUrl}`);
                    GM_openInTab(lockableUrl, { active: false, insert: true });
                    current++;
                    btn.innerText = `Opening... (${current}/${total})`;
                    renderLogs();

                }, 1000);
            };
            keepAlive();
            logEvent("RELOAD", "Refreshing in "+ 60+ "s" , "warn");
            renderLogs();
            setInterval(() => {
                window.location.reload();
            }, 60000);
        }

        // --- Page B: Modification Input Page (Auto Click '次へ') ---
        if (currentUrl.includes("uwp5100/uww5103init.do")) {
            const batchTime = localStorage.getItem("jalan_batch_open_time");

            const hashMatch = window.location.hash.match(/j_lock=([^&]+)/);
            if (hashMatch) {
                const inputUrl = decodeURIComponent(hashMatch[1]);
                sessionStorage.setItem("jalan_last_valid_url", inputUrl);
                sessionStorage.setItem("jalan_loop_active", "true");
                logEvent("AUTO LOCK", "Tab locked to: " + inputUrl, "success");

                history.replaceState(null, "", window.location.href.split('#')[0]);
            }

            if (batchTime && (Date.now() - parseInt(batchTime)) <= 60000) {
                const nextImg = document.querySelector('img[alt="次へ"], img[name="nx01"]');
                if (nextImg) {
                    console.log(`[${TAB_ID}] Within active batch window. Auto-clicking '次へ'...`);
                    setTimeout(() => {
                        nextImg.click();
                    }, 800);
                }
            }
            keepAlive();
        }

        // --- Page C: Coupon Application Page ---
        if (currentUrl.includes("uwp5100/uww5103next.do")) {
            editduplicatenext();
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

                                    if (highestAvailable > currentPrice) {
                                        betterCouponFound = true;
                                        const currentAmt = currentPrice;
                                        const highestAmt = highestAvailable;
                                    }

                                    console.log(`[${TAB_ID}] Slot ${index + 1}: Current (${currentPrice}) vs Highest (${highestAvailable}) => [${comparisonText}]`);
                                    logEvent("COMPARE", `Slot ${index + 1}: Cur ${currentPrice} vs Max ${highestAvailable} [${comparisonText}]`);
                                });

                                renderLogs(); // 強制即時更新 UI 面板
                                keepAlive();

                                if (betterCouponFound) {
                                    console.log(`[${TAB_ID}] Higher coupon found! Triggering title flash.`);
                                    // --- Discord 通知專用函數 ---
                                    async function notifyDiscord(currentAmt, highestAmt) {
                                        const DISCORD_URL = "https://discordapp.com/api/webhooks/1484590933965148351/v8aoGzclXnRQcGXdaYSYJZdjnrBch9U-FUATf9-P9xWjo95H-1BG-uiNxfpn9PLzyLgi";

                                        const payload = {
                                            "content": "@everyone 🚨 發現更高金額 Coupon！",
                                            "username": "Jalan Assistant",
                                            "avatar_url": "https://www.jalan.net/favicon.ico",
                                            embeds: [{
                                                title: "🚨 發現高額 Coupon！ (Jalan Assistant)",
                                                color: 5763719, // 綠色 (Discord 成功色)
                                                fields: [
                                                    { name: "Current (原本)", value: `¥ ${currentAmt}`, inline: true },
                                                    { name: "Highest (最高)", value: `¥ ${highestAmt}`, inline: true },
                                                    { name: "Tab ID", value: TAB_ID, inline: true },
                                                    { name: "Target URL", value: sessionStorage.getItem("jalan_last_valid_url") || "Unknown" }
                                                ],
                                                timestamp: new Date().toISOString()
                                            }]
                                        };

                                        try {
                                            await fetch(DISCORD_URL, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(payload)
                                            });
                                            console.log("Discord Alert Sent Successfully!");
                                        } catch (err) {
                                            console.error("Discord Alert Error:", err);
                                        }
                                    }
                                    notifyDiscord(currentAmt, highestAmt);
                                    const originalTitle = document.title;
                                    let flashState = false;
                                    setInterval(() => {
                                        document.title = flashState ? "🚨 HIGHER COUPON! 🚨" : "    HIGHER COUPON!    ";
                                        flashState = !flashState;
                                    }, 500);
                                }
                                else {
                                    // 2. 全部都是 SAME (或 LOWER)：1秒後執行 F5 強制刷新
                                    console.log(`[${TAB_ID}] All SAME. Triggering F5 reload in 60s...`);
                                    logEvent("RELOAD", "All same, refreshing in "+ 60+ "s" , "warn");

                                    setTimeout(() => {
                                        // 使用 location.reload(true) 模擬 F5，強制從伺服器抓取
                                        localStorage.setItem("jalan_batch_open_time", Date.now().toString());
                                        window.location.reload();
                                    }, 1000*0);
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
        if (currentUrl.includes("theme/coupon/") || currentUrl.includes("discountCoupon/") || (currentUrl.includes("/yad") && currentUrl.includes("/coupon/"))) {
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

        if (currentUrl.includes("uww3201init.do") || (currentUrl.includes("yadNo=") && currentUrl.includes("planCd="))) {
            addDirectBookingButton();
        }
        if (currentUrl.includes("uwp5100/uww5106next.do")) {
            const fullyBookedText = "先着予約数に達した";
            const isFullyBooked = document.body && document.body.innerText.includes(fullyBookedText);

            if (isFullyBooked) {
                console.log(`[${TAB_ID}] ⚠️ Coupon limit reached! Retrying (F5) in 5s...`);
                logEvent("LIMIT REACHED", "Retrying in 5s...", "warn");

                // 5秒後強制刷新頁面 (F5)
                setTimeout(() => {
                    window.location.reload();
                }, 5000);

                // UI 提示
                const statusEl = document.getElementById('loop-status');
                if (statusEl) {
                    statusEl.innerText = "Status: ⏳ FULLY BOOKED - RETRYING IN 5S";
                    statusEl.style.color = "#fd7e14";
                }
            }
        }

        if (currentUrl.includes("uww5001init.do")) {
            selectbookingdetail();
        }
        if (currentUrl.includes("uww5050next.do")) {
            confirmbookingdetail();
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
