// ==UserScript==
// @name         Netflix AI 字幕 (終極語言鎖定版 v4.18)
// @version      4.18.0
// @description  強制禁止輸出英文及日文原文，強化對口語與特殊標點 (如長破折號) 嘅處理。
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

    const SCRIPT_VERSION = "4.18.0";

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
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m > 0 ? `${m}分 ${s}秒` : `${s}秒`;
    }

    function getVideoHash() {
        const match = window.location.pathname.match(/\/watch\/(\d+)/);
        return match ? match[1] : 'unknown_hash';
    }

    function cleanAndGetCache() {
        let cache = GM_getValue('ai_subtitle_cache', {});
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;
        let isChanged = false;
        for (let hash in cache) {
            if (now - cache[hash].timestamp > ONE_DAY) {
                delete cache[hash];
                isChanged = true;
            }
        }
        if (isChanged) GM_setValue('ai_subtitle_cache', cache);
        return cache;
    }

    async function fetchGlossary() {
        if (!db.glossaryUrl || !db.glossaryUrl.startsWith('http')) return {};
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: db.glossaryUrl,
                onload: function(res) {
                    try {
                        let cleanText = res.responseText.replace(/[\uFEFF\u200B\u00A0\u3000]/g, '').trim();
                        const data = JSON.parse(cleanText);
                        const filteredData = {};
                        for (const [key, val] of Object.entries(data)) {
                            if (!key.startsWith('_') && key.trim() !== "") filteredData[key] = val;
                        }
                        console.log("%c[Glossary] 成功載入並淨化名詞庫:", "color:#00FF00", Object.keys(filteredData).length, "項");
                        resolve(filteredData);
                    } catch (e) {
                        console.error("[Glossary] JSON 解析失敗。", e);
                        resolve({});
                    }
                },
                onerror: () => resolve({})
            });
        });
    }

    GM_addStyle(`
        * { -webkit-user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; user-select: text !important; }
        .player-timedtext-text-container { pointer-events: auto !important; }
        #ai-translation-loader { position: fixed; top: 12%; left: 50%; transform: translateX(-50%); background: rgba(10, 10, 10, 0.98); color: #fff; padding: 20px 35px; border-radius: 12px; font-size: 16px; z-index: 2000001; display: none; border: 1px solid #FFD700; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.9); line-height: 1.6; min-width: 250px; }
        body.hide-ai-subs .ai-translated-span, body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; color: #FFD700 !important; font-weight: bold; text-shadow: 2px 2px 4px #000 !important; }
        #ai-menu-popup { display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(10,10,10,0.95); border:1px solid #444; padding:20px; border-radius:10px; width:300px; flex-direction:column; gap:10px; z-index:2000002; color:white; font-size:14px; box-shadow: 0 8px 24px rgba(0,0,0,0.8); max-height: 80vh; overflow-y: auto; }
        #ai-menu-popup select, #ai-menu-popup input[type="text"] { background:#333; color:white; padding:6px; border:1px solid #666; border-radius:4px; outline:none; width:100%; margin-top:4px; box-sizing: border-box; }
        #ai-menu-popup::-webkit-scrollbar { width: 6px; }
        #ai-menu-popup::-webkit-scrollbar-thumb { background: #666; border-radius: 3px; }
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
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'ai-translation-loader';
            document.body.appendChild(loader);
        }
        loader.style.display = 'block';
        
        let statsHtml = '';
        if (avgMs > 0) {
            statsHtml = `<div style="font-size:13px; color:#aaa; margin-top:8px; border-top:1px solid #333; padding-top:8px;">
                            平均: <span style="color:#00BFFF;">${(avgMs/1000).toFixed(2)}s</span> / 行<br>
                            剩餘: <span style="color:#FF4500; font-weight:bold;">${formatTime(etaMs)}</span>
                         </div>`;
        }

        loader.innerHTML = `<div style="font-weight:bold; color:#FFD700;">⏳ 本地模型翻譯中 (${db.aiModel})</div>
                            <div style="font-size:15px; margin-top:5px;">進度: ${current} / ${total}</div>
                            ${statsHtml}`;
                            
        if (current >= total) setTimeout(() => loader.style.display = 'none', 2000);
    }

    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                hasPausedForCurrentClip = false;
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
        const total = originalLines.length;

        const glossaryDict = await fetchGlossary();
        let glossaryRules = "";
        const glossaryPairs = Object.entries(glossaryDict).map(([k, v]) => `[${k}:${v}]`);
        if (glossaryPairs.length > 0) {
            glossaryRules = `\n7. STRICT GLOSSARY (Translate exact terms): ${glossaryPairs.join(', ')}\n`;
        }

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
            const text = originalLines[i];
            const textKey = getMatchKey(text);
            const tsLog = getTimestamp();

            const currentAvgMs = successfulAiCount > 0 ? (totalAiTimeMs / successfulAiCount) : 0;
            const remainingLines = total - i - 1;
            const currentEtaMs = remainingLines * currentAvgMs;

            if (currentVideoCache[textKey]) {
                const translated = currentVideoCache[textKey];
                window.subtitleMap.set(textKey, translated);
                console.log(`%c[${tsLog}] [${i+1}/${total}] ⚡[Cache] %c${text} %c➔ %c${translated}`, "color:#00BFFF", "color:#fff", "color:#00FF00", "color:#FFD700");
                updateUIProgress(i + 1, total, currentAvgMs, currentEtaMs);
                continue; 
            }

            // --- 終極防護 Prompt：禁止英文，針對破折號處理 ---
            const prompt = `You are a professional ${db.sourceLangName} (${db.sourceLangCode}) to ${db.targetLangName} (${db.targetLangCode}) translator. Your goal is to accurately convey the meaning and nuances of the original ${db.sourceLangName} text while adhering to ${db.targetLangName} grammar, vocabulary, and cultural sensitivities.
Produce only the ${db.targetLangName} translation, without any additional explanations or commentary.

Additional requirements:
1. STRICT TARGET LANGUAGE ONLY: The output MUST BE ENTIRELY in ${db.targetLangName}. You are strictly FORBIDDEN from outputting ANY English, Japanese Kana (Hiragana/Katakana), Romaji, or Korean Hangul. NO ENGLISH ALLOWED.
2. SYMBOLS & PUNCTUATION: If the text ends with a long dash (e.g., ⸺) or other special punctuation, do NOT let it confuse you. Retain the dash in the translation or translate the trailing off naturally.
3. SLANG & COLLOQUIALISMS: Translate slang accurately based on context (e.g., "うっさい" means "吵死了" or "閉嘴"). Do not hallucinate meanings.
4. KATAKANA RULE: Translate Katakana terms (e.g., ラーメン) into proper ${db.targetLangName} words (e.g., 拉麵). Do NOT copy them.
5. NO REFUSALS: NEVER apologize, refuse to translate, or output conversational text. ALWAYS force a translation.
6. TRANSLATE NAMES: Translate ALL character names into ${db.targetLangName} characters.${glossaryRules}

Please translate the following ${db.sourceLangName} text into ${db.targetLangName}:


${text}`;

            const startTime = Date.now();

            await new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: "http://127.0.0.1:11434/api/generate",
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({
                        model: db.aiModel,
                        prompt: prompt,
                        stream: false,
                        options: { temperature: 0.1, num_predict: 256 }
                    }),
                    onload: function(res) {
                        try {
                            const translated = JSON.parse(res.responseText).response.trim();
                            const duration = Date.now() - startTime;
                            
                            successfulAiCount++;
                            totalAiTimeMs += duration;
                            
                            const newAvgMs = totalAiTimeMs / successfulAiCount;
                            const newEtaMs = remainingLines * newAvgMs;

                            window.subtitleMap.set(textKey, translated);
                            
                            currentVideoCache[textKey] = translated;
                            allCache[videoHash].translations = currentVideoCache;
                            allCache[videoHash].timestamp = Date.now();
                            GM_setValue('ai_subtitle_cache', allCache);

                            console.log(`%c[${getTimestamp()}] [${i+1}/${total}] (${(duration/1000).toFixed(2)}s) %c${text} %c➔ %c${translated}`, "color:#888", "color:#fff", "color:#00FF00", "color:#FFD700");
                            updateUIProgress(i + 1, total, newAvgMs, newEtaMs);
                        } catch (e) {}
                        resolve();
                    },
                    onerror: () => resolve()
                });
            });
        }
        window.isAITranslating = false;
    }

    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper';
        wrapper.style.display = 'flex';
        
        const langOptions = SUPPORTED_LANGUAGES.map(lang => 
            `<option value="${lang.code}" data-name="${lang.name}">${lang.name} (${lang.code})</option>`
        ).join('');

        wrapper.innerHTML = `
            <div class="${btnWrapper.className}">
                <button class="${targetBtn.className}" id="ai-toggle-btn" style="color:#FFD700; font-weight:bold; font-size:16px;">AI 字幕</button>
            </div>
            <div id="ai-menu-popup">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-weight:bold;">
                    <input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用本地 Ollama
                </label>
                
                <div style="border-top:1px solid #444; margin:10px 0 5px 0; padding-top:10px; color:#bbb;">模型設定:</div>
                <label>
                    Ollama 模型名稱:
                    <input type="text" id="ai-model-input" value="${db.aiModel}">
                </label>

                <div style="border-top:1px solid #444; margin:10px 0 5px 0; padding-top:10px; color:#bbb;">名詞庫 (Glossary) JSON:</div>
                <label>
                    GitHub URL:
                    <input type="text" id="ai-glossary-input" value="${db.glossaryUrl}">
                </label>
                <div style="display:flex; gap:10px; margin-top:5px;">
                    <button id="ai-edit-glossary-btn" style="background:#0078D7; color:white; border:none; padding:6px; cursor:pointer; font-weight:bold; border-radius:4px; flex:1;">📝 編輯名詞庫</button>
                </div>

                <div style="border-top:1px solid #444; margin:10px 0 5px 0; padding
