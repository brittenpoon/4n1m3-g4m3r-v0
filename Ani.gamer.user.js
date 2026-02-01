// ==UserScript==
// @name         Ani.gamer Auto Clicker (v2.1 Master)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  自動點擊原生廣告、Google iframe 廣告及成年人同意
// @author       You
// @match        https://ani.gamer.com.tw/animeVideo.php*
// @match        https://*.googlesyndication.com/*
// @match        https://*.doubleclick.net/*
// @grant        none
// @allFrames    true
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const selectors = [
        '.nativeAD-skip-button.enable',   // 1. 原生 Native Ad (點此跳過廣告)
        'div[aria-label="Skip Ad"]',      // 2. Google Iframe 廣告
        'div[aria-label="跳過廣告"]',      // 3. 中文化廣告按鈕
        '[data-ck-tag="skip"]',           // 4. 動態標籤廣告
        '#adult',                         // 5. 成年同意
        '#adSkipButton.enable',           // 6. 舊版跳過按鈕
        '.videoAdUiSkipIcon',             // 7. YouTube 風格跳過
        '.vjs-overlay-content button'     // 8. 影片內疊層按鈕
    ];

    function performClick() {
        selectors.forEach(selector => {
            // 使用 querySelectorAll 處理頁面中可能同時出現的多個按鈕
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                // 檢查元素是否可見且未被隱藏
                if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.offsetParent !== null)) {
                    // 如果按鈕內有文字「點此跳過廣告」，額外記錄方便 debug
                    if (el.classList.contains('nativeAD-skip-button')) {
                         console.log('[AutoClick] Found Native Ad Button');
                    }
                    el.click();
                }
            });
        });
    }

    // 監控 DOM 變動 (處理動態生成按鈕)
    const observer = new MutationObserver(performClick);
    observer.observe(document.body, { childList: true, subtree: true });

    // 每 500ms 檢查一次 (作為保險，防止 MutationObserver 漏掉特定 iframe 變動)
    setInterval(performClick, 500);

    // 初始執行
    performClick();
})();
