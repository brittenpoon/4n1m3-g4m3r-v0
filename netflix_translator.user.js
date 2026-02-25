// ==UserScript==
// @name         Netflix AI 雙語字幕 (v11 Debug & New Span)
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      openrouter.ai
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. Database & Settings ---
    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get apiKey() { return GM_getValue('ai_sub_apikey', ''); },
        set apiKey(v) { GM_setValue('ai_sub_apikey', v); }
    };

    window.subtitleMap = new Map();
    window.isAITranslating = false;

    // --- 2. 樣式注入 ---
    GM_addStyle(`
        #ai-translation-loader {
            position: fixed; top: 12%; left: 50%; transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.9); color: #fff; padding: 15px 30px;
            border-radius: 8px; font-size: 18px; z-index: 999999; display: none;
            border: 1px solid #FFD700; pointer-events: none;
        }
        body.hide-ai-subs .ai-translated-span { display: none !important; }
        /* 確保新 Span 換行顯示 */
        .ai-translated-span { display: inline-block !important; }
    `);

    const logger = (msg, data = '') => console.log(`[${new Date().toLocaleTimeString()}] [Netflix AI] ${msg}`, data);
    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';

    // --- 3. 播放控制 (Auto-pause) ---
    const forceVideoState = (shouldPause) => {
        const pauseBtn = document.querySelector('[data-uia="control-play-pause-pause"]');
        const video = document.querySelector('video');
        if (shouldPause && pauseBtn) pauseBtn.click();
        else if (!shouldPause && document.querySelector('[data-uia="control-play-pause-play"]')) {
            document.querySelector('[data-uia="control-play-pause-play"]').click();
        }
    };

    const toggleLoading = (isTranslating) => {
        window.isAITranslating = isTranslating;
        let loader = document.getElementById('ai-translation-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'ai-translation-loader';
            document.body.appendChild(loader);
        }
        loader.style.display = isTranslating ? 'block' : 'none';

        if (isTranslating) {
            window.pauseInterval = setInterval(() => {
                if (document.querySelector('.watch-video--bottom-controls-container')) forceVideoState(true);
            }, 500);
        } else {
            clearInterval(window.pauseInterval);
            setTimeout(() => forceVideoState(false), 500);
        }
    };

    // --- 4. 攔截與 API 翻譯 (帶 JSON Log) ---
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                if (!db.isEnabled || !db.apiKey) return;
                await processAndTranslate(this.responseText);
            });
        }
        oldOpen.apply(this, arguments);
    };

    async function processAndTranslate(rawXml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawXml, "text/xml");
        const pTags = Array.from(doc.querySelectorAll('p'));

        const originalLines = pTags.map(p => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = p.innerHTML.replace(/<br\s*\/?>/gi, ' ');
            return tempDiv.textContent.trim();
        }).filter(t => t.length > 0);

        if (originalLines.length === 0) return;

        // 索引標記 (後台對齊用)
        const indexedInput = originalLines.map((line, idx) => `[${idx}] ${line}`).join('\n');

        toggleLoading(true);

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: { "Authorization": `Bearer ${db.apiKey}`, "Content-Type": "application/json" },
            data: JSON.stringify({
                model: "google/gemini-2.0-flash-001",
                messages: [{
                    role: "system",
                    content: `你是一位影視翻譯員。翻譯成「標準香港繁體中文（書面語）」。
                    【規則】
                    1. 每行必須以 [編號] 開頭，例如 "[0] 譯文"。
                    2. 嚴禁廣東話口語（唔好用：咗、嘅、喺、唔、佢）。
                    3. 必須對齊行數，即使是符號也回傳編號。`
                }, {
                    role: "user",
                    content: indexedInput
                }]
            }),
            onload: function(res) {
                try {
                    const json = JSON.parse(res.responseText);
                    const aiLines = json.choices[0].message.content.split('\n');

                    window.subtitleMap.clear();
                    const debugLog = { stats: { original: originalLines.length, aiReceived: aiLines.length }, mapping: [] };

                    aiLines.forEach(line => {
                        const match = line.match(/^\[(\d+)\]\s*(.*)/);
                        if (match) {
                            const idx = parseInt(match[1]);
                            const translatedText = match[2].replace(/^\[\d+\]\s*/, '').trim(); // 雙重保險移除編號
                            const originalText = originalLines[idx];
                            if (originalText) {
                                window.subtitleMap.set(getMatchKey(originalText), translatedText);
                                debugLog.mapping.push({ id: idx, orig: originalText, trans: translatedText });
                            }
                        }
                    });

                    // 輸出 Debug JSON
                    console.log("%c=== Netflix AI Debug Mapping ===", "color: #00FF00; font-weight: bold;");
                    console.log(JSON.stringify(debugLog, null, 2));
                    console.log("%c===============================", "color: #00FF00; font-weight: bold;");

                } finally { toggleLoading(false); }
            },
            onerror: () => toggleLoading(false)
        });
    }

    // --- 5. 渲染邏輯 (New Span + BR) ---
    const observer = new MutationObserver(() => {
        if (!db.isEnabled) return;

        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;

            const currentMatchKey = getMatchKey(container.innerText);
            const translatedText = window.subtitleMap.get(currentMatchKey);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;

                // 搵原生帶 Style 嘅內層 Span
                const innerSpan = outerSpan.querySelector('span:not(.ai-translated-span)');
                if (!innerSpan) return;

                // 1. 插入原生樣式的 <br> (Netflix 有時 <br> 都帶 style)
                const br = document.createElement('br');
                outerSpan.appendChild(br);

                // 2. 建立全新的 Span 並 Clone 原生樣式
                const aiSpan = innerSpan.cloneNode(true);
                aiSpan.classList.add('ai-translated-span');
                aiSpan.innerText = translatedText; // 絕對唔會帶編號

                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });

        injectControlMenu();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 6. 選單 UI (略，同之前一樣) ---
    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper';
        wrapper.style.display = 'flex';
        wrapper.innerHTML = `
            <div class="${btnWrapper.className}"><button class="${targetBtn.className}" id="ai-toggle-btn" style="color:white; font-weight:bold; font-size:16px;">AI 譯</button></div>
            <div id="ai-menu-popup" style="display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(20,20,20,0.98); border:1px solid #444; padding:20px; border-radius:10px; width:280px; flex-direction:column; gap:12px; z-index:999999; color:white; box-shadow: 0 8px 24px rgba(0,0,0,0.8);">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 AI 翻譯</label>
                <input type="password" id="ai-input-key" placeholder="API Key" value="${db.apiKey}" style="padding:10px; background:#333; color:white; border:1px solid #555; width:100%;">
                <button id="ai-btn-save" style="background:#E50914; color:white; border:none; padding:10px; cursor:pointer; font-weight:bold;">儲存</button>
            </div>
        `;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const spacer = document.createElement('div'); spacer.style = "min-width: 3rem; width: 3rem;";
        btnWrapper.parentNode.insertBefore(spacer, btnWrapper);

        document.getElementById('ai-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            const popup = document.getElementById('ai-menu-popup');
            popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
        };
        document.getElementById('ai-btn-save').onclick = () => {
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.apiKey = document.getElementById('ai-input-key').value.trim();
            location.reload();
        };
    }
})();
