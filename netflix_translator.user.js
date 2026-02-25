// ==UserScript==
// @name         Netflix AI 雙語字幕 (v12 模型切換 + 即時儲存)
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
        set apiKey(v) { GM_setValue('ai_sub_apikey', v); },
        get modelType() { return GM_getValue('ai_model_type', 'free'); }, // 'free', 'paid', 'custom'
        set modelType(v) { GM_setValue('ai_model_type', v); },
        get customModel() { return GM_getValue('ai_custom_model', ''); },
        set customModel(v) { GM_setValue('ai_custom_model', v); },
        // 根據選擇回傳實際 Model ID
        get activeModel() {
            if (this.modelType === 'paid') return 'google/gemini-2.5-flash-lite-preview-09-2025';
            if (this.modelType === 'custom') return this.customModel || 'arcee-ai/trinity-large-preview:free';
            return 'arcee-ai/trinity-large-preview:free';
        }
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
        body.hide-ai-subs .ai-translated-span, 
        body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; }
    `);

    const logger = (msg, data = '') => console.log(`[${new Date().toLocaleTimeString()}] [Netflix AI] ${msg}`, data);
    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';

    // 初始化狀態
    if (!db.isEnabled) document.body.classList.add('hide-ai-subs');

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

    // --- 4. 攔截與 API 翻譯 ---
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

        const indexedInput = originalLines.map((line, idx) => `[${idx}] ${line}`).join('\n');
        toggleLoading(true);
        logger(`使用模型: ${db.activeModel} 進行翻譯...`);

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: { "Authorization": `Bearer ${db.apiKey}`, "Content-Type": "application/json" },
            data: JSON.stringify({
                model: db.activeModel,
                messages: [{
                    role: "system",
                    content: `你是一位影視翻譯員。翻譯成「標準香港繁體中文（書面語）」。嚴格遵守 [編號] 格式。嚴禁廣東話口語（如：咗、嘅、喺、唔、佢）。`
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
                    const debugLog = { stats: { model: db.activeModel, lines: originalLines.length }, mapping: [] };

                    aiLines.forEach(line => {
                        const match = line.match(/^\[(\d+)\]\s*(.*)/);
                        if (match) {
                            const idx = parseInt(match[1]);
                            const trans = match[2].replace(/^\[\d+\]\s*/, '').trim();
                            const orig = originalLines[idx];
                            if (orig) {
                                window.subtitleMap.set(getMatchKey(orig), trans);
                                debugLog.mapping.push({ id: idx, orig, trans });
                            }
                        }
                    });
                    console.log("%c=== Netflix AI Debug Mapping ===", "color: #00FF00;");
                    console.log(JSON.stringify(debugLog, null, 2));
                } finally { toggleLoading(false); }
            },
            onerror: () => toggleLoading(false)
        });
    }

    // --- 5. 渲染邏輯 ---
    const observer = new MutationObserver(() => {
        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;

            const currentMatchKey = getMatchKey(container.innerText);
            const translatedText = window.subtitleMap.get(currentMatchKey);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;
                const innerSpan = outerSpan.querySelector('span:not(.ai-translated-span)');
                if (!innerSpan) return;

                const br = document.createElement('br');
                br.className = 'ai-translated-br';
                outerSpan.appendChild(br);

                const aiSpan = innerSpan.cloneNode(true);
                aiSpan.classList.add('ai-translated-span');
                aiSpan.innerText = translatedText;
                
                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });
        injectControlMenu();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 6. 選單 UI (即時更新) ---
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
            <div id="ai-menu-popup" style="display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(20,20,20,0.98); border:1px solid #444; padding:20px; border-radius:10px; width:300px; flex-direction:column; gap:10px; z-index:999999; color:white; box-shadow: 0 8px 24px rgba(0,0,0,0.8); font-size:14px;">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 AI 字幕功能</label>
                <div style="border-top: 1px solid #444; margin: 5px 0; padding-top: 10px;">模型選擇:</div>
                <label style="display:flex; gap:8px;"><input type="radio" name="model" value="free" ${db.modelType === 'free' ? 'checked' : ''}> Free (arcee-ai)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="model" value="paid" ${db.modelType === 'paid' ? 'checked' : ''}> Paid (Gemini 2.5)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="model" value="custom" ${db.modelType === 'custom' ? 'checked' : ''}> Custom:</label>
                <input type="text" id="ai-custom-model" placeholder="Model ID" value="${db.customModel}" style="padding:5px; background:#333; color:white; border:1px solid #555; width:100%; font-size:12px; ${db.modelType === 'custom' ? '' : 'display:none;'}">
                <div style="margin-top:5px;">OpenRouter API Key:</div>
                <input type="password" id="ai-input-key" placeholder="API Key" value="${db.apiKey}" style="padding:8px; background:#333; color:white; border:1px solid #555; width:100%;">
                <button id="ai-btn-save" style="background:#E50914; color:white; border:none; padding:10px; cursor:pointer; font-weight:bold; margin-top:10px;">儲存並立即生效</button>
            </div>
        `;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const spacer = document.createElement('div'); spacer.style = "min-width: 3rem; width: 3rem;";
        btnWrapper.parentNode.insertBefore(spacer, btnWrapper);

        // UI 互動邏輯
        document.getElementById('ai-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            const popup = document.getElementById('ai-menu-popup');
            popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
        };

        const customRadio = document.querySelectorAll('input[name="model"]');
        customRadio.forEach(r => r.onchange = () => {
            document.getElementById('ai-custom-model').style.display = (r.value === 'custom') ? 'block' : 'none';
        });

        document.getElementById('ai-btn-save').onclick = () => {
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.apiKey = document.getElementById('ai-input-key').value.trim();
            db.modelType = document.querySelector('input[name="model"]:checked').value;
            db.customModel = document.getElementById('ai-custom-model').value.trim();
            
            // 即時反應
            document.body.classList.toggle('hide-ai-subs', !db.isEnabled);
            document.getElementById('ai-menu-popup').style.display = 'none';
            logger("設定已即時更新，無需重新整理。");
        };

        document.addEventListener('click', (e) => {
            const popup = document.getElementById('ai-menu-popup');
            if (popup && popup.style.display === 'flex' && !wrapper.contains(e.target)) popup.style.display = 'none';
        });
    }
})();
