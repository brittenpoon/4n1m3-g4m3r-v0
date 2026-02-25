// ==UserScript==
// @name         Netflix AI 雙語字幕 (v2.0.9)
// @version      2.0.9
// @description  修正 Batch Index 雙重疊加導致嘅斷層 Bug，保留無縫觀影及倒數功能。
// @author       Gemini
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      openrouter.ai
// @connect      api.groq.com
// @connect      github.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

//@ version 2.0.9

(function() {
    'use strict';

    const SCRIPT_VERSION = '2.0.9';
    const CACHE_TTL = 24 * 60 * 60 * 1000;
    const BATCH_SIZE = 200; // 每批翻譯行數限制
    const API_WAIT_TIME = 60; // 批次之間等待時間 (秒)

    // --- 1. Database & State ---
    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get modelType() {
            let v = GM_getValue('ai_model_type', 'free1');
            if (v === 'free') return 'free1';
            if (v === 'groq') return 'groq_custom';
            return v;
        },
        set modelType(v) { GM_setValue('ai_model_type', v); },

        get apiKey() { return GM_getValue('ai_sub_apikey', ''); },
        set apiKey(v) { GM_setValue('ai_sub_apikey', v); },
        get customModel() { return GM_getValue('ai_custom_model', ''); },
        set customModel(v) { GM_setValue('ai_custom_model', v); },

        get groqApiKey() { return GM_getValue('ai_groq_apikey', ''); },
        set groqApiKey(v) { GM_setValue('ai_groq_apikey', v); },
        get groqModel() { return GM_getValue('ai_groq_model', ''); },
        set groqModel(v) { GM_setValue('ai_groq_model', v); },

        get activeModelName() {
            if (this.modelType === 'free1') return 'arcee-ai/trinity-large-preview:free';
            if (this.modelType === 'free2') return 'arcee-ai/trinity-mini:free';
            if (this.modelType === 'paid') return 'google/gemini-2.5-flash-lite-preview-09-2025';
            if (this.modelType === 'custom') return this.customModel || 'arcee-ai/trinity-large-preview:free';

            if (this.modelType === 'groq_kimi') return 'moonshotai/kimi-k2-instruct-0905';
            if (this.modelType === 'groq_custom') return this.groqModel || 'llama-3.3-70b-versatile';

            return 'arcee-ai/trinity-large-preview:free';
        },
        get stats() { return GM_getValue('ai_perf_stats', {}); },
        set stats(v) { GM_setValue('ai_perf_stats', v); }
    };

    window.subtitleMap = new Map();
    window.processedUrls = new Set();
    window.isAITranslating = false;
    window.glossaryPrompt = "";

    // --- 2. 緩存機制 ---
    const hashCode = (s) => s.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0).toString(36);

    function getCache(hashKey) {
        let cache = GM_getValue('ai_translation_cache', { version: SCRIPT_VERSION, model: db.activeModelName, items: {} });
        if (cache.version !== SCRIPT_VERSION || cache.model !== db.activeModelName) {
            cache = { version: SCRIPT_VERSION, model: db.activeModelName, items: {} };
            GM_setValue('ai_translation_cache', cache);
            return null;
        }
        let isDirty = false;
        const now = Date.now();
        for (const key in cache.items) {
            if (now - cache.items[key].ts > CACHE_TTL) { delete cache.items[key]; isDirty = true; }
        }
        if (isDirty) GM_setValue('ai_translation_cache', cache);
        return cache.items[hashKey] ? cache.items[hashKey].mapping : null;
    }

    function setCache(hashKey, mapping) {
        let cache = GM_getValue('ai_translation_cache', { version: SCRIPT_VERSION, model: db.activeModelName, items: {} });
        cache.items[hashKey] = { ts: Date.now(), mapping: mapping };
        GM_setValue('ai_translation_cache', cache);
    }

    // --- 3. 名詞庫 ---
    function fetchGlossary() {
        GM_xmlhttpRequest({
            method: "GET",
            url: "https://github.com/brittenpoon/4n1m3-g4m3r-v0/raw/refs/heads/main/Glossary.json",
            onload: function(res) {
                try {
                    const arr = JSON.parse(res.responseText);
                    if (Array.isArray(arr) && arr.length > 0) {
                        let text = "\n\n【專有名詞對照表】\n遇到以下名詞，請務必使用對應譯名：\n";
                        arr.forEach(item => { if (item.orig && item.trans) text += `- ${item.orig}: ${item.trans}\n`; });
                        window.glossaryPrompt = text;
                    }
                } catch (e) {}
            }
        });
    }
    fetchGlossary();

    // --- 4. 樣式與解鎖 ---
    GM_addStyle(`
        * { user-select: text !important; -webkit-user-select: text !important; }
        .player-timedtext-text-container { pointer-events: auto !important; }
        #ai-translation-loader {
            position: fixed; top: 12%; left: 50%; transform: translateX(-50%);
            background: rgba(10, 10, 10, 0.98); color: #fff; padding: 25px 40px;
            border-radius: 15px; font-size: 18px; z-index: 2000001;
            border: 1px solid #FFD700; pointer-events: none; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.9); line-height: 1.6; transition: all 0.5s ease;
        }
        #ai-translation-loader.minimized {
            top: auto !important; bottom: 100px !important; left: 20px !important; transform: none !important;
            padding: 15px 20px !important; font-size: 14px !important; border-color: #00FFFF !important;
            background: rgba(10, 10, 10, 0.85) !important;
        }
        #ai-menu-popup { pointer-events: auto !important; z-index: 2000002; }
        body.hide-ai-subs .ai-translated-span, body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; }
    `);

    function unlockTextSelection() {
        ['copy', 'contextmenu', 'selectstart', 'mousedown', 'mouseup'].forEach(evt =>
            document.addEventListener(evt, (e) => e.stopPropagation(), true)
        );
    }
    unlockTextSelection();

    // --- 5. JSON 輸出 ---
    function exportTranslationJSON(stats, mapping, fromCache = false) {
        const outputData = {
            timestamp: new Date().toISOString(), modelUsed: stats.model,
            processingTimeMs: Math.round(stats.duration), totalLines: stats.lines,
            fromCache: fromCache, translations: mapping
        };
        const title = fromCache ? "%c📺 Netflix AI Subtitles - Cached JSON (v2.0.9)" : "%c📺 Netflix AI Subtitles - JSON Export Data (v2.0.9)";
        console.groupCollapsed(title, "color: #00FFFF; font-weight: bold; font-size: 12px;");
        console.log(JSON.stringify(outputData, null, 2));
        console.groupEnd();
        window.dispatchEvent(new CustomEvent('NetflixAITranslationData', { detail: outputData }));
    }

    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';
    const updateStats = (ms, lines) => {
        const allStats = db.stats; const m = db.activeModelName;
        if (!allStats[m]) allStats[m] = { totalTime: 0, totalLines: 0 };
        allStats[m].totalTime += ms; allStats[m].totalLines += lines;
        db.stats = allStats;
    };

    // --- 6. API 攔截與分批翻譯 ---
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                if (!db.isEnabled) return;
                const currentApiKey = db.modelType.startsWith('groq') ? db.groqApiKey : db.apiKey;
                if (!currentApiKey) return;
                if (window.location.pathname.startsWith('/browse')) return;
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

        const xmlHash = hashCode(rawXml);
        const cachedMapping = getCache(xmlHash);

        if (cachedMapping) {
            window.subtitleMap.clear();
            cachedMapping.forEach(item => { if (item.orig) window.subtitleMap.set(getMatchKey(item.orig), item.trans); });
            console.log("%c=== Netflix AI 命中緩存 (v2.0.9) ===", "color: #00FFFF; font-weight: bold;");
            exportTranslationJSON({ model: db.activeModelName, lines: originalLines.length, duration: 0 }, cachedMapping, true);
            return;
        }

        const batches = [];
        for (let i = 0; i < originalLines.length; i += BATCH_SIZE) {
            batches.push({
                startIndex: i,
                lines: originalLines.slice(i, i + BATCH_SIZE),
                text: originalLines.slice(i, i + BATCH_SIZE).map((line, idx) => `[${i + idx}] ${line} [/${i + idx}]`).join('\n')
            });
        }

        let systemContent = `你是一位影視翻譯員。翻譯為「標準香港繁體中文（書面語）」。
                    【對位死命令：標籤隔離模式】
                    1. 你會收到格式為 "[id] 原文 [/id]" 的內容。
                    2. 必須 1:1 對應每個 ID，禁止合併 ID，禁止跳過。
                    3. 譯文必須被 ID 標籤包圍，格式："[id] 譯文 [/id]"。
                    4. 嚴禁因為語法連貫而將下一行的語意提前。每一組標籤是一個獨立的資料包。
                    5. 符號、語氣詞、音樂符號必須保留 ID 標籤回傳。`;
        if (window.glossaryPrompt) systemContent += window.glossaryPrompt;

        const isGroq = db.modelType.startsWith('groq');
        const apiUrl = isGroq ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
        const currentApiKey = isGroq ? db.groqApiKey : db.apiKey;

        window.isAITranslating = true;
        const reqStartTime = performance.now();
        window.subtitleMap.clear();
        let exportMapping = [];

        let loader = document.getElementById('ai-translation-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'ai-translation-loader';
            document.body.appendChild(loader);
        }
        loader.className = '';
        loader.style.display = 'block';

        let autoPauseInterval = setInterval(() => {
            const video = document.querySelector('video');
            if (video && !video.paused) {
                const pauseBtn = document.querySelector('[data-uia="control-play-pause-pause"]');
                if (pauseBtn) pauseBtn.click(); else video.pause();
            }
        }, 500);

        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];

            loader.innerHTML = `
                <div style="font-weight:bold; color:#FFD700; margin-bottom:8px; font-size:${b===0?'20px':'16px'};">🚀 處理中: Batch ${b + 1} / ${batches.length}</div>
                <div style="font-size:13px; color:#ccc;">模型: ${db.activeModelName.split('/').pop()}</div>
                <div style="font-size:12px; color:#888; margin-top:5px;">正在翻譯第 ${batch.startIndex} - ${batch.startIndex + batch.lines.length - 1} 行</div>
            `;

            try {
                const res = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "POST", url: apiUrl,
                        headers: { "Authorization": `Bearer ${currentApiKey}`, "Content-Type": "application/json" },
                        data: JSON.stringify({
                            model: db.activeModelName,
                            messages: [{ role: "system", content: systemContent }, { role: "user", content: batch.text }]
                        }),
                        onload: resolve, onerror: reject
                    });
                });

                const json = JSON.parse(res.responseText);
                const aiContent = json.choices[0].message.content;

                const lineRegex = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\/\1\]|\s*\[\d+\]|$)/g;
                let match;
                while ((match = lineRegex.exec(aiContent)) !== null) {
                    // 【修正位置】直接讀取 Regex 抽出嚟嘅絕對 Index，唔好疊加 batch.startIndex
                    const idx = parseInt(match[1]);
                    let trans = match[2].trim().replace(/\[\/\d+\]/g, '').trim();
                    const orig = originalLines[idx];
                    if (orig) {
                        window.subtitleMap.set(getMatchKey(orig), trans);
                        exportMapping.push({ id: idx, orig: orig, trans: trans });
                    }
                }

                if (b === 0) {
                    clearInterval(autoPauseInterval);
                    if (batches.length > 1) loader.classList.add('minimized');
                    const playBtn = document.querySelector('[data-uia="control-play-pause-play"]');
                    if (playBtn) playBtn.click();
                }

                if (b < batches.length - 1) {
                    for (let s = API_WAIT_TIME; s > 0; s--) {
                        loader.innerHTML = `
                            <div style="font-weight:bold; color:#00FFFF; margin-bottom:5px; font-size:14px;">⏸️ API 限制: 倒數中</div>
                            <div style="font-size:12px; color:#ccc;">已載入 Batch ${b + 1}，請繼續觀看。</div>
                            <div style="font-size:13px; color:#FFD700; margin-top:5px;">下一批次倒數: <b>${s}s</b></div>
                        `;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }

            } catch (err) {
                console.error(`Batch ${b + 1} 翻譯失敗:`, err);
                if (b === 0) clearInterval(autoPauseInterval);
            }
        }

        const duration = performance.now() - reqStartTime;
        loader.style.display = 'none';
        window.isAITranslating = false;
        console.log(`%c=== Netflix AI API 翻譯完成 (${isGroq ? 'Groq' : 'OpenRouter'}) (v2.0.9) ===`, "color: #00FF00; font-weight: bold;");
        exportTranslationJSON({ model: db.activeModelName, lines: originalLines.length, duration: duration }, exportMapping, false);
        setCache(xmlHash, exportMapping);
    }

    // --- 7. 渲染邏輯 ---
    const observer = new MutationObserver(() => {
        if (!db.isEnabled) return;
        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;

            const currentMatchKey = getMatchKey(container.innerText);
            const translatedText = window.subtitleMap.get(currentMatchKey);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;
                outerSpan.style.textAlign = "center"; outerSpan.style.display = "inline-block";

                const innerSpan = outerSpan.querySelector('span:not(.ai-translated-span)');
                if (!innerSpan) return;
                const style = window.getComputedStyle(innerSpan);
                const isVertical = style.writingMode && style.writingMode.includes('vertical');

                if (!isVertical) {
                    container.style.left = "50%"; container.style.transform = "translateX(-50%)"; container.style.whiteSpace = "nowrap";
                }
                const baseFontSize = parseFloat(style.fontSize);
                Array.from(outerSpan.querySelectorAll('span')).filter(s => s.getAttribute('lang') !== 'zh' && !s.classList.contains('ai-translated-span')).forEach(s => {
                    s.style.fontSize = (baseFontSize * 0.8) + "px";
                });

                const br = document.createElement('br'); br.className = 'ai-translated-br';
                outerSpan.appendChild(br);

                const aiSpan = innerSpan.cloneNode(true);
                aiSpan.classList.add('ai-translated-span'); aiSpan.setAttribute('lang', 'zh');
                aiSpan.style.fontSize = baseFontSize + "px"; aiSpan.innerText = translatedText;

                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });
        injectControlMenu();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 8. 選單 ---
    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper'; wrapper.style.display = 'flex';

        const isORC = db.modelType === 'custom';
        const isOR = ['free1', 'free2', 'paid', 'custom'].includes(db.modelType);
        const isGroqCustom = db.modelType === 'groq_custom';
        const isGroqAny = db.modelType.startsWith('groq');

        wrapper.innerHTML = `
            <div class="${btnWrapper.className}"><button class="${targetBtn.className}" id="ai-toggle-btn" style="color:white; font-weight:bold; font-size:16px;">AI 2.0.9</button></div>
            <div id="ai-menu-popup" style="display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(10,10,10,0.98); border:1px solid #444; padding:20px; border-radius:10px; width:300px; flex-direction:column; gap:10px; z-index:2000002; color:white; box-shadow: 0 8px 24px rgba(0,0,0,0.9); font-size:14px; max-height:70vh; overflow-y:auto;">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 AI 字幕</label>

                <div style="border-top:1px solid #444; margin:5px 0; padding-top:10px;">🌐 OpenRouter 模型:</div>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="free1" ${db.modelType === 'free1' ? 'checked' : ''}> Free 1 (大模型/較慢)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="free2" ${db.modelType === 'free2' ? 'checked' : ''}> Free 2 (細模型/較快)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="paid" ${db.modelType === 'paid' ? 'checked' : ''}> Paid (Gemini 2.5)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="custom" ${db.modelType === 'custom' ? 'checked' : ''}> Custom OpenRouter</label>
                <input type="text" id="ai-custom-input" placeholder="OR Model ID" value="${db.customModel}" style="padding:5px; background:#333; color:white; border:1px solid #555; width:100%; font-size:12px; display:${isORC ? 'block' : 'none'};">
                <input type="password" id="ai-api-input" placeholder="OpenRouter API Key" value="${db.apiKey}" style="padding:8px; background:#333; color:white; border:1px solid #555; width:100%; margin-top:5px; display:${isOR ? 'block' : 'none'};">

                <div style="border-top:1px solid #444; margin:5px 0; padding-top:10px;">⚡ Groq 模型:</div>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="groq_kimi" ${db.modelType === 'groq_kimi' ? 'checked' : ''}> Kimi K2 (內建防斷行機制)</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="groq_custom" ${db.modelType === 'groq_custom' ? 'checked' : ''}> Custom Groq</label>
                <input type="text" id="ai-groq-model-input" placeholder="e.g. llama-3.3-70b-versatile" value="${db.groqModel}" style="padding:5px; background:#333; color:white; border:1px solid #555; width:100%; font-size:12px; display:${isGroqCustom ? 'block' : 'none'};">
                <input type="password" id="ai-groq-api-input" placeholder="Groq API Key" value="${db.groqApiKey}" style="padding:8px; background:#333; color:white; border:1px solid #555; width:100%; margin-top:5px; display:${isGroqAny ? 'block' : 'none'};">

                <button id="ai-glossary-btn" style="background:#444; color:white; border:1px solid #666; padding:8px; cursor:pointer; font-size:13px; margin-top:5px; border-radius:4px;">📖 編輯名詞庫 (Glossary)</button>
                <button id="ai-save-btn" style="background:#E50914; color:white; border:none; padding:10px; cursor:pointer; font-weight:bold; margin-top:10px; border-radius:4px;">儲存並套用 v2.0.9</button>
            </div>
        `;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const spacer = document.createElement('div'); spacer.style = "min-width: 3rem; width: 3rem;";
        btnWrapper.parentNode.insertBefore(spacer, btnWrapper);

        const popup = document.getElementById('ai-menu-popup');
        popup.addEventListener('click', (e) => e.stopPropagation());
        document.getElementById('ai-toggle-btn').onclick = (e) => { e.stopPropagation(); popup.style.display = popup.style.display === 'none' ? 'flex' : 'none'; };
        document.getElementById('ai-glossary-btn').onclick = (e) => { e.stopPropagation(); window.open('https://github.com/brittenpoon/4n1m3-g4m3r-v0/blob/main/Glossary.json', '_blank'); };

        document.querySelectorAll('input[name="ai-model"]').forEach(r => {
            r.onchange = () => {
                const v = r.value;
                document.getElementById('ai-custom-input').style.display = (v === 'custom') ? 'block' : 'none';
                document.getElementById('ai-api-input').style.display = ['free1', 'free2', 'paid', 'custom'].includes(v) ? 'block' : 'none';
                document.getElementById('ai-groq-model-input').style.display = (v === 'groq_custom') ? 'block' : 'none';
                document.getElementById('ai-groq-api-input').style.display = v.startsWith('groq') ? 'block' : 'none';
            };
        });

        document.getElementById('ai-save-btn').onclick = () => {
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.modelType = document.querySelector('input[name="ai-model"]:checked').value;
            db.apiKey = document.getElementById('ai-api-input').value.trim();
            db.customModel = document.getElementById('ai-custom-input').value.trim();
            db.groqApiKey = document.getElementById('ai-groq-api-input').value.trim();
            db.groqModel = document.getElementById('ai-groq-model-input').value.trim();
            location.reload();
        };
        document.addEventListener('click', (e) => { if (popup.style.display === 'flex' && !wrapper.contains(e.target)) popup.style.display = 'none'; });
    }
})();
