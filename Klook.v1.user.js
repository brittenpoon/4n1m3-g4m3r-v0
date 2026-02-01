// ==UserScript==
// @name         Klook Auto Redeem - Two-Shot Strategy
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  頁面加載時試射一次，準時再射第二次
// @author       Gemini
// @match        https://www.klook.com/zh-HK/tetris/promo/joyfuldeals/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const attemptedCounts = new Map(); // 記錄每個 Code 射咗幾多次
    const scheduledCodes = new Set();
    let hasExpanded = false;

    function getTargetTime(item) {
        const section = item.closest('.coupon-list');
        const titleEl = section ? section.querySelector('.section-title') : document.querySelector('.section-title');
        if (!titleEl) return null;

        const match = titleEl.innerText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
        if (match) {
            const [_, day, month, hour, min, ampm] = match;
            let h = parseInt(hour);
            if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
            if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
            const m = min ? parseInt(min) : 0;
            return new Date(`2025-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:00+08:00`).getTime();
        }
        return null;
    }

    function setPageLabel(element, text, color = "#fa8c16") {
        let label = element.querySelector('.lean-status-label');
        if (!label) {
            label = document.createElement('div');
            label.className = 'lean-status-label';
            label.style.cssText = 'font-size: 11px; font-weight: bold; margin-top: 4px; padding: 2px 4px; border-radius: 3px; border: 1px solid; display: inline-block; font-family: monospace;';
            element.appendChild(label);
        }
        label.innerText = text;
        label.style.color = color;
        label.style.borderColor = color;
    }

    async function fire(code, element, reason) {
        const count = attemptedCounts.get(code) || 0;

        // 限制：每個 Code 最多只會射兩次 (一次 Load 時，一次準時)
        if (count >= 2) return;
        attemptedCounts.set(code, count + 1);

        console.log(`%c[FIRE #${count + 1}] ${code} | Reason: ${reason} | Time: ${new Date().toISOString()}`, "color: white; background: #f44336; font-weight: bold; padding: 2px 5px;");


        fetch("https://www.klook.com/v1/couponapisrv/redeem", {
            method: "POST",
            headers: {
                "accept": "application/json, text/plain, */*",
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                "x-platform": "desktop",
                "x-requested-with": "XMLHttpRequest"
            },
            body: `code=${encodeURIComponent(code)}`,
            credentials: "include"
        }).then(res => res.json()).then(data => {
            console.log(`%c[RESULT #${count + 1}] ${code}:`, "font-weight: bold;", data);

            if (data.success || data.ret === 0) {
                setPageLabel(element, `✅ Success: ${data.data?.redemption_time || 'Redeemed'}`, "#52c41a");
                attemptedCounts.set(code, 99); // 成功後標記為 99 防止再射
            } else {
                const msg = data.error?.message || data.msg || 'Failed';
            }
        }).catch(err => {
            console.error(`[ERR] ${code}:`, err);
            setPageLabel(element, "⚠️ Network Error", "#ff4d4f");
        });
    }

    function engine() {
        if (!hasExpanded) {
            const btns = document.querySelectorAll('.more-btn');
            if (btns.length > 0) {
                btns.forEach(b => { if (b.innerText.includes('查看更多')) b.click(); });
                hasExpanded = true;
            }
        }

        const now = Date.now();
        const items = document.querySelectorAll('.coupon-item');

        items.forEach(item => {
            const subTitle = item.querySelector('.sub-title span');
            if (!subTitle) return;

            const codeMatch = subTitle.innerText.match(/優惠碼:\s*([A-Z0-9_-]+)/i);
            if (!codeMatch) return;
            const code = codeMatch[1].trim();

            const isNotStarted = item.querySelector('.not_start');
            const isToUse = item.querySelector('.to_use, .use');

            if (isToUse || (attemptedCounts.get(code) >= 2 && attemptedCounts.get(code) !== 99)) return;

            const target = getTargetTime(item);
            if (!target) return;

            // 1. 排程顯示 & 第一次試射 (Load-time Fire)
            if (isNotStarted && !scheduledCodes.has(code)) {
                scheduledCodes.add(code);

                const hkDate = new Date(target);
                const hkTimeFormatted = hkDate.toLocaleString('zh-HK', {
                    timeZone: 'Asia/Hong_Kong',
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
                }).replace(/\//g, '-');

                console.log(`%c[SCHEDULED] ${code} | Target HKT: ${hkTimeFormatted}`, "color: #2196F3");
                setPageLabel(item, `[schedule] ${code} | Target HKT: ${hkTimeFormatted.replace(/-/g, '/')}`);

                // 即刻進行第一次「試探性領取」
                fire(code, item, "Load-time Test");
            }

            // 2. 第二次正式開火 (Target-time Fire)
            // 觸發：按鈕變可領取 OR 踏入開搶時間
            const isRedeemable = item.querySelector('button.redeem, .to_redeem');
            if ((isRedeemable || target <= now) && (attemptedCounts.get(code) === 1)) {
                fire(code, item, "On-time Final");
            }
        });
    }

    console.clear();
    console.log("%c KLOOK TWO-SHOT ENGINE ACTIVE ", "background: #FF5B00; color: #fff; font-size: 14px; font-weight: bold;");
    setInterval(engine, 50);
})();
