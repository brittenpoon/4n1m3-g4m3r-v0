// ==UserScript==
// @name         Netflix AI 雙語字幕 (v1.18.0)
// @version      1.18.0
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      openrouter.ai
// ==/UserScript==

//@ version 1.18.0

(function() {
    'use strict';

    // --- 1. Database & Settings ---
    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get apiKey() { return GM_getValue('ai_sub_apikey', ''); },
        set apiKey(v) { GM_setValue('ai_sub_apikey', v); },
        get modelType() { return GM_getValue('ai_model_type', 'free'); },
        set modelType(v) { GM_setValue('ai_model_type', v); },
        get customModel() { return GM_getValue('ai_custom_model', ''); },
        set customModel(v) { GM_setValue('ai_custom_model', v); },
        get activeModel() {
            if (this.modelType === 'paid') return 'google/gemini-2.5-flash-lite-preview-09-2025';
            if (this.modelType === 'custom') return this.customModel || 'arcee-ai/trinity-large-preview:free';
            return 'arcee-ai/trinity-large-preview:free';
        },
        get stats() { return GM_getValue('ai_perf_stats', {}); },
        set stats(v) { GM_setValue('ai_perf_stats', v); }
    };

    window.subtitleMap = new Map();
    window.isAITranslating = false;
    window.autoPauseTimer = null;

    // --- 2. 樣式注入 ---
    GM_addStyle(`
        #ai-translation-loader {
            position: fixed; top: 12%; left: 50%; transform: translateX(-50%);
            background: rgba(10, 10, 10, 0.95); color: #fff; padding: 20px 35px;
            border-radius: 12px; font-size: 18px; z-index: 2000001; display: none;
            border: 1px solid #FFD700; pointer-events: none; text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.9); line-height: 1.6;
        }
        #ai-menu-popup { pointer-events: auto !important; z-index: 2000002; }
        body.hide-ai-subs .ai-translated-span, 
        body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; }
    `);

    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';

    // --- 3. 效能預算 ---
    const getEstimatedTime = (lineCount) => {
        const stats = db.stats[db.activeModel];
        if (!stats || stats.totalLines === 0) return "計算中...";
        const avgPerLine = stats.totalTime / stats.totalLines;
        return Math.round((avgPerLine * lineCount) / 1000) + " 秒";
    };

    const updateStats = (ms, lines) => {
        const allStats = db.stats;
        const m = db.activeModel;
        if (!allStats[m]) allStats[m] = { totalTime: 0, totalLines: 0 };
        allStats[m].totalTime += ms;
        allStats[m].totalLines += lines;
        db.stats = allStats;
    };

    // --- 4. UI 提示與智慧暫停 ---
    const toggleLoading = (isTranslating, lineCount = 0) => {
        window.isAITranslating = isTranslating;
        let loader = document.getElementById('ai-translation-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'ai-translation-loader';
            document.body.appendChild(loader);
        }

        if (isTranslating) {
            const startTime = Date.now();
            const est = getEstimatedTime(lineCount);
            window.uiTimer = setInterval(() => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                loader.innerHTML = `
                    <div style="font-weight:bold; color:#FFD700; margin-bottom:5px;">⏳ AI 字幕翻譯中...</div>
                    <div style="font-size:13px; color:#ccc;">模型: ${db.activeModel.split('/').pop()}</div>
                    <div style="font-size:14px; margin:5px 0;">已用: ${elapsed}s / 預計: ${est}</div>
                    <div style="font-size:11px; color:#888;">正在處理 ${lineCount} 行字幕</div>
                `;
            }, 1000);
            loader.style.display = 'block';

            window.autoPauseTimer = setInterval(() => {
                const video = document.querySelector('video');
                if (video && !video.paused) {
                    const pauseBtn = document.querySelector('[data-uia="control-play-pause-pause"]');
                    if (pauseBtn) pauseBtn.click();
                    else video.pause();
                } else if (video && video.paused) {
                    clearInterval(window.autoPauseTimer);
                }
            }, 500);
        } else {
            clearInterval(window.uiTimer);
            clearInterval(window.autoPauseTimer);
            loader.style.display = 'none';
            const playBtn = document.querySelector('[data-uia="control-play-pause-play"]');
            if (playBtn) playBtn.click();
        }
    };

    // --- 5. 攔截與 API 翻譯 ---
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
        const reqStartTime = performance.now();
        toggleLoading(true, originalLines.length);

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: { "Authorization": `Bearer ${db.apiKey}`, "Content-Type": "application/json" },
            data: JSON.stringify({
                model: db.activeModel,
                messages: [{
                    role: "system",
                    content: `你是一位影視翻譯員。翻譯成「標準香港繁體中文（書面語）」。嚴格遵守 [編號] 格式。嚴禁廣東話口語（如 咗、嘅、喺、唔、佢）。`
                }, {
                    role: "user",
                    content: indexedInput
                }]
            }),
            onload: function(res) {
                try {
                    const json = JSON.parse(res.responseText);
                    const aiLines = json.choices[0].message.content.split('\n');
                    const duration = performance.now() - reqStartTime;
                    updateStats(duration, originalLines.length);

                    window.subtitleMap.clear();
                    aiLines.forEach(line => {
                        const match = line.match(/^\[(\d+)\]\s*(.*)/);
                        if (match) {
                            const idx = parseInt(match[1]);
                            const trans = match[2].replace(/^\[\d+\]\s*/, '').trim();
                            const orig = originalLines[idx];
                            if (orig) window.subtitleMap.set(getMatchKey(orig), trans);
                        }
                    });
                } finally { toggleLoading(false); }
            },
            onerror: () => toggleLoading(false)
        });
    }

    // --- 6. 核心渲染 (0.8x 原文 + 1.0x 譯文 + 置中) ---
    const observer = new MutationObserver(() => {
        if (!db.isEnabled) return;

        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;

            const currentMatchKey = getMatchKey(container.innerText);
            const translatedText = window.subtitleMap.get(currentMatchKey);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;

                // 修正外層對齊：由 start 改為 center
                outerSpan.style.textAlign = "center";

                // 搵出所有非翻譯嘅原生 span (原文)
                const originalSpans = Array.from(outerSpan.querySelectorAll('span')).filter(s => !s.classList.contains('ai-translated-span'));
                if (originalSpans.length === 0) return;

                const firstOriginal = originalSpans[0];
                const style = window.getComputedStyle(firstOriginal);
                const isVertical = style.writingMode && style.writingMode.includes('vertical');

                // 置中邏輯 (僅限橫排)
                if (!isVertical) {
                    container.style.left = "50%";
                    container.style.transform = "translateX(-50%)";
                    container.style.whiteSpace = "nowrap";
                }

                // A. 原文縮細至 0.8 倍 (處理所有原來的行)
                const baseFontSize = parseFloat(style.fontSize);
                originalSpans.forEach(s => {
                    s.style.fontSize = (baseFontSize * 0.8) + "px";
                });

                // B. 插入換行
                const br = document.createElement('br');
                br.className = 'ai-translated-br';
                outerSpan.appendChild(br);

                // C. 插入翻譯 Span (維持 100% 大小，設定 lang="zh")
                const aiSpan = firstOriginal.cloneNode(true);
                aiSpan.classList.add('ai-translated-span');
                aiSpan.setAttribute('lang', 'zh');
                aiSpan.style.fontSize = baseFontSize + "px"; // 恢復 1.0 倍
                aiSpan.innerText = translatedText;
                
                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });
        injectControlMenu();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 7. 選單 UI ---
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
            <div id="ai-menu-popup" style="display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(10,10,10,0.98); border:1px solid #444; padding:20px; border-radius:10px; width:300px; flex-direction:column; gap:10px; z-index:2000002; color:white; box-shadow: 0 8px 24px rgba(0,0,0,0.9); font-size:14px;">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 AI 字幕</label>
                <div style="border-top:1px solid #444; margin:5px 0; padding-top:10px;">模型:</div>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="free" ${db.modelType === 'free' ? 'checked' : ''}> Free (Arcee-AI)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="paid" ${db.modelType === 'paid' ? 'checked' : ''}> Paid (Gemini 2.5)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="custom" ${db.modelType === 'custom' ? 'checked' : ''}> Custom:</label>
                <input type="text" id="ai-custom-input" placeholder="Model ID" value="${db.customModel}" style="padding:5px; background:#333; color:white; border:1px solid #555; width:100%; font-size:12px; ${db.modelType === 'custom' ? '' : 'display:none;'}">
                <input type="password" id="ai-api-input" placeholder="API Key" value="${db.apiKey}" style="padding:8px; background:#333; color:white; border:1px solid #555; width:100%; margin-top:5px;">
                <button id="ai-save-btn" style="background:#E50914; color:white; border:none; padding:10px; cursor:pointer; font-weight:bold; margin-top:10px; border-radius:4px;">儲存並套用</button>
            </div>
        `;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const spacer = document.createElement('div'); spacer.style = "min-width: 3rem; width: 3rem;";
        btnWrapper.parentNode.insertBefore(spacer, btnWrapper);

        const popup = document.getElementById('ai-menu-popup');
        popup.addEventListener('click', (e) => e.stopPropagation());
        popup.addEventListener('mousedown', (e) => e.stopPropagation());

        document.getElementById('ai-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
        };

        document.querySelectorAll('input[name="ai-model"]').forEach(r => {
            r.onchange = () => { document.getElementById('ai-custom-input').style.display = (r.value === 'custom') ? 'block' : 'none'; };
        });

        document.getElementById('ai-save-btn').onclick = () => {
            const oldModel = db.activeModel;
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.apiKey = document.getElementById('ai-api-input').value.trim();
            db.modelType = document.querySelector('input[name="ai-model"]:checked').value;
            db.customModel = document.getElementById('ai-custom-input').value.trim();

            if (db.isEnabled && oldModel !== db.activeModel) location.reload();
            else if (!db.isEnabled) document.body.classList.add('hide-ai-subs');
            else document.body.classList.remove('hide-ai-subs');
            popup.style.display = 'none';
        };

        document.addEventListener('click', (e) => { if (popup.style.display === 'flex' && !wrapper.contains(e.target)) popup.style.display = 'none'; });
    }
})();
