// ==UserScript==
// @name         Klook Auto Redeem - Ironclad v12.4
// @namespace    http://tampermonkey.net/
// @version      12.4
// @description  身分持久化：跨 Session 紀錄同步，徹底杜絕重複領取 (50052)
// @author       Gemini
// @match        https://www.klook.com/zh-HK/tetris/promo/*
// @match        https://www.klook.com/zh-HK/deals/*
// @match        https://www.klook.com/zh-HK/experiences/pay/*
// @match        https://www.klook.com/zh-HK/account/security*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    const isPayPage = window.location.href.includes("/experiences/pay/");
    // 從持久化存儲讀取 Email，避免新 Session 變回 GUEST
    let currentUID = GM_getValue('KLK_SAVED_EMAIL', "GUEST");
    let redeemDB = JSON.parse(GM_getValue("klook_v9_db", "{}"));
    let targetCode = null;
    let openInputs = 0;
    const firedSet = new Set();

    // --- 1. 右側監控面板 (顯示當前用戶) ---
    function updateMonitor() {
        let panel = document.getElementById('klk-dual-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'klk-dual-panel';
            panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:10000;background:rgba(0,0,0,0.9);color:#fff;padding:12px;border-radius:8px;width:260px;font-family:monospace;font-size:11px;box-shadow:0 0 15px rgba(255,255,255,0.2);';
            document.body.appendChild(panel);
        }

        const userTag = `<div style="font-size:10px;color:#aaa;margin-bottom:5px;border-bottom:1px solid #333;">User: ${currentUID}</div>`;
        const title = isPayPage ? '<div style="color:#f1c40f;font-weight:bold;margin-bottom:8px;">🎯 支付頁目標</div>' : '<div style="color:#2ecc71;font-weight:bold;margin-bottom:8px;">📡 自動監控中</div>';

        let listHtml = '';
        let hasTask = false;

        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith("TIME_")) {
                const code = k.replace("TIME_", "");
                // 檢查 DB 是否已有該 Email 對應此 Code 的成功紀錄
                if (redeemDB[`${currentUID}_${code}`]) continue;
                hasTask = true;
                const hkt = localStorage.getItem(k);

                if (isPayPage) {
                    listHtml += `<label style="display:block;margin-bottom:8px;cursor:pointer;"><input type="radio" name="pay-target" value="${code}" ${targetCode === code ? 'checked' : ''}> <b>${code}</b><br><small style="margin-left:22px;color:#0f0;">${hkt}</small></label>`;
                } else {
                    listHtml += `<div style="margin-bottom:8px;border-bottom:1px solid #333;padding-bottom:4px;">• <b>${code}</b><br><small style="color:#0f0;margin-left:10px;">${hkt}</small></div>`;
                }
                // 同步清理左側重複彈窗
                const leftBox = document.getElementById(`input-box-${code}`);
                if (leftBox) leftBox.remove();
            }
        }
        panel.innerHTML = userTag + title + (hasTask ? listHtml : '<small>暫無待領取任務</small>');

        if (isPayPage) {
            panel.querySelectorAll('input[type="radio"]').forEach(radio => {
                radio.onclick = () => {
                    targetCode = radio.value;
                    const input = document.querySelector('.redeem-input input');
                    if (input) { input.value = targetCode; input.dispatchEvent(new Event('input', { bubbles: true })); }
                };
            });
        }
    }

    // --- 2. 懸浮輸入框 ---
    function showFloatingInput(code) {
        if (localStorage.getItem(`TIME_${code}`) || redeemDB[`${currentUID}_${code}`] || document.getElementById(`input-box-${code}`)) return;

        const panel = document.createElement('div');
        panel.id = `input-box-${code}`;
        panel.className = 'klk-floating-input-box';
        const topOffset = 100 + (openInputs * 170);
        panel.style.cssText = `position:fixed;top:${topOffset}px;left:20px;z-index:10001;background:#fff;border:2px solid #e67e22;padding:15px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.4);width:280px;color:#333;`;
        panel.innerHTML = `<div style="font-weight:bold;margin-bottom:8px;">發現代碼: ${code}</div><div style="font-size:12px;margin-bottom:5px;">領取 HKT (YYYYMMDD HH:mm:ss):</div><input type="text" id="time-val-${code}" placeholder="20260119 10:00:00" style="width:100%;padding:8px;margin-bottom:10px;border:1px solid #ccc;box-sizing:border-box;"><button id="save-btn-${code}" style="background:#e67e22;color:#fff;border:none;padding:10px;cursor:pointer;width:100%;font-weight:bold;border-radius:4px;">設定排程</button>`;
        document.body.appendChild(panel);
        openInputs++;

        document.getElementById(`save-btn-${code}`).onclick = () => {
            const val = document.getElementById(`time-val-${code}`).value.trim();
            if (/^\d{8}\s\d{2}:\d{2}:\d{2}$/.test(val)) {
                localStorage.setItem(`TIME_${code}`, val);
                panel.remove();
                updateMonitor();
            } else { alert("格式錯誤！"); }
        };
    }

    // --- 3. 核心發射與提交 (Pay Page) ---
    function checkAndSubmit(code) {
        const card = document.querySelector(`#mkt-coupon-card-${code}`);
        const isSelected = card && (card.classList.contains('is-chosen') || card.querySelector('.radio-check'));
        if (isSelected) {
            const btn = document.querySelector('.js-pay-btn');
            if (btn) {
                btn.click();
                redeemDB[`${currentUID}_${code}`] = { status: "DONE", time: new Date().toISOString() };
                GM_setValue("klook_v9_db", JSON.stringify(redeemDB));
            }
            return true;
        }
        return false;
    }

    function masterEngine() {
        if (currentUID === "GUEST") return;
        const now = Date.now();

        if (isPayPage && targetCode) {
            const hkt = localStorage.getItem(`TIME_${targetCode}`);
            if (hkt) {
                const targetTs = new Date(`${hkt.substring(0,4)}-${hkt.substring(4,6)}-${hkt.substring(6,8)}T${hkt.substring(9)}+08:00`).getTime();
                if (now >= targetTs && !firedSet.has(targetCode)) {
                    firedSet.add(targetCode);
                    const btn = document.querySelector('#redeem');
                    if (btn) btn.click();
                }
                if (firedSet.has(targetCode)) checkAndSubmit(targetCode);
            }
        }

        if (!isPayPage) {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith("TIME_")) {
                    const code = k.replace("TIME_","");
                    if (redeemDB[`${currentUID}_${code}`] || firedSet.has(k)) continue;
                    const hkt = localStorage.getItem(k);
                    const targetTs = new Date(`${hkt.substring(0,4)}-${hkt.substring(4,6)}-${hkt.substring(6,8)}T${hkt.substring(9)}+08:00`).getTime();
                    if (now >= targetTs) {
                        firedSet.add(k);
                        fetch("https://www.klook.com/v1/couponapisrv/redeem", {
                            method: "POST",
                            headers: { "content-type": "application/x-www-form-urlencoded" },
                            body: "code=" + encodeURIComponent(code),
                            credentials: "include"
                        }).then(r => r.json()).then(data => {
                            const err = String(data.error?.code || "0");
                            // 0:成功, 50052:領過, 50009:用完, 50018:到期
                            if (data.success || ["0", "50009", "50018", "50002", "50052"].includes(err)) {
                                redeemDB[`${currentUID}_${code}`] = { status: "STOP", reason: err };
                                GM_setValue("klook_v9_db", JSON.stringify(redeemDB));
                                updateMonitor();
                            }
                        });
                    }
                }
            }
        }
    }

    // --- 4. 挖掘引擎 ---
    function miningEngine() {
        if (isPayPage || currentUID === "GUEST") return;
        const regexes = [/優惠碼:\s*([A-Z0-9_-]+)/gi, /「([A-Z0-9_-]+)」/gi, /輸入\s*([A-Z0-9_-]+)/gi];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walk.nextNode()) {
            regexes.forEach(reg => {
                let m;
                while ((m = reg.exec(node.textContent)) !== null) {
                    const code = m[1].trim();
                    // 根據當前 Email ID 預判
                    if (!redeemDB[`${currentUID}_${code}`] && !localStorage.getItem(`TIME_${code}`)) {
                        fetch("https://www.klook.com/v1/couponapisrv/redeem", {
                            method: "POST",
                            headers: { "content-type": "application/x-www-form-urlencoded" },
                            body: "code=" + encodeURIComponent(code),
                            credentials: "include"
                        }).then(r => r.json()).then(data => {
                            const err = String(data.error?.code || "");
                            if (["50021", "50008"].includes(err)) {
                                showFloatingInput(code);
                            } else if (err === "50052" || data.success) {
                                // 領過或成功，立即入紀錄
                                redeemDB[`${currentUID}_${code}`] = { status: "STOP", reason: "ALREADY" };
                                GM_setValue("klook_v9_db", JSON.stringify(redeemDB));
                            }
                        });
                    }
                }
            });
        }
    }

    // --- 5. 啟動與回航 ---
    (async () => {
        const isSecurity = window.location.href.includes("account/security");

        if (currentUID === "GUEST" || isSecurity) {
            if (isSecurity) {
                setInterval(() => {
                    const emailCard = Array.from(document.querySelectorAll('.bind-card')).find(el => el.innerText.includes('電郵'));
                    const emailText = emailCard?.querySelector('.card-desc')?.innerText.trim();
                    if (emailText && emailText.includes('@') && !emailText.includes('*')) {
                        GM_setValue('KLK_SAVED_EMAIL', emailText);
                        window.location.href = localStorage.getItem('KLK_RETURN_URL') || "https://www.klook.com/zh-HK/";
                    }
                }, 1000);
            } else {
                localStorage.setItem('KLK_RETURN_URL', window.location.href);
                window.location.href = "https://www.klook.com/zh-HK/account/security/";
            }
        } else {
            console.log("Logged as:", currentUID);
            updateMonitor();
            setInterval(masterEngine, 10);
            if (!isPayPage) setInterval(miningEngine, 4000);
            setInterval(updateMonitor, 5000);

            const reset = document.createElement('div');
            reset.innerText = 'Reset All';
            reset.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:10001;background:#e74c3c;color:#fff;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:10px;';
            reset.onclick = () => { if(confirm("確定清除所有帳戶紀錄同排程？")){ GM_setValue("klook_v9_db", "{}"); GM_setValue("KLK_SAVED_EMAIL", "GUEST"); localStorage.clear(); location.reload(); } };
            document.body.appendChild(reset);
        }
    })();
})();
