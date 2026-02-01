// ==UserScript==
// @name         YouTube 訂閱搬運工 (Export & Auto-Sub)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  第一階段導出 JSON 列表，第二階段自動前往各頻道點擊訂閱
// @author       Your Name
// @match        https://www.youtube.com/feed/channels
// @match        https://www.youtube.com/@*
// @match        https://www.youtube.com/channel/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ================= 配置區 =================
    const CONFIG = {
        scrollDelay: 2000,    // 捲動等待時間 (ms)
        actionDelay: 4000,    // 訂閱後等待時間 (ms) - 建議設長啲防止被封
        autoStartImport: false // 是否開啟自動導入功能 (建議要用先改 true)
    };

    // ================= 功能 1: 導出 (Export) =================
    // 執行位置: https://www.youtube.com/feed/channels
    async function exportSubscriptions() {
        console.log("開始導出流程... 請勿切換分頁");

        let lastHeight = 0;
        while (true) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise(r => setTimeout(r, CONFIG.scrollDelay));
            let newHeight = document.documentElement.scrollHeight;
            if (newHeight === lastHeight) break;
            lastHeight = newHeight;
            console.log("正在加載頻道列表...");
        }

        const channels = [];
        document.querySelectorAll('ytd-channel-renderer').forEach(el => {
            const name = el.querySelector('#text')?.innerText;
            const link = el.querySelector('#main-link')?.href;
            if (name && link) channels.push({ name, link });
        });

        const blob = new Blob([JSON.stringify(channels, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `youtube_subs_${new Date().getTime()}.json`;
        a.click();
        console.log(`導出完成！共 ${channels.length} 個頻道。`);
    }

    // ================= 功能 2: 導入 (Import & Subscribe) =================
    // 執行位置: 任何 YouTube 頻道頁面
    // 使用方法: 先將導出嘅 JSON 數據貼入下方 subscribeList
    const subscribeList = []; // <--- 喺呢度貼入 [ { "name": "...", "link": "..." }, ... ]

    function autoSubscribe() {
        let currentIndex = parseInt(localStorage.getItem('yt_sub_index') || 0);

        if (currentIndex >= subscribeList.length) {
            console.log("所有訂閱操作已完成！");
            localStorage.removeItem('yt_sub_index');
            return;
        }

        const target = subscribeList[currentIndex];

        // 如果唔喺目標頻道，就跳轉
        if (!window.location.href.includes(target.link.split('youtube.com')[1])) {
            console.log(`跳轉至: ${target.name}`);
            window.location.href = target.link;
            return;
        }

        // 喺頻道頁面執行訂閱
        setTimeout(() => {
            // 搵訂閱掣 (考慮到 YouTube 會改版，用多重 Selector)
            const subBtn = document.querySelector('ytd-subscribe-button-renderer button') ||
                           document.querySelector('button[aria-label*="訂閱"]');

            const isSubscribed = subBtn?.innerText.includes('已訂閱') ||
                                 subBtn?.getAttribute('aria-pressed') === 'true';

            if (subBtn && !isSubscribed) {
                console.log(`點擊訂閱: ${target.name}`);
                subBtn.click();
            } else {
                console.log(`跳過 (已訂閱或找不到掣): ${target.name}`);
            }

            // 更新索引並去下一個
            localStorage.setItem('yt_sub_index', currentIndex + 1);
            setTimeout(() => {
                const nextTarget = subscribeList[currentIndex + 1];
                if (nextTarget) window.location.href = nextTarget.link;
            }, CONFIG.actionDelay);

        }, 3000); // 畀 3 秒時間 Loading 頁面
    }

    // ================= 控制邏輯 =================
    if (window.location.href.includes('/feed/channels')) {
        // 加個簡單按鈕喺畫面
        const btn = document.createElement('button');
        btn.innerText = "開始導出訂閱名單";
        btn.style = "position:fixed; top:80px; right:20px; z-index:9999; padding:10px; background:red; color:white; border:none; cursor:pointer;";
        btn.onclick = exportSubscriptions;
        document.body.appendChild(btn);
    }

    if (CONFIG.autoStartImport && subscribeList.length > 0) {
        autoSubscribe();
    }

})();
