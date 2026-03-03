// ==UserScript==
// @name         Netflix Auto Next, Skip Intro & Recap (With UI Check)
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Skips Netflix extras but pauses for 2 mins if bottom controls are visible
// @author       You
// @match        https://www.netflix.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    let isOnCooldown = false;
    const CONTROL_CLASS = 'watch-video--bottom-controls-container';

    function safeClick(selector, label) {
        const button = document.querySelector(selector);
        if (!button) return false;

        // Button found! Now start the 5s high-frequency check for UI interference
        console.log(`[${new Date().toLocaleTimeString()}] Potential "${label}" found. Checking for UI...`);

        let checkCount = 0;
        const checkInterval = setInterval(() => {
            const controls = document.querySelector(`.${CONTROL_CLASS}`);

            if (controls) {
                console.log(`[${new Date().toLocaleTimeString()}] UI detected! Entering 2min cooldown.`);
                isOnCooldown = true;
                clearInterval(checkInterval);

                // Reset cooldown after 2 minutes
                setTimeout(() => {
                    isOnCooldown = false;
                    console.log(`[${new Date().toLocaleTimeString()}] Cooldown ended.`);
                }, 120000);
                return;
            }

            checkCount++;

            // If we've checked for 5s (10 intervals of 0.5s) and found no UI, click it
            if (checkCount >= 10) {
                clearInterval(checkInterval);
                if (button && typeof button.click === 'function') {
                    console.log(`[${new Date().toLocaleTimeString()}] Area clear. Clicking "${label}"`);
                    button.click();
                }
            }
        }, 500);

        return true;
    }

    function runAutomation() {
        if (isOnCooldown) return;

        // Try to find any of the target buttons
        const selectors = [
            { sel: 'button[data-uia="next-episode-seamless-button"]', label: 'Next Episode' },
            { sel: 'button[data-uia="player-skip-intro"]', label: 'Skip Intro' },
            { sel: 'button[data-uia="player-skip-recap"]', label: 'Skip Recap' }
        ];

        for (const item of selectors) {
            if (document.querySelector(item.sel)) {
                safeClick(item.sel, item.label);
                break; // Only handle one button logic at a time
            }
        }
    }

    // Main loop: check every 2 seconds
    setInterval(runAutomation, 2000);
})();
