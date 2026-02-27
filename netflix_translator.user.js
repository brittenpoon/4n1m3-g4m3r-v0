// ==UserScript==
// @name         Netflix AI 字幕 (Gemma 4B 特化優化版 v4.28)
// @version      4.28.0
// @description  移除干擾性 e.g.，無損合併 9 條規則至 7 條，轉換 Glossary 格式防止 Token Bleed。
// @author       Gemini
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      raw.githubusercontent.com
// @connect      github.com
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = "4.28.0";
    let currentAbortController = null;

    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get aiModel() { return GM_getValue('ai_model_name', 'translategemma:4b'); },
        set aiModel(v) { GM_setValue('ai_model_name', v); },
        get sourceLangName() { return GM_getValue('ai_source_lang_name', 'Japanese'); },
        set sourceLangName(v) { GM_setValue('ai_source_lang_name', v); },
        get sourceLangCode() { return GM_getValue('ai_source_lang_code', 'ja'); },
        set sourceLangCode(v) { GM_setValue('ai_source_lang_code', v); },
        get targetLangName() { return GM_getValue('ai_target_lang_name', 'Chinese (Traditional)'); },
        set targetLangName(v) { GM_setValue('ai_target_lang_name', v); },
        get targetLangCode() { return GM_getValue('ai_target_lang_code', 'zh-Hant'); },
        set targetLangCode(v) { GM_setValue('ai_target_lang_code', v); },
        get glossaryUrl() { return GM_getValue('ai_glossary_url', 'https://github.com/brittenpoon/4n1m3-g4m3r-v0/raw/refs/heads/main/Glossary.json'); },
        set glossaryUrl(v) { GM_setValue('ai_glossary_url', v); }
    };

    const SUPPORTED_LANGUAGES = [
        { code: 'en', name: 'English' },
        { code: 'ja', name: 'Japanese' },
        { code: 'zh-Hant', name: 'Chinese (Traditional)' },
        { code: 'zh-Hant-HK', name: 'Chinese (HK)' },
        { code: 'zh-Hant-TW', name: 'Chinese (TW)' },
        { code: 'zh-Hans', name: 'Chinese (Simplified)' },
        { code: 'ko', name: 'Korean' }
    ];

    window.subtitleMap = new Map();
    window.processedUrls = new Set();
    window.isAITranslating = false;
    let hasPausedForCurrentClip = false;

    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';
    const getTimestamp = () => new Date().toLocaleTimeString([], {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});

    function formatTime(ms) {
        if (ms === 0 || isNaN(ms)) return "--";
        const totalSec = Math.floor(ms / 1000);
        return totalSec > 60 ? `${Math.floor(totalSec/60)}分 ${totalSec%60}秒` : `${totalSec}秒`;
    }

    function getVideoHash() {
        const match = window.location.pathname.match(/\/watch\/(\d+)/);
        return match ? match[1] : 'unknown_hash';
    }

    function abortPreviousTasks() {
        if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
        window.isAITranslating = false;
        window.processedUrls.clear();
        let loader = document.getElementById('ai-translation-loader');
        if (loader) loader.style.display = 'none';
    }

    let lastPath = window.location.pathname;
    setInterval(() => { if (window.location.pathname !== lastPath) { lastPath = window.location.pathname; abortPreviousTasks(); hasPausedForCurrentClip = false; } }, 1000);

    function cleanAndGetCache() {
        let cache = GM_getValue('ai_subtitle_cache', {});
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;
        let isChanged = false;
        for (let hash in cache) { if (now - cache[hash].timestamp > ONE_DAY) { delete cache[hash]; isChanged = true; } }
        if (isChanged) GM_setValue('ai_subtitle_cache', cache);
        return cache;
    }

    async function fetchGlossary() {
        if (!db.glossaryUrl || !db.glossaryUrl.startsWith('http')) return {};
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET", url: db.glossaryUrl,
                onload: function(res) {
                    try {
                        let cleanText = res.responseText.replace(/[\uFEFF\u200B\u00A0\u3000]/g, '').trim();
                        const data = JSON.parse(cleanText);
                        const filteredData = {};
                        for (const [key, val] of Object.entries(data)) { if (!key.startsWith('_')) filteredData[key] = val; }
                        resolve(filteredData);
                    } catch (e) { resolve({}); }
                },
                onerror: () => resolve({})
            });
        });
    }

    GM_addStyle(`
        * { -webkit-user-select: text !important; user-select: text !important; }
        .player-timedtext-text-container { pointer-events: auto !important; }
        #ai-translation-loader { position: fixed; top: 12%; left: 50%; transform: translateX(-50%); background: rgba(10, 10, 10, 0.98); color: #fff; padding: 20px 35px; border-radius: 12px; font-size: 16px; z-index: 2000001; display: none; border: 1px solid #FFD700; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.9); min-width: 250px; }
        .ai-translated-span { display: inline-block !important; color: #FFD700 !important; font-weight: bold; text-shadow: 2px 2px 4px #000 !important; }
        #ai-menu-popup { display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(10,10,10,0.95); border:1px solid #444; padding:20px; border-radius:10px; width:300px; flex-direction:column; gap:10px; z-index:2000002; color:white; font-size:14px; box-shadow: 0 8px 24px rgba(0,0,0,0.8); max-height: 80vh; overflow-y: auto; }
        #ai-menu-popup select, #ai-menu-popup input[type="text"] { background:#333; color:white; padding:6px; border:1px solid #666; border-radius:4px; outline:none; width:100%; margin-top:4px; box-sizing: border-box; }
        #ai-toggle-btn { font-size: 18px !important; padding: 8px 16px !important; line-height: 1 !important; height: auto !important; min-width: 50px !important; }
    `);

    const events = ['copy', 'contextmenu', 'selectstart', 'mousedown', 'mouseup'];
    events.forEach(evt => document.addEventListener(evt, (e) => e.stopPropagation(), true));

    function triggerInitialPause() {
        if (hasPausedForCurrentClip) return;
        const video = document.querySelector('video');
        if (video && !video.paused) {
            const pauseBtn = document.querySelector('[data-uia="control-play-pause-pause"]');
            if (pauseBtn) pauseBtn.click(); else video.pause();
            hasPausedForCurrentClip = true;
        }
    }

    function updateUIProgress(current, total, avgMs = 0, etaMs = 0) {
        let loader = document.getElementById('ai-translation-loader');
        if (!loader) { loader = document.createElement('div'); loader.id = 'ai-translation-loader'; document.body.appendChild(loader); }
        loader.style.display = 'block';
        let statsHtml = avgMs > 0 ? `<div style="font-size:13px; color:#aaa; margin-top:8px; border-top:1px solid #333; padding-top:8px;">平均: ${(avgMs/1000).toFixed(2)}s | 剩餘: ${formatTime(etaMs)}</div>` : '';
        loader.innerHTML = `<div style="font-weight:bold; color:#FFD700;">⏳ 本地模型翻譯中</div><div style="font-size:15px; margin-top:5px;">進度: ${current} / ${total}</div>${statsHtml}`;
        if (current >= total) setTimeout(() => loader.style.display = 'none', 2000);
    }

    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                if (!window.location.pathname.includes('/watch/')) return;
                await processAndTranslate(this.responseText, url);
            });
        }
        oldOpen.apply(this, arguments);
    };

    async function processAndTranslate(rawXml, url) {
        if (window.processedUrls.has(url) || !db.isEnabled) return;
        window.processedUrls.add(url);
        
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawXml, "text/xml");
        const pTags = Array.from(doc.querySelectorAll('p'));
        const originalLines = pTags.map(p => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = p.innerHTML.replace(/<br\s*\/?>/gi, ' ');
            return tempDiv.textContent.replace(/\n/g, ' ').trim();
        }).filter(t => t.length > 0);

        if (originalLines.length === 0) return;

        triggerInitialPause();
        window.isAITranslating = true;
        currentAbortController = new AbortController();

        const total = originalLines.length;
        const glossaryDict = await fetchGlossary();
        
        // 變更格式為 Key=Value，用 | 分隔，幫助 4B 模型更準確對齊 Token，避免 Attention Bleed
        const glossaryPairs = Object.entries(glossaryDict).map(([k, v]) => `${k}=${v}`);
        let glossaryString = glossaryPairs.length > 0 ? glossaryPairs.join(' | ') : "None";

        const videoHash = getVideoHash();
        let allCache = cleanAndGetCache();
        const cacheEnvKey = `${SCRIPT_VERSION}_${db.aiModel}_${db.sourceLangCode}_${db.targetLangCode}`;
        
        if (!allCache[videoHash] || allCache[videoHash].envKey !== cacheEnvKey) {
            allCache[videoHash] = { timestamp: Date.now(), envKey: cacheEnvKey, translations: {} };
        }
        let currentVideoCache = allCache[videoHash].translations;

        let successfulAiCount = 0;
        let totalAiTimeMs = 0;

        for (let i = 0; i < total; i++) {
            if (currentAbortController?.signal.aborted) return;
            const text = originalLines[i];
            const textKey = getMatchKey(text);
            const tsLog = getTimestamp();
            const currentAvgMs = successfulAiCount > 0 ? (totalAiTimeMs / successfulAiCount) : 0;

            if (currentVideoCache[textKey]) {
                const translated = currentVideoCache[textKey];
                window.subtitleMap.set(textKey, translated);
                updateUIProgress(i + 1, total, currentAvgMs, (total - i - 1) * currentAvgMs);
                continue; 
            }

            // --- 無損合併並重排的 7 條鐵律 (移除了干擾性 e.g.) ---
            const prompt = `You are a professional ${db.sourceLangName} (${db.sourceLangCode}) to ${db.targetLangName} (${db.targetLangCode}) translator. Your goal is to accurately convey the meaning and nuances of the original ${db.sourceLangName} text while adhering to ${db.targetLangName} grammar, vocabulary, and cultural sensitivities.
Produce only the ${db.targetLangName} translation, without any additional explanations or commentary.
Additional requirements:
1. STRICT GLOSSARY: ${glossaryString}. You MUST use these exact translations. This takes absolute precedence.
2. SCRIPT PURITY (CRITICAL): The output MUST be ENTIRELY in ${db.targetLangName} characters. You are strictly forbidden from outputting ANY English (Latin), Russian (Cyrillic), Japanese (Kana/Romaji), or Korean (Hangul). Any non-target character is a total failure.
3. TRANSLATE ALL NAMES & KATAKANA: All character names and Katakana terms MUST be translated into proper ${db.targetLangName} equivalents. DO NOT copy them.
4. TONE & SLANG: Match the original emotion and intensity. Do not harmonize, soften, or censor rude language or slang.
5. NO REFUSALS: NEVER apologize, refuse to translate, or output conversational text. ALWAYS force a translation.
6. SYMBOLS & PUNCTUATION: Retain special punctuation like long dashes naturally in the translation.
7. STYLE & CHARACTER CHECK: Ensure fluent dialogue. Perform a final check to convert all Japanese Kanji and Simplified Chinese into correct ${db.targetLangName} characters.
Please translate the following ${db.sourceLangName} text into ${db.targetLangName}:


${text}`;

            if (i === 0) console.log("%c[Debug] v4.28 Optimized Prompt:", "color: #FFA500; font-weight: bold;", prompt);

            const startTime = Date.now();
            await new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: "POST", url: "http://127.0.0.1:11434/api/generate",
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ model: db.aiModel, prompt: prompt, stream: false, options: { temperature: 0.1, num_predict: 256 } }),
                    onload: function(res) {
                        if (currentAbortController?.signal.aborted) return resolve();
                        try {
                            const translated = JSON.parse(res.responseText).response.trim().replace(/^"|"$/g, '');
                            const duration = Date.now() - startTime;
                            successfulAiCount++;
                            totalAiTimeMs += duration;
                            window.subtitleMap.set(textKey, translated);
                            currentVideoCache[textKey] = translated;
                            allCache[videoHash].translations = currentVideoCache;
                            GM_setValue('ai_subtitle_cache', allCache);
                            console.log(`%c[${getTimestamp()}] [${i+1}/${total}] (${(duration/1000).toFixed(2)}s) %c${text} %c➔ %c${translated}`, "color:#888", "color:#fff", "color:#00FF00", "color:#FFD700");
                            updateUIProgress(i + 1, total, totalAiTimeMs / successfulAiCount, (total - i - 1) * (totalAiTimeMs / successfulAiCount));
                        } catch (e) {}
                        resolve();
                    },
                    onerror: () => resolve()
                });
            });
        }
        window.isAITranslating = false;
        currentAbortController = null;
    }

    const observer = new MutationObserver(() => {
        injectControlMenu(); 
        if (!db.isEnabled || !window.location.pathname.includes('/watch/')) return;
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
                if (!isVertical) { container.style.left = "50%"; container.style.transform = "translateX(-50%)"; container.style.whiteSpace = "nowrap"; }
                const baseFontSize = parseFloat(style.fontSize);
                const originalSpans = Array.from(outerSpan.querySelectorAll('span')).filter(s => s.getAttribute('lang') !== 'zh' && !s.classList.contains('ai-translated-span'));
                originalSpans.forEach(s => s.style.fontSize = (baseFontSize * 0.8) + "px");
                const br = document.createElement('br'); br.className = 'ai-translated-br'; outerSpan.appendChild(br);
                const aiSpan = innerSpan.cloneNode(true);
                aiSpan.classList.add('ai-translated-span');
                aiSpan.setAttribute('lang', 'zh');
                aiSpan.style.fontSize = baseFontSize + "px";
                aiSpan.innerText = translatedText;
                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper'; wrapper.style.display = 'flex';
        const langOptions = SUPPORTED_LANGUAGES.map(lang => `<option value="${lang.code}" data-name="${lang.name}">${lang.name}</option>`).join('');
        wrapper.innerHTML = `<div class="${btnWrapper.className}"><button class="${targetBtn.className}" id="ai-toggle-btn" style="color:#FFD700; font-weight:bold;">AI</button></div>
            <div id="ai-menu-popup">
                <label><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 Ollama</label>
                <label>模型: <input type="text" id="ai-model-input" value="${db.aiModel}"></label>
                <label>Glossary JSON: <input type="text" id="ai-glossary-input" value="${db.glossaryUrl}"></label>
                <button id="ai-edit-glossary-btn" style="background:#0078D7; color:white; border:none; padding:6px; border-radius:4px;">📝 編輯名詞庫</button>
                <label>來源: <select id="ai-source-lang-select">${langOptions}</select></label>
                <label>目標: <select id="ai-target-lang-select">${langOptions}</select></label>
                <button id="ai-save-btn" style="background:#E50914; color:white; border:none; padding:10px; border-radius:4px;">儲存並刷新</button>
                <button id="ai-clear-cache-btn" style="background:#444; color:#ccc; border:none; padding:8px; border-radius:4px;">清除快取</button>
            </div>`;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const popup = document.getElementById('ai-menu-popup');
        document.getElementById('ai-toggle-btn').onclick = (e) => { e.stopPropagation(); popup.style.display = popup.style.display === 'none' ? 'flex' : 'none'; };
        document.getElementById('ai-source-lang-select').value = db.sourceLangCode;
        document.getElementById('ai-target-lang-select').value = db.targetLangCode;
        document.getElementById('ai-edit-glossary-btn').onclick = () => {
            let url = db.glossaryUrl.replace('raw.githubusercontent.com', 'github.com').replace('/raw/refs/heads/', '/blob/').replace('/raw/', '/blob/');
            window.open(url, '_blank');
        };
        document.getElementById('ai-save-btn').onclick = () => {
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.aiModel = document.getElementById('ai-model-input').value.trim();
            db.glossaryUrl = document.getElementById('ai-glossary-input').value.trim();
            db.sourceLangCode = document.getElementById('ai-source-lang-select').value;
            db.targetLangCode = document.getElementById('ai-target-lang-select').value;
            location.reload();
        };
        document.getElementById('ai-clear-cache-btn').onclick = () => { if (confirm('清除快取？')) { GM_setValue('ai_subtitle_cache', {}); location.reload(); } };
        document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) popup.style.display = 'none'; });
    }
})();
