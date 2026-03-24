// ==UserScript==
// @name         Jalan Helper - Auto Next & Intent Catcher
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Tab isolation, infinite memory, manual click recovery, and auto "Next" within 1 min of batch open
// @author       Gemini
// @match        *://www.jalan.net/*
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      githubusercontent.com
// @connect      github.com
// @connect      discordapp.com
// @connect      discord.com
// ==/UserScript==

(function() {
    'use strict';

    const global_cooldown = 60000*3;
    const getSafeDelay = (presetDelay) => {
        return Math.max(global_cooldown, presetDelay);
    };

    const DISCORD_WEBHOOK = "https://discordapp.com/api/webhooks/1484590933965148351/v8aoGzclXnRQcGXdaYSYJZdjnrBch9U-FUATf9-P9xWjo95H-1BG-uiNxfpn9PLzyLgi";

    // --- 0. Unique Tab ID Generation ---
    const TAB_ID = sessionStorage.getItem('JALAN_TAB_ID') || (() => {
        const id = "IT" + Math.random().toString(36).substring(2, 5).toUpperCase();
        sessionStorage.setItem('JALAN_TAB_ID', id);
        return id;
    })();
    let currentSort = {
        key: null,
        asc: true
    };
    handleSettingsPage();

    // --- 0.1 Sync Logger for Debugging ---
    function logEvent(type, message, status = "info") {
        let logs = JSON.parse(localStorage.getItem("jalan_retry_logs") || "[]");
        const time = new Date().toLocaleTimeString('en-GB');

        logs.unshift({
            time,
            type,
            message,
            tab: TAB_ID,
            status
        });
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
                                schedule.push({
                                    name: eventName,
                                    time: eventTime
                                });
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
            "該当ページが存在しません", // 頁面不存在 (404 類)
            "セッションがタイムアウトしました", // Session Timeout
            "アクセスが集中しています", // Server Busy
            "Hmmm… can't reach this page",
            "ご予約に必要な情報が不足しています。",
            "先着予約数に達した、または予約可能期間を超えた等の理由により、選択されたクーポンはご利用いただけなくなりました。現時点でご利用可能なクーポンがある場合は、再度選択してください。"
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
    /*setTimeout(() => {
        sessionStorage.removeItem("jalan_loop_active");
        clearInterval(JALAN_WATCHER_ID);
    }, 360000000);*/

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
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", {
            keyPath: "id",
            autoIncrement: true
        });
        if (!db.objectStoreNames.contains("auth")) db.createObjectStore("auth", {
            keyPath: "type"
        });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", {
            keyPath: "key"
        });
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
        checkUrlHashLock("");
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
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: '2147483647',
            fontFamily: 'sans-serif'
        });

        const lockedUrl = sessionStorage.getItem("jalan_last_valid_url") || "None (Browsing)";

        container.innerHTML = `
            <style>
                #jalan-main-panel { background: #fff; border: 2px solid #ff6600; border-radius: 8px; width: 300px; height: 400px; overflow-y: auto; flex-direction: column; box-shadow: 0 4px 15px rgba(0,0,0,0.3); overflow-x: hidden; }
                .j-section { padding: 10px; border-bottom: 1px solid #eee; }
                .j-btn { cursor: pointer; background: #ff6600; color: #fff; border: none; padding: 5px; border-radius: 3px; font-size: 11px; width: 100%; margin-top: 5px; }
                .j-input { width: 100%; font-size: 11px; margin-bottom: 4px; border: 1px solid #ccc; padding: 3px; box-sizing: border-box; }
                #jalan-minimized { display: none; background: #ff6600; color: white; width: 40px; height: 40px; border-radius: 50%; text-align: center; line-height: 40px; cursor: pointer; font-size: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.3); }
                .log-entry { font-size: 10px; margin-bottom: 5px; word-break: break-all; line-height: 1.3; border-bottom: 1px dotted #ccc; padding-bottom: 4px; }
                #jalan-log-list, #jalan-schedule-list { height: 80px; overflow-y: auto; background: #f9f9f9; border: 1px solid #ddd; padding: 5px; }
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
                        <button id="btn-open-settings" class="j-btn" style="background: #6f42c1; font-weight:bold; margin-top:3px;">⚙️ SETTINGS & TARGETS</button>
                    </div>
                    <div id="loop-status" style="font-size: 10px; margin-top: 5px; text-align:center; font-weight:bold;">Loop Active Status: ${sessionStorage.getItem("jalan_loop_active")}</div>
                </div>
                <div class="j-section" id="batch-actions" style="display:none;">
                    <b style="font-size: 11px;">RESERVATION TOOLS</b>
                    <div id="wrapper-open-all" style="display:none;">
                        <button id="btn-open-all" class="j-btn" style="background: #007bff;">Open All 予約変更</button>
                    </div>
                </div>
                <div class="j-section">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <b style="font-size: 11px;">HISTORY</b>
                        <span id="clear-logs" style="font-size: 10px; color: #007bff; cursor: pointer; text-decoration: underline;">Clear</span>
                    </div>
                    <div id="jalan-log-list"></div>
                </div>
                <div class="j-section">
                    <b style="font-size: 11px;">10 DAYS SCHEDULE</b>
                    <div id="jalan-schedule-container" style="font-size: 10px; margin-top: 5px; background: #fffde7; padding: 5px; border: 1px solid #ffe082; border-radius: 3px;">
                        <div id="j-next-event-name" style="font-weight:bold; color:#007bff;">Loading...</div>
                        <div id="j-countdown-timer" style="color:#dc3545; font-size:14px; font-weight:bold; margin: 2px 0;">--d --h --m --s</div>
                        <div id="jalan-schedule-list" style="margin-top: 5px; border-top: 1px dotted #ccc; padding-top: 3px;"></div>
                    </div>
                </div>
            </div>
            <div id="jalan-minimized" style="background: ${isErrorPage ? '#dc3545' : '#ff6600'};">☰</div>
        `;

        document.body.appendChild(container);
        /* ... 其餘事件綁定代碼 ... */
        const mainPanel = document.getElementById('jalan-main-panel');
        const miniIcon = document.getElementById('jalan-minimized');
        const setUIState = (isMinimized) => {
            if (isMinimized) {
                mainPanel.style.display = 'none';
                miniIcon.style.display = 'block';
            } else {
                mainPanel.style.display = 'block';
                miniIcon.style.display = 'none';
            }
            db.transaction("settings", "readwrite").objectStore("settings").put({
                key: "minimized",
                value: isMinimized
            });
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
        document.getElementById('btn-open-settings').onclick = () => {
            // 使用 search 參數較為穩定
            window.open('https://www.jalan.net/?jalan-settings=true', '_blank');
        };
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
            } catch (e) {
                console.error("UI Update Error", e);
            }
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

    function createSettingsOverlay() {
        if (document.getElementById('jalan-settings-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'jalan-settings-overlay';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(0,0,0,0.8)',
            zIndex: '2147483647',
            display: 'none',
            justifyContent: 'center',
            alignItems: 'center'
        });

        overlay.innerHTML = `
        <div style="background: #fff; width: 90%; max-height: 90%; overflow-y: auto; padding: 20px; border-radius: 8px; font-family: sans-serif; position: relative;">
            <h2 style="margin-top:0;">Jalan Target Manager</h2>
            <div style="margin-bottom: 10px; display: flex; gap: 10px; align-items: center;">
                <button id="set-add-row" class="j-btn" style="width:auto; background:#28a745;">+ Add New Entry</button>
                <button id="set-delete-row" class="j-btn" style="width:auto; background:#dc3545;">Delete Selected</button>
                <button id="set-dup-row" class="j-btn" style="width:auto; background:#ffc107; color:#000;">Duplicate Selected</button>
                <button id="set-save-local" class="j-btn" style="width:auto; background:#218838;">💾 Save to Local</button>
                <div style="flex-grow:1;"></div>
                <span id="last-sync-time" style="font-size:11px; color:#666;">Last Sync: Never</span>
                <button id="set-update-git" class="j-btn" style="width:auto; background:#17a2b8;">🔄 Update from GitHub</button>
                <button id="set-copy-json" class="j-btn" style="width:auto; background:#6c757d;">📋 Copy JSON for GitHub</button>
            </div>

            <table id="target-table" style="width:100%; border-collapse: collapse; font-size:12px;">
                <thead>
                    <tr style="background:#eee;">
                        <th border="1"><input type="checkbox" id="select-all-rows"></th>
                        <th>Hotel Name</th>
                        <th>Check-in</th>
                        <th>Nights</th>
                        <th>Adults</th>
                        <th>Rooms</th>
                        <th>Room Type</th>
                        <th>Target Price</th>
                        <th>Target Link</th>
                    </tr>
                </thead>
                <tbody id="target-table-body"></tbody>
            </table>

            <div style="margin-top:20px; text-align:right;">
                <button id="set-open-links" class="j-btn" style="width:auto; background:#007bff; padding: 10px 20px;">🚀 Open Checked Links (Locked)</button>
                <button id="set-close-overlay" class="j-btn" style="width:auto; background:#6c757d; margin-left:10px;">Close</button>
            </div>
        </div>
    `;
        document.body.appendChild(overlay);
        bindSettingsEvents();
    }

    function renderSettingsTable() {
        const body = document.getElementById('target-table-body');
        const targets = JSON.parse(localStorage.getItem('jalan_local_targets') || '{"target_list":[]}').target_list;
        body.innerHTML = '';

        targets.forEach((t, i) => {
            const row = document.createElement('tr');
            row.innerHTML = `
            <td><input type="checkbox" class="row-select" data-index="${i}"></td>
            <td><input type="text" class="edit-cell" data-key="hotel_name" value="${t.hotel_name || ''}"></td>
            <td><input type="text" class="edit-cell" data-key="checkin_date" value="${t.checkin_date || ''}"></td>
            <td><input type="number" class="edit-cell" data-key="nights" value="${t.nights || 1}"></td>
            <td><input type="number" class="edit-cell" data-key="adult_num" value="${t.adult_num || 4}"></td>
            <td><input type="number" class="edit-cell" data-key="room_num" value="${t.room_num || 1}"></td>
            <td><input type="text" class="edit-cell" data-key="room_type" value="${t.room_type || ''}"></td>
            <td><input type="number" class="edit-cell" data-key="target_price" value="${t.target_price || 0}"></td>
            <td><input type="text" class="edit-cell" data-key="target_link" value="${t.target_link || ''}"></td>
        `;
            body.appendChild(row);
        });

        document.getElementById('last-sync-time').innerText = "Last Sync: " + (localStorage.getItem('jalan_git_sync_time') || 'Never');
    }


    function handleSettingsPage() {
        // 檢查網址是否包含參數
        if (window.location.search.includes('jalan-settings=true')) {
            // 停止頁面原本的渲染
            window.stop();
            const newHTML = document.createElement('html');
            newHTML.innerHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Jalan Target Manager</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; padding: 20px; }
                    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
                    h1 { color: #1a1a1a; margin-top: 0; display: flex; align-items: center; gap: 10px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th { background: #f8f9fa; color: #495057; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; padding: 12px 8px; border-bottom: 2px solid #dee2e6; }
                    td { padding: 8px; border-bottom: 1px solid #eee; }
                    input[type="text"], input[type="number"] { width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
                    input:focus { outline: none; border-color: #6f42c1; box-shadow: 0 0 0 2px rgba(111,66,193,0.1); }
                    .btn-group { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
                    .btn { padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; }
                    .btn:hover { opacity: 0.9; transform: translateY(-1px); }
                    .btn-save { background: #28a745; color: white; }
                    .btn-add { background: #6f42c1; color: white; }
                    .btn-del { background: #dc3545; color: white; }
                    .btn-git { background: #17a2b8; color: white; }
                    .btn-copy { background: #6c757d; color: white; }
                    .btn-open { background: #ffc107; color: #212529; }
                </style>
            </head>
            <body>
                <div id="settings-root"></div>
            </body>
            </html>
        `;
            document.documentElement.replaceWith(newHTML);

            // 4. 使用微任務 (MutationObserver 的原理) 確保 DOM 渲染完畢
            const checkAndRender = () => {
                const root = document.getElementById('settings-root');
                if (root) {
                    console.log(`[${TAB_ID}] 找到容器，開始渲染 UI...`);
                    try {
                        renderSettingsUI();
                    } catch (e) {
                        console.error("Render Error:", e);
                    }
                } else {
                    // 如果仲未搵到，10ms 後再試 (最多試幾次)
                    setTimeout(checkAndRender, 10);
                }
            };

            checkAndRender();

            // 5. 拋出錯誤停止原本的腳本
            console.log("SETTINGS_PAGE_ACTIVE");
        }
    }

    function renderSettingsUI() {
        const root = document.getElementById('settings-root');
        root.innerHTML = `
        <div class="container">
            <h1>⚙️ Jalan Target Manager (Local Storage)</h1>
            <div style="margin-bottom: 15px;">
                <button id="set-add" class="btn btn-add">+ Add New</button>
                <button id="set-dup" class="btn btn-open" style="background:#ffc107; color:black;">👯 Duplicate Selected</button>
                <button id="set-del" class="btn btn-del">Delete Selected</button>
                <button id="set-save" class="btn btn-save">💾 Save to Browser</button>
                <span style="margin: 0 15px; color: #666;">|</span>
                <button id="set-git" class="btn btn-git">🔄 Update from GitHub</button>
                <button id="set-copy" class="btn btn-copy">📋 Copy JSON</button>
                <button id="set-open" class="btn btn-open">🚀 Open & Lock Selected</button>
                <span id="sync-info" style="font-size: 12px; margin-left: 10px;"></span>
            </div>
            <table>
                <thead>
                    <tr>
                        <th style="width:30px;"><input type="checkbox" id="check-all"></th>
                        <th style="cursor:pointer" data-sort="hotel_name">Hotel Name ↕️</th>
                        <th style="cursor:pointer" data-sort="checkin_date">Check-in ↕️</th>
                        <th style="cursor:pointer" data-sort="nights">Nights ↕️</th>
                        <th style="cursor:pointer" data-sort="adult_num">Adults ↕️</th>
                        <th style="cursor:pointer" data-sort="room_num">Rooms ↕️</th>
                        <th style="cursor:pointer" data-sort="room_type">Room Type ↕️</th>
                        <th style="cursor:pointer" data-sort="target_price">Target Price ↕️</th>
                        <th>Target Link</th>
                    </tr>
                </thead>
                <tbody id="table-body"></tbody>
            </table>
        </div>
    `;

        loadTableData();
        bindSettingsEvents();
    }

    function loadTableData() {
        const body = document.getElementById('table-body');
        const data = JSON.parse(localStorage.getItem('jalan_local_targets') || '{"target_list":[]}');
        if (currentSort.key) {
            list.sort((a, b) => {
                let valA = a[currentSort.key];
                let valB = b[currentSort.key];
                if (typeof valA === 'string') {
                    return currentSort.asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                } else {
                    return currentSort.asc ? valA - valB : valB - valA;
                }
            });
        }

        body.innerHTML = '';

        data.target_list.forEach((t, i) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
            <td><input type="checkbox" class="row-check" data-index="${i}"></td>
            <td><input type="text" value="${t.hotel_name || ''}" data-key="hotel_name"></td>
            <td><input type="text" value="${t.checkin_date || ''}" data-key="checkin_date"></td>
            <td><input type="number" value="${t.nights || 1}" data-key="nights"></td>
            <td><input type="number" value="${t.adult_num || 4}" data-key="adult_num"></td>
            <td><input type="number" value="${t.room_num || 1}" data-key="room_num"></td>
            <td><input type="text" value="${t.room_type || ''}" data-key="room_type"></td>
            <td><input type="number" value="${t.target_price || 0}" data-key="target_price"></td>
            <td><input type="text" value="${t.target_link || ''}" data-key="target_link"></td>
        `;
            body.appendChild(tr);
        });
        document.getElementById('sync-info').innerText = "Last Sync: " + (localStorage.getItem('jalan_git_sync_time') || 'N/A');
    }

    function bindSettingsEvents() {
        const checkAll = document.getElementById('check-all');
        if (checkAll) {
            checkAll.onchange = () => {
                document.querySelectorAll('.row-check').forEach(cb => cb.checked = checkAll.checked);
            };
        }

        // Add New Entry
        document.getElementById('set-add').onclick = () => {
            const body = document.getElementById('table-body');
            const tr = document.createElement('tr');
            tr.style.background = "#fff9db"; // 高亮新加行
            tr.innerHTML = `
            <td><input type="checkbox" class="row-check"></td>
            <td><input type="text" value="New Hotel" data-key="hotel_name"></td>
            <td><input type="text" value="2026/01/01" data-key="checkin_date"></td>
            <td><input type="number" value="1" data-key="nights"></td>
            <td><input type="number" value="4" data-key="adult_num"></td>
            <td><input type="number" value="1" data-key="room_num"></td>
            <td><input type="text" value="" data-key="room_type"></td>
            <td><input type="number" value="0" data-key="target_price"></td>
            <td><input type="text" value="" data-key="target_link"></td>
        `;
            body.prepend(tr);
        };
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.onclick = () => {
                const key = th.dataset.sort;
                if (currentSort.key === key) {
                    currentSort.asc = !currentSort.asc;
                } else {
                    currentSort.key = key;
                    currentSort.asc = true;
                }
                loadTableData();
            };
        });
        document.getElementById('set-dup').onclick = () => {
            const checked = document.querySelectorAll('.row-check:checked');
            if (checked.length === 0) return alert("Select entries to duplicate.");

            checked.forEach(cb => {
                const tr = cb.closest('tr');
                const clone = tr.cloneNode(true);
                clone.querySelector('.row-check').checked = false;
                tr.after(clone); // 喺原本嗰行下面插入
            });
            alert(`Duplicated ${checked.length} entries. Remember to SAVE!`);
        };
        // Delete Selected
        document.getElementById('set-del').onclick = () => {
            const checked = document.querySelectorAll('.row-check:checked');
            if (checked.length === 0) return alert("Please select entries to delete.");
            if (confirm(`Delete ${checked.length} entries?`)) {
                checked.forEach(cb => cb.closest('tr').remove());
            }
        };
        // Save to Local
        document.getElementById('set-save').onclick = () => {
            const newList = [];
            document.querySelectorAll('#table-body tr').forEach(tr => {
                const entry = {};
                const inputs = tr.querySelectorAll('input[data-key]');
                if (inputs.length > 0) {
                    inputs.forEach(input => {
                        const key = input.dataset.key;
                        entry[key] = input.type === 'number' ? parseInt(input.value || 0) : input.value;
                    });
                    newList.push(entry);
                }
            });
            localStorage.setItem('jalan_local_targets', JSON.stringify({
                target_list: newList
            }));
            alert("Settings Saved! Order updated.");
            loadTableData(); // 重新整理表格
        };

        // Open & Lock
        document.getElementById('set-open').onclick = () => {
            const targets = JSON.parse(localStorage.getItem('jalan_local_targets')).target_list;
            document.querySelectorAll('.row-check:checked').forEach(cb => {
                const t = targets[cb.dataset.index];
                if (t.target_link) {
                    const targetUrl = t.target_link;
                    const lockableUrl = targetUrl + "#j_lock=" + encodeURIComponent(targetUrl);
                    console.log(`[${TAB_ID}] Opening with Lock Intent: ${lockableUrl}`);
                    GM_openInTab(lockableUrl, {
                        active: false,
                        insert: true
                    });
                }
            });
        };

        // GitHub Update
        document.getElementById('set-git').onclick = async () => {
            const jsonUrl = "https://raw.githubusercontent.com/brittenpoon/4n1m3-g4m3r-v0/refs/heads/main/jalan_target.json";
            try {
                const res = await fetch(jsonUrl + "?t=" + Date.now());
                const data = await res.json();
                localStorage.setItem('jalan_local_targets', JSON.stringify(data));
                localStorage.setItem('jalan_git_sync_time', new Date().toLocaleString());
                loadTableData();
                alert("GitHub data synced!");
            } catch (e) {
                alert("Error: " + e);
            }
        };

        // Copy JSON
        // Copy JSON (美化多行版)
        document.getElementById('set-copy').onclick = () => {
            const rawData = localStorage.getItem('jalan_local_targets');
            if (!rawData) return alert("No data to copy!");

            try {
                const jsonObj = JSON.parse(rawData);

                // 關鍵在於後面個 '  ' (兩個空格) 或者 4，代表縮排格式
                const prettyJson = JSON.stringify(jsonObj, null, 2);

                navigator.clipboard.writeText(prettyJson).then(() => {
                    alert("✅ JSON Copied in Pretty Format! You can paste it to GitHub now.");
                });
            } catch (e) {
                alert("❌ Error formatting JSON: " + e.message);
            }
        };
    }

    function checkUrlHashLock(message) {
        const hash = window.location.hash;
        if (hash.includes("#j_lock=")) {
            const urlToLock = decodeURIComponent(hash.split("#j_lock=")[1]);

            if (urlToLock && urlToLock.startsWith('http')) {
                console.log(`[${TAB_ID}] 偵測到 Hash Lock 指令，自動設定 URL Lock...`);
                sessionStorage.setItem("jalan_last_valid_url", urlToLock);
                sessionStorage.setItem("jalan_loop_active", "true");

                let rsvNo = "Unknown";
                if (currentUrl.includes("uwp5100/uww5103init.do")) {
                    try {
                        // 使用 URL 物件解析傳入的網址
                        const urlObj = new URL(urlToLock);
                        rsvNo = urlObj.searchParams.get("rsvNo") || "Unknown";
                    } catch (e) {
                        // 如果 URL 解析失敗，嘗試用傳統 split 方式攞
                        const match = urlToLock.match(/[?&]rsvNo=([^&]+)/);
                        if (match) rsvNo = match[1];
                    }

                    const hotelName = document.querySelector('img[alt="宿泊施設"]')
                      ?.closest('td')
                      ?.nextElementSibling
                      ?.querySelector('.s12_30')
                      ?.innerText.trim();

                    sessionStorage.setItem("jalan_current_rsvNo", rsvNo);
                    sessionStorage.setItem("jalan_current_hotelName", hotelName);
                }
                if (currentUrl.includes("uwp5000/uww5001init.do")) {
                    rsvNo = generateSimulatedRsvId(urlToLock);
                    const pageHotelName = document.querySelector('p.CbALFsHFZyJ9C2wPIzMP')?.innerText.trim();

                    sessionStorage.setItem("jalan_current_rsvNo", rsvNo);
                    sessionStorage.setItem("jalan_current_hotelName", pageHotelName);
                }

                logEvent("AUTO LOCK", "URL Locked from Setting Page", "success");
            }
        }
        const loopActive = sessionStorage.getItem("jalan_loop_active") === "true";
        if (loopActive) {
            // --- Page B: Modification Input Page (Auto Click '次へ') ---
            if (currentUrl.includes("uwp5100/uww5103init.do")) {
                //const rsvNo = sessionStorage.getItem("jalan_current_rsvNo");
                //const hotelName = sessionStorage.getItem("jalan_current_hotelName");
                //sendDiscordHeartbeat(rsvNo, hotelName);
                const nextImg = document.querySelector('img[alt="次へ"], img[name="nx01"]');
                if (nextImg) {
                    console.log(`[${TAB_ID}] Within active batch window. Auto-clicking '次へ'...`);
                    setTimeout(() => {
                        nextImg.click();
                    }, 800);
                }
            }
            if ((currentUrl.includes("uwp5100/uww5103next.do") || currentUrl.includes("uwp5000/uww5001init.do")) && message.trim() !== "") {
                const rsvNo = sessionStorage.getItem("jalan_current_rsvNo");
                const hotelName = sessionStorage.getItem("jalan_current_hotelName");
                sendDiscordHeartbeat(rsvNo, hotelName, message);
            }
            keepAlive();
        }
    }

    function sendDiscordHeartbeat(rsvNo, hotelName, message) {
        // 每個 rsvNo 使用獨立的 Message ID 紀錄，避免不同分頁互相覆蓋
        console.log("sending Discord");
        const storageKey = `discord_msg_id_${rsvNo}`;
        const isBetter = message.includes("BETTER");
        const lastMsgId = isBetter ? null : localStorage.getItem(storageKey);
        const now = new Date().toLocaleString('zh-HK', { hour12: false });
       let type = "General"; // 預設值
        if (rsvNo.length === 8) {
            type = "Coupon";      // 真正的預約編號 (8位)
        } else if (rsvNo.length > 8) {
            type = "Reservation"; // 模擬 ID (SIM_...) 通常會超過 8 位
        }

        const payload = {
            content: `${isBetter ? `🎉 **[BETTER VALUE FOUND!] ${type}**` : `💓 **Jalan 監控中 ${type}**`}\n` +
                     `**最後活躍**: \`${now}\`\n` +
                     `**預約編號**: \`${rsvNo}\`\n` +
                     `**監控酒店**: ${hotelName}\n` +
                     `**Tab ID**: ${TAB_ID}\n` +
                     `**Message**: ${message}\n` +
                     `----------------------------------`
        };

        if (lastMsgId) {
            // 方法 A: 編輯現有訊息 (PATCH)
            GM_xmlhttpRequest({
                method: "PATCH",
                url: `${DISCORD_WEBHOOK}/messages/${lastMsgId}`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(payload),
                onload: function(res) {
                    console.log(res);
                    if (res.status === 404) {
                        localStorage.removeItem(storageKey); // 訊息被刪了，下次發新的
                    }
                }
            });
        } else {
            // 方法 B: 發送新訊息 (POST) - 必須加 ?wait=true 才能拿回 ID
            GM_xmlhttpRequest({
                method: "POST",
                url: `${DISCORD_WEBHOOK}?wait=true`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(payload),
                onload: function(res) {
                    console.log(res);
                    if (res.status === 200 && !isBetter) {
                        const response = JSON.parse(res.responseText);
                        localStorage.setItem(storageKey, response.id);
                    }
                }
            });
        }
    }
    function generateSimulatedRsvId(url) {
        const params = new URLSearchParams(url.split('?')[1]);
        const temp1 = params.get('TEMP1') || "";

        const yadNo = temp1.match(/yadNo\+([^#&]+)/)?.[1] || "0";
        const planCd = temp1.match(/planCd\+([^#&]+)/)?.[1] || "0";
        const roomType = temp1.match(/roomTypeCd\+([^#&]+)/)?.[1] || "0";
        const roomCount = temp1.match(/roomCount\+([^#&]+)/)?.[1] || "0";

        // 強制補零：5月變成 05，7日變成 07
        const year = temp1.match(/stayYear\+([^#&]+)/)?.[1] || "";
        const month = (temp1.match(/stayMonth\+([^#&]+)/)?.[1] || "").padStart(2, '0');
        const day = (temp1.match(/stayDay\+([^#&]+)/)?.[1] || "").padStart(2, '0');

        const stayDate = year + month + day;

        // 加入下劃線分隔，確保 ID 結構清晰
        return `SIM_${yadNo}_${planCd}_${roomType}_${roomCount}_${stayDate}`;
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
                        couponInfo: currentBatch.map(id => ({
                            discountCouponId: id,
                            cldmPermissionFlg: "0"
                        })),
                        sendMailBulkFlg: "1"
                    };

                    const response = await fetch('/uw/uwa7200/uwa7214Bulk.do', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
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

    function selectbookingdetail(onComplete) {
        let attempts = 0;
        const maxAttempts = 15; // 延長至 7.5 秒，確保慢速網路也能完成

        const interval = setInterval(() => {
            try {
                attempts++;
                console.log(`[${TAB_ID}] 正在自動填表... (第 ${attempts} 次)`);

                // --- 1. 處理彈窗 (預約繼續按鈕) ---
                const continueButton = Array.from(document.querySelectorAll('button'))
                    .find(btn => btn.textContent.trim() === '予約を続ける');
                if (continueButton) {
                    continueButton.click();
                    return; // 點擊後等待下一次 Loop 填表
                }

                // --- 2. 執行填表邏輯 ---
                const manSelect0 = document.querySelector('select[name="rsvInfoList[0].adultManNum"]');
                if (manSelect0) {
                    const roomCount = document.querySelectorAll('select[name$=".adultManNum"]').length;
                    const setVal = (name, val) => {
                        const el = document.querySelector(`select[name="${name}"]`);
                        if (el) {
                            const exists = Array.from(el.options).some(o => o.value === String(val));
                            el.value = exists ? String(val) : el.options[el.options.length - 1].value;
                            el.dispatchEvent(new Event('change', {
                                bubbles: true
                            }));
                        }
                    };

                    // 填寫人數、時間、支付方式
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

                    const checkin = document.querySelector('select[name="checkinTime"]');
                    if (checkin) {
                        checkin.value = "18:00";
                        checkin.dispatchEvent(new Event('change', {
                            bubbles: true
                        }));
                    }

                    const repay = document.querySelector('textarea[name="repay"]');
                    if (repay) {
                        repay.value = ".";
                        repay.dispatchEvent(new Event('input', {
                            bubbles: true
                        }));
                    }

                    const localPay = document.querySelector('input[name="localPayCardFlg"][value="0"]');
                    if (localPay) {
                        localPay.checked = true;
                        localPay.click();
                    }
                }

                // --- 3. 核心檢查：是否已經準備好提交？ ---
                const hasError = document.body.innerText.includes("未入力の必須項目があります");
                const confirmBtn = document.querySelector('button[aria-label="reservation button"]');

                // 如果按鈕出現且沒有錯誤紅字，代表填表完成
                if (!hasError && confirmBtn) {
                    console.log(`[${TAB_ID}] ✅ 自動填表完成且無錯誤！`);
                    clearInterval(interval);
                    if (onComplete) onComplete(); // 觸發下一步：比對價格
                }

                if (attempts >= maxAttempts) {
                    console.log(`[${TAB_ID}] 填表逾時，停止嘗試。`);
                    clearInterval(interval);
                }

            } catch (e) {
                console.error("填表執行出錯:", e);
            }
        }, 500);
    }

    async function checkAndConfirmBooking() {

        const jsonUrl = "https://raw.githubusercontent.com/brittenpoon/4n1m3-g4m3r-v0/refs/heads/main/jalan_target.json";

        try {
            const localData = localStorage.getItem('jalan_local_targets');
            let targets = [];
            let message = "";

            if (localData) {
                const parsed = JSON.parse(localData);
                targets = parsed.target_list || [];
            }

            // --- 2. 如果無數據，提示用戶去 Setting 頁面更新 ---
            if (targets.length === 0) {
                console.log(`[${TAB_ID}] 本地無數據，請先到 Setting 頁面同步 GitHub。`);
                message = "本地目標清單為空，請在 Setting 頁面點擊「Update from GitHub」同步數據";
                checkUrlHashLock(message);
                logEvent("CHECK", message, "warn");
                return; // 終止執行
            }

            // --- 1. 抓取頁面數據 (使用 XPath 避免 Random Class 影響) ---
            const getValByLabel = (label) => {
                const el = document.evaluate(
                    `//dt[contains(text(),'${label}')]/following-sibling::dd`,
                    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
                return el ? el.innerText.trim() : "";
            };

            const pageHotelName = document.querySelector('p.CbALFsHFZyJ9C2wPIzMP')?.innerText.trim();
            const pageStay = getValByLabel("宿泊日"); // "2026年6月8日から1泊"
            const pageMember = getValByLabel("人数室数"); // "大人4名 1部屋"
            const pageRoom = getValByLabel("部屋"); // "フォース 禁煙室"

            const priceText = document.querySelector('.tBwmC2bvTZhQy1UQ0Pw2 span')?.innerText.replace(/,/g, '');
            const currentPrice = parseInt(priceText);

            if (!pageHotelName || isNaN(currentPrice)) {
                console.log("[Jalan Helper] 數據抓取失敗，5秒後重試...");
                setTimeout(() => window.location.reload(), getSafeDelay(5000));
                return;
            }

            // --- 2. 尋找對應 JSON 目標並比對 ---
            const target = targets.find(t => {
                // 日期比對：將 "2026年6月8日" 轉為 "2026/06/08" 或 "2026/6/8"
                const dateFromPage = pageStay.split('日')[0].replace(/年|月/g, '/');
                const formattedTargetDate = t.checkin_date.replace(/\/0/g, '/'); // 統一不補零比對

                return pageHotelName === t.hotel_name &&
                    (dateFromPage === formattedTargetDate || dateFromPage === t.checkin_date) &&
                    pageStay.includes(`${t.nights}泊`) &&
                    pageMember.includes(`大人${t.adult_num}名`) &&
                    pageMember.includes(`${t.room_num}部屋`) &&
                    pageRoom === t.room_type; // 嚴格比對房型文字
            });

            if (!target) {
                message = "找不到匹配的目標或房型不符，停止自動操作。";
                checkUrlHashLock(message);
                logEvent("CHECK", message, "warn");
                return;
            }

            // --- 3. 價格邏輯判斷 ---
            if (currentPrice < target.target_price) {
                message = `[BETTER] 價格達標: ${currentPrice} < ${target.target_price}。執行預約！`;
                checkUrlHashLock(message);
                logEvent("MATCH", message, "success");
                const confirmBtn = document.querySelector('button[aria-label="reservation button"]');
                if (confirmBtn && !confirmBtn.disabled) {
                    confirmBtn.click();
                } else {
                    logEvent("ERROR", "按鈕仍為 Disabled 狀態，可能填表未完成。", "error");
                }
            } else if (currentPrice === target.target_price) {
                message = `價格不變 (${currentPrice})`;
                checkUrlHashLock(message);
                logEvent("EQUAL", message, "info");
                setTimeout(() => window.location.reload(), getSafeDelay(15000));
            } else {
                message = `價格過高 (${currentPrice} > ${target.target_price})`;
                checkUrlHashLock(message);
                logEvent("HIGHER", message, "warn");
                setTimeout(() => window.location.reload(), getSafeDelay(1000));
            }

        } catch (e) {
            logEvent("ERROR", "JSON 讀取失敗，5秒後重試。");
            setTimeout(() => window.location.reload(), getSafeDelay(5000));
        }
    }

    function confirmbookingdetail5050() {
        let attempts = 0;
        const maxAttempts = 20;

        const interval = setInterval(() => {
            attempts++;

            try {
                if (document.readyState === 'loading') return;

                // 1. 定位按鈕 (同時搜尋 <a> 和 <button>)
                // 優先尋找 class 包含 reserve_button 且文字正確的元素
                const confirmBtn = Array.from(document.querySelectorAll('a.reserve_button, button')).find(el =>
                    el.innerText.includes('予約を完了する') || el.querySelector('.reserve_button_text')
                );

                if (confirmBtn) {
                    // 2. 狀態檢查
                    const btnText = confirmBtn.innerText.trim();

                    // 檢查是否為「未入力」狀態
                    if (btnText.includes('未入力')) {
                        console.log(`[${TAB_ID}] 填表未完成 (顯示: ${btnText})，等待中...`);
                        return;
                    }

                    console.log(`[${TAB_ID}] ✅ 發現目標按鈕 [${btnText}]，執行提交...`);

                    // 3. 執行提交
                    // 方法 A: 如果是連結且有 onclick 屬性，直接執行該 JS 方法 (最保險)
                    const onclickAttr = confirmBtn.getAttribute('onclick');
                    if (onclickAttr && onclickAttr.includes('doNext')) {
                        console.log(`[${TAB_ID}] 觸發頁面 doNext() 方法`);
                        unsafeWindow.doNext(); // 透過 Tampermonkey 的 unsafeWindow 呼叫原生 doNext
                    } else {
                        // 方法 B: 普通點擊
                        confirmBtn.focus();
                        confirmBtn.click();
                    }

                    clearInterval(interval);
                    return;
                }

                if (attempts >= maxAttempts) {
                    console.log(`[${TAB_ID}] 提交超時：找不到 [予約を完了する] 按鈕。`);
                    clearInterval(interval);
                }
            } catch (e) {
                console.error("confirmbookingdetail error:", e);
            }
        }, 500);
    }



    function confirmbookingdetail5106() {
        let attempts = 0;
        const maxAttempts = 20;

        const interval = setInterval(() => {
            attempts++;
            if (document.readyState === 'loading') return;

            try {
                // --- 強化後的定位邏輯 ---
                // 1. 搵有 doNext 嘅 <a>
                // 2. 搵有 doNext 嘅 <img> (針對你提供嘅 HTML)
                // 3. 搵文字包含 "予約を完了する" 嘅按鈕
                let targetEl = document.querySelector('a[onclick*="doNext"], img[onclick*="doNext"]');

                if (!targetEl) {
                    targetEl = Array.from(document.querySelectorAll('button, a, img')).find(el => {
                        const alt = el.getAttribute('alt') || "";
                        const text = el.innerText || "";
                        return alt.includes('確定') || alt.includes('完了') || text.includes('予約を完了する');
                    });
                }

                if (targetEl) {
                    console.log(`[${TAB_ID}] ✅ 發現提交目標: ${targetEl.tagName}`);

                    // 執行點擊或 doNext
                    const onclickAttr = targetEl.getAttribute('onclick') || "";
                    if (onclickAttr.includes('doNext')) {
                        // 直接執行 doNext 係最穩陣嘅做法
                        if (typeof unsafeWindow.doNext === 'function') {
                            console.log(`[${TAB_ID}] 觸發 unsafeWindow.doNext()`);
                            unsafeWindow.doNext();
                        } else {
                            targetEl.click();
                        }
                    } else {
                        targetEl.click();
                    }

                    clearInterval(interval);
                    return;
                }

                if (attempts >= maxAttempts) {
                    console.log(`[${TAB_ID}] 提交超時，找不到按鈕。`);
                    clearInterval(interval);
                }
            } catch (e) {
                console.error("confirmbookingdetail error:", e);
            }
        }, 500);
    }

    function editduplicatenext() {
        let attempts = 0;
        const maxAttempts = 15; // 嘗試約 7.5 秒
        let clickCount = 0;

        const interval = setInterval(() => {
            try {
                attempts++;

                // 1. 確保頁面加載完成
                if (document.readyState === 'loading') return;

                // 2. 定位按鈕：尋找 alt 為 "続ける" 的圖片
                const continueImg = document.querySelector('img[alt="続ける"]');
                const targetLink = continueImg ? continueImg.closest('a') : null;

                if (targetLink) {
                    clickCount++;
                    console.log(`[${TAB_ID}] ✅ 發現「続ける」按鈕，執行第 ${clickCount} 次觸發...`);

                    // 3. 執行觸發邏輯
                    const onclickAttr = targetLink.getAttribute('onclick') || "";

                    if (onclickAttr.includes('doNext')) {
                        // 直接從頁面全域環境執行 doNext 方法，這是最穩定跳轉的方式
                        const screenParam = onclickAttr.match(/'([^']+)'/)?.[1] || 'UWW5103';
                        try {
                            if (typeof unsafeWindow.doNext === 'function') {
                                unsafeWindow.doNext(screenParam);
                            } else {
                                targetLink.click(); // 備用方案
                            }
                        } catch (e) {
                            targetLink.click();
                        }
                    } else {
                        targetLink.click();
                    }

                    // 4. 自我修復：如果點擊了 5 次 (約 2.5秒) 頁面還沒跳轉，強制重新整理
                    if (clickCount >= 5) {
                        console.log(`[${TAB_ID}] 🚨 點擊多次無反應，頁面可能凍結，執行強制刷新...`);
                        clearInterval(interval);
                        window.location.reload();
                        return;
                    }
                }

                // 超時處理
                if (attempts >= maxAttempts) {
                    console.log(`[${TAB_ID}] 嘗試超時`);
                    clearInterval(interval);
                }
            } catch (e) {
                console.error("editduplicatenext error:", e);
            }
        }, 500);
    }

    // 驗證頁面上的 Coupon 名稱是否與預期一致
    function checkGhostCoupon() {
        const intendedNames = JSON.parse(sessionStorage.getItem("intended_coupons") || "[]");
        if (intendedNames.length === 0) return true; // 冇紀錄就當通過

        const pageContent = document.body.innerText;
        console.log(`[${TAB_ID}] 正在比對預期名單:`, intendedNames);

        // 搵出名單入面有邊張 Coupon 係頁面搵唔到嘅
        const missing = intendedNames.filter(name => !pageContent.includes(name));

        if (missing.length > 0) {
            logEvent("GHOST_DETECTED", `缺失 Coupon: ${missing.join(', ')}`, "error");

            const lockedUrl = sessionStorage.getItem("jalan_last_valid_url");
            sessionStorage.removeItem("intended_coupons"); // 清除舊紀錄

            if (lockedUrl) {
                console.log(`[${TAB_ID}] 偵測到 Ghost Coupon，跳轉回 URL Lock...`);
                window.location.replace(lockedUrl);
            }
            return false;
        }
        return true;
    }

    // 執行跳轉至下一步 (適用於 uww5103next.do)
    function executeJalanNext() {
        try {
            if (typeof unsafeWindow.doNext === 'function') {
                unsafeWindow.doNext();
            } else {
                const nextBtn = document.querySelector('a[onclick*="doNext"], img[name="nx01"]');
                if (nextBtn) {
                    const link = nextBtn.closest('a') || nextBtn;
                    link.click();
                }
            }
        } catch (e) {
            console.error("executeJalanNext 執行失敗:", e);
        }
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
                    GM_openInTab(lockableUrl, {
                        active: false,
                        insert: true
                    });
                    current++;
                    btn.innerText = `Opening... (${current}/${total})`;
                    renderLogs();

                }, 0);
            };
            keepAlive();
            logEvent("RELOAD", "Refreshing in " + 60 + "s", "warn");
            renderLogs();
            setInterval(() => {
                window.location.reload();
            }, 60000);
        }

        // --- Page C: Coupon Application Page ---
        if (currentUrl.includes("uwp5100/uww5103next.do")) {
            editduplicatenext(); // 處理可能的「繼續」彈窗或按鈕

            const wrapper = document.querySelector('.js-selectedCouponWrapper, .selectedCouponWrapper');
            if (!wrapper) {
                logEvent("COUPON", "No applicable coupon wrapper found.");
                // 如果連選單都沒出現，視為無優惠券，執行 15s 刷新
                setTimeout(() => window.location.reload(), getSafeDelay(1000));
            } else {
                const changeBtn = wrapper.querySelector('.js-changeCouponBtn, .changeCouponBtn');
                if (changeBtn) changeBtn.click();

                let attempts = 0;
                const evalInterval = setInterval(() => {
                    attempts++;
                    const selects = document.querySelectorAll('select[name="discountCouponListInfoValue"]');
                    const hasOptions = Array.from(selects).some(s => s.querySelector('option[data-coupon-price]'));

                    if (hasOptions) {
                        clearInterval(evalInterval);
                        let betterCouponFound = false;
                        let finalIntendedNames = [];
                        let totalCurrent = 0;
                        let totalMax = 0;

                        selects.forEach((select, index) => {
                            const options = Array.from(select.querySelectorAll('option[data-coupon-price]'));
                            const currentSelected = select.querySelector('option:checked');
                            const currentVal = currentSelected ? (parseInt(currentSelected.getAttribute('data-coupon-price')) || 0) : 0;

                            let highestPrice = 0;
                            let highestOpt = null;

                            options.forEach(opt => {
                                const price = parseInt(opt.getAttribute('data-coupon-price')) || 0;
                                if (price >= highestPrice) {
                                    highestPrice = price;
                                    highestOpt = opt;
                                }
                            });

                            totalCurrent += currentVal;
                            totalMax += highestPrice;

                            if (highestOpt) {
                                highestOpt.selected = true;
                                const cpnName = highestOpt.getAttribute('data-coupon-name') || highestOpt.innerText.trim();
                                finalIntendedNames.push(cpnName);
                                select.dispatchEvent(new Event('change', {
                                    bubbles: true
                                }));
                            }
                        });

                        // 紀錄名單供下一頁 checkGhostCoupon 驗證
                        sessionStorage.setItem("intended_coupons", JSON.stringify(finalIntendedNames));
                        betterCouponFound = totalMax > totalCurrent;

                        if (betterCouponFound) {
                            const message = `[BETTER] Found hogher value coupon ¥${totalMax} (was ¥${totalCurrent})`;
                            logEvent("MATCH", message, "success");
                            checkUrlHashLock(message);
                            // 自動執行 Next
                            setTimeout(() => {
                                console.log(`[${TAB_ID}] Executing executeJalanNext...`);
                                executeJalanNext();
                            }, 800);
                        } else {
                            const message = `Same coupon amount (¥${totalCurrent})`;
                            logEvent("SAME", message, "info");
                            checkUrlHashLock(message);
                            setTimeout(() => window.location.reload(), getSafeDelay(1000));
                        }
                    }
                    if (attempts > 20) clearInterval(evalInterval);
                }, 500);
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
                    while ((m = logRegex.exec(scriptText)) !== null) {
                        logMap[m[2].trim()] = m[1].trim().replace(/\\n/g, '');
                    }

                    Object.keys(logMap).forEach(v => {
                        const lowV = v.toLowerCase();
                        if (lowV.includes('start') && lowV.includes('date')) {
                            const pattern = v + "\\s*=[^`]*`\\$\\{nowYear\\}-\\$\\{padMonth\\}-([^\\+ `]+)";
                            const match = scriptText.match(new RegExp(pattern));
                            if (match) results.push({
                                name: `otoku_10days ${logMap[v]}`,
                                time: new Date(`${nowYear}-${padMonth}-${match[1]}+0900`).getTime()
                            });
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
        if (currentUrl.includes("otoku_10days") || currentUrl.includes("specialweek")) {
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
                observer.observe(link, {
                    attributes: true
                });
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

        if (currentUrl.includes("uww3201init.do") || (currentUrl.includes("yadNo=") && currentUrl.includes("planCd="))) {
            addDirectBookingButton();
        }
        if (currentUrl.includes("uwp5100/uww5106next.do")) {
            console.log(`[${TAB_ID}] 最終確認頁：執行安全性檢查...`);

            // --- A. 檢查是否滿額 (Fully Booked / Limit Reached) ---
            const fullyBookedText = "先着予約数に達した";
            const isFullyBooked = document.body && document.body.innerText.includes(fullyBookedText);

            if (isFullyBooked) {
                let retryCount = parseInt(sessionStorage.getItem("jalan_fully_booked_retry_count") || "0", 10);
                retryCount++;
                sessionStorage.setItem("jalan_fully_booked_retry_count", retryCount.toString());

                console.log(`[${TAB_ID}] ⚠️ Coupon 滿額 (第 ${retryCount} 次重試)`);

                // UI 狀態更新
                const statusEl = document.getElementById('loop-status');
                if (statusEl) {
                    statusEl.innerText = "Status: ⏳ FULLY BOOKED - RETRYING IN 5S";
                    statusEl.style.color = "#fd7e14";
                }

                if (retryCount <= 60) {
                    // --- 階段 1：首 60 次執行 F5 快速刷新 (1秒間隔) ---
                    logEvent("LIMIT REACHED", `Retry #${retryCount}: Quick F5 in 1s`, "warn");
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                } else {
                    // --- 階段 2：超過 60 次，重置計數器並跳回起點 ---
                    logEvent("LIMIT REACHED", "60 retries failed. Jumping back to Lock URL...", "error");
                    sessionStorage.setItem("jalan_fully_booked_retry_count", "0"); // 重置計數器

                    const lockedUrl = sessionStorage.getItem("jalan_last_valid_url");
                    setTimeout(() => {
                        window.location.replace(lockedUrl);
                    }, getSafeDelay(1000));
                }

                return; // 滿額就唔好再行落去
            }
            sessionStorage.setItem("jalan_fully_booked_retry_count", "0");

            // --- B. 執行名稱驗證 (防止 Ghost Coupon) ---
            // 檢查 sessionStorage 入面紀錄嘅名單係咪真係出現喺呢一頁
            const isReal = checkGhostCoupon();

            if (isReal) {
                // --- C. 驗證通過，執行最終提交 ---
                console.log(`[${TAB_ID}] ✅ 驗證通過，準備執行 confirmbookingdetail...`);
                confirmbookingdetail5106();
            } else {
                // 驗證失敗 (Ghosted)，checkGhostCoupon 內部會自動 handle 跳轉返 URL Lock
                console.log(`[${TAB_ID}] 🚨 偵測到死 Coupon (名稱不符)，執行退回重試。`);
            }
        }

        if (currentUrl.includes("uww5001init.do")) {
            selectbookingdetail(() => {
                console.log(`[${TAB_ID}] 填表狀態確認 OK，啟動 JSON 比價...`);
                checkAndConfirmBooking();
            });
        }
        if (currentUrl.includes("uww5050next.do")) {
            setTimeout(confirmbookingdetail5050, 500);
        }
    }
})();
