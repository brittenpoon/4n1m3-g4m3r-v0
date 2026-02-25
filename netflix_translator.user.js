// ==UserScript==
// @name         Netflix AI 雙語字幕 (v1.28.0)
// @version      1.28.0
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      openrouter.ai
// ==/UserScript==

//@ version 1.28.0

(function() {
    'use strict';

    // --- 1. Database ---
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
    window.processedUrls = new Set();
    window.isAITranslating = false;

    // --- 2. 樣式 ---
    GM_addStyle(`
        #ai-translation-loader {
            position: fixed; top: 12%; left: 50%; transform: translateX(-50%);
            background: rgba(10, 10, 10, 0.98); color: #fff; padding: 25px 40px;
            border-radius: 15px; font-size: 18px; z-index: 2000001; display: none;
            border: 1px solid #FFD700; pointer-events: none; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.9); line-height: 1.6;
        }
        #ai-menu-popup { pointer-events: auto !important; z-index: 2000002; }
        body.hide-ai-subs .ai-translated-span, 
        body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; }
    `);

    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';

    const updateStats = (ms, lines) => {
        const allStats = db.stats;
        const m = db.activeModel;
        if (!allStats[m]) allStats[m] = { totalTime: 0, totalLines: 0 };
        allStats[m].totalTime += ms;
        allStats[m].totalLines += lines;
        db.stats = allStats;
    };

    const getEstimatedTime = (lineCount) => {
        const stats = db.stats[db.activeModel];
        if (!stats || stats.totalLines === 0) return "計算中...";
        return Math.round(((stats.totalTime / stats.totalLines) * lineCount) / 1000) + " 秒";
    };

    const toggleLoading = (isTranslating, totalLines = 0) => {
        window.isAITranslating = isTranslating;
        let loader = document.getElementById('ai-translation-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'ai-translation-loader';
            document.body.appendChild(loader);
        }

        if (isTranslating) {
            const startTime = Date.now();
            const est = getEstimatedTime(totalLines);
            if (window.uiTimer) clearInterval(window.uiTimer);
            window.uiTimer = setInterval(() => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                loader.innerHTML = `
                    <div style="font-weight:bold; color:#FFD700; margin-bottom:8px; font-size:20px;">⏳ 標籤隔離翻譯中 (Tag Isolation Mode)</div>
                    <div style="font-size:13px; color:#ccc;">模型: ${db.activeModel.split('/').pop()}</div>
                    <div style="font-size:14px; margin:5px 0;">已用: ${elapsed}s / 預計: ${est}</div>
                    <div style="font-size:11px; color:#888;">正在嚴格對齊 ${totalLines} 行</div>
                `;
            }, 1000);
            loader.style.display = 'block';

            if (window.autoPauseTimer) clearInterval(window.autoPauseTimer);
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

    // --- 3. 攔截與 API ---
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                if (!db.isEnabled || !db.apiKey) return;
                await processAndTranslate(this.responseText, url);
            });
        }
        oldOpen.apply(this, arguments);
    };

    async function processAndTranslate(rawXml, url) {
        if (window.processedUrls.has(url) || window.isAITranslating) return;
        window.processedUrls.add(url);

        const parser = new DOMParser();
        const doc = parser.parseFromString(rawXml, "text/xml");
        const pTags = Array.from(doc.querySelectorAll('p'));
        const originalLines = pTags.map(p => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = p.innerHTML.replace(/<br\s*\/?>/gi, ' ');
            return tempDiv.textContent.trim();
        }).filter(t => t.length > 0);
        
        if (originalLines.length === 0) return;

        // 【核心：標籤隔離發送】
        const taggedInput = originalLines.map((line, idx) => `[${idx}] ${line} [/${idx}]`).join('\n');

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
                    content: `你是一位影視翻譯員。翻譯為「標準香港繁體中文（書面語）」。
                    【對位死命令：標籤隔離模式】
                    1. 你會收到格式為 "[id] 原文 [/id]" 的內容。
                    2. 必須 1:1 對應每個 ID，禁止合併 ID，禁止跳過。
                    3. 譯文必須被 ID 標籤包圍，格式："[id] 譯文 [/id]"。
                    4. 嚴禁因為語法連貫而將下一行的語意提前。每一組標籤是一個獨立的資料包。
                    5. 符號、語氣詞、音樂符號必須保留 ID 標籤回傳。`
                }, {
                    role: "user",
                    content: taggedInput
                }]
            }),
            onload: function(res) {
                try {
                    const json = JSON.parse(res.responseText);
                    const aiContent = json.choices[0].message.content;
                    const duration = performance.now() - reqStartTime;
                    
                    window.subtitleMap.clear();
                    const debugLog = { stats: { model: db.activeModel, lines: originalLines.length }, mapping: [] };

                    // 使用正則表達式提取被標籤包圍的譯文
                    // 匹配 [數字] 內容 [/數字] 或者 [數字] 內容 (防止 AI 漏寫執尾標籤)
                    const lineRegex = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\/\1\]|\s*\[\d+\]|$)/g;
                    let match;
                    while ((match = lineRegex.exec(aiContent)) !== null) {
                        const idx = parseInt(match[1]);
                        let trans = match[2].trim();
                        
                        // 清洗可能殘留的結束標籤
                        trans = trans.replace(/\[\/\d+\]/g, '').trim();
                        
                        const orig = originalLines[idx];
                        if (orig) {
                            window.subtitleMap.set(getMatchKey(orig), trans);
                            debugLog.mapping.push({ id: idx, orig, trans });
                        }
                    }

                    console.log("%c=== Netflix AI Mapping Log (v1.28.0) ===", "color: #00FF00; font-weight: bold;");
                    console.log(JSON.stringify(debugLog, null, 2));
                    updateStats(duration, originalLines.length);
                } finally { toggleLoading(false); }
            },
            onerror: () => toggleLoading(false)
        });
    }

    // --- 4. 渲染邏輯 (置中 + 0.8x 原文) ---
    const observer = new MutationObserver(() => {
        if (!db.isEnabled) return;

        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;

            const currentMatchKey = getMatchKey(container.innerText);
            const translatedText = window.subtitleMap.get(currentMatchKey);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;
                outerSpan.style.textAlign = "center";
                outerSpan.style.display = "inline-block";

                const innerSpan = outerSpan.querySelector('span:not(.ai-translated-span)');
                if (!innerSpan) return;

                const style = window.getComputedStyle(innerSpan);
                const isVertical = style.writingMode && style.writingMode.includes('vertical');

                if (!isVertical) {
                    container.style.left = "50%";
                    container.style.transform = "translateX(-50%)";
                    container.style.whiteSpace = "nowrap";
                }

                const baseFontSize = parseFloat(style.fontSize);
                const originalSpans = Array.from(outerSpan.querySelectorAll('span')).filter(s => s.getAttribute('lang') !== 'zh' && !s.classList.contains('ai-translated-span'));
                originalSpans.forEach(s => {
                    s.style.fontSize = (baseFontSize * 0.8) + "px";
                });

                const br = document.createElement('br');
                br.className = 'ai-translated-br';
                outerSpan.appendChild(br);

                const aiSpan = innerSpan.cloneNode(true);
                aiSpan.classList.add('ai-translated-span');
                aiSpan.setAttribute('lang', 'zh');
                aiSpan.style.fontSize = baseFontSize + "px";
                aiSpan.innerText = translatedText;
                
                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });
        injectControlMenu();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 5. 選單 ---
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
                <div style="border-top:1px solid #444; margin:5px 0; padding-top:10px;">模型選擇:</div>
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
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.apiKey = document.getElementById('ai-api-input').value.trim();
            db.modelType = document.querySelector('input[name="ai-model"]:checked').value;
            db.customModel = document.getElementById('ai-custom-input').value.trim();
            location.reload();
        };
        document.addEventListener('click', (e) => { if (popup.style.display === 'flex' && !wrapper.contains(e.target)) popup.style.display = 'none'; });
    }
})();
