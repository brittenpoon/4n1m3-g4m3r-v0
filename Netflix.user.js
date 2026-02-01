// ==UserScript==
// @name         Netflix Auto Next, Skip Intro & Recap (Robust)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Clicks "Next Episode", "Skip Intro", and "Skip Recap" reliably on Netflix
// @author       You
// @match        https://www.netflix.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    function safeClick(selector, label) {
        try {
            const button = document.querySelector(selector);
            if (button && typeof button.click === 'function') {
                console.log(`[${new Date().toLocaleTimeString()}] Clicking "${label}"`);
                button.click();
            }
        } catch (err) {
            console.warn(`[${new Date().toLocaleTimeString()}] Error clicking "${label}":`, err);
        }
    }

    function runAutomation() {
        safeClick('button[data-uia="next-episode-seamless-button"]', 'Next Episode');
        safeClick('button[data-uia="player-skip-intro"]', 'Skip Intro');
        safeClick('button[data-uia="player-skip-recap"]', 'Skip Recap');
    }

    // Run every 2 seconds without crashing
    setInterval(runAutomation, 2000);
})();
