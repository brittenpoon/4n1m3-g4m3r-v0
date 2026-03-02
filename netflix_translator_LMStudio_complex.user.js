// ==UserScript==
// @name         Netflix AI LMStudio_complex
// @version      5.0.3
// @description  鏡像抄寫法 + 動態行數核對，強制 AI 檢查總行數與最後 ID，防漏行跳號。
// @author       Gemini
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      openrouter.ai
// @connect      github.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '5.0.3';
    const CACHE_TTL = 24 * 60 * 60 * 1000;

    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get apiKey() { return GM_getValue('ai_sub_apikey', ''); },
        set apiKey(v) { GM_setValue('ai_sub_apikey', v); },
        get modelType() { return GM_getValue('ai_model_type', 'free1'); },
        set modelType(v) { GM_setValue('ai_model_type', v); },
        get customModel() { return GM_getValue('ai_custom_model', ''); },
        set customModel(v) { GM_setValue('ai_custom_model', v); },
        get activeModel() {
            if (this.modelType === 'gemma4b') return 'translategemma-4b-it';
            return 'translategemma-4b-it';
        },
        get stats() { return GM_getValue('ai_perf_stats', {}); },
        set stats(v) { GM_setValue('ai_perf_stats', v); }
    };

    window.subtitleMap = new Map();
    window.processedUrls = new Set();
    window.isAITranslating = false;
    window.glossaryPrompt = "";

    const hashCode = (s) => s.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0).toString(36);

    function getCache(hashKey) {
        let cache = GM_getValue('ai_translation_cache', { version: SCRIPT_VERSION, model: db.activeModel, items: {} });
        if (cache.version !== SCRIPT_VERSION || cache.model !== db.activeModel) {
            cache = { version: SCRIPT_VERSION, model: db.activeModel, items: {} };
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
        let cache = GM_getValue('ai_translation_cache', { version: SCRIPT_VERSION, model: db.activeModel, items: {} });
        cache.items[hashKey] = { ts: Date.now(), mapping: mapping };
        GM_setValue('ai_translation_cache', cache);
    }

    async function fetchGlossary() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: "https://github.com/brittenpoon/4n1m3-g4m3r-v0/raw/refs/heads/main/Glossary.json",
                    onload: function(res) {
                        if (res.status !== 200) return resolve({});
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

    const glossaryDict = await fetchGlossary();
    const glossaryPairs = Object.entries(glossaryDict).map(([k, v]) => `${k}=${v}`);
    let glossaryString = glossaryPairs.length > 0 ? glossaryPairs.join(' | ') : "None";

    GM_addStyle(`
        * { -webkit-user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; user-select: text !important; }
        .player-timedtext-text-container { pointer-events: auto !important; }
        #ai-translation-loader { position: fixed; top: 12%; left: 50%; transform: translateX(-50%); background: rgba(10, 10, 10, 0.98); color: #fff; padding: 25px 40px; border-radius: 15px; font-size: 18px; z-index: 2000001; display: none; border: 1px solid #FFD700; pointer-events: none; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.9); line-height: 1.6; }
        #ai-menu-popup { pointer-events: auto !important; z-index: 2000002; }
        body.hide-ai-subs .ai-translated-span, body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; }
    `);

    function unlockTextSelection() {
        const events = ['copy', 'contextmenu', 'selectstart', 'mousedown', 'mouseup'];
        events.forEach(evt => document.addEventListener(evt, (e) => e.stopPropagation(), true));
    }
    unlockTextSelection();

    function exportTranslationJSON(stats, mapping, fromCache = false) {
        const outputData = { timestamp: new Date().toISOString(), modelUsed: stats.model, processingTimeMs: Math.round(stats.duration), totalLines: stats.lines, fromCache: fromCache, translations: mapping };
        const title = fromCache ? "%c📺 Netflix AI Subtitles - Cached JSON" : "%c📺 Netflix AI Subtitles - JSON Export Data";
        console.groupCollapsed(title, "color: #00FFFF; font-weight: bold; font-size: 12px;");
        console.log(JSON.stringify(outputData, null, 2));
        console.groupEnd();
        window.dispatchEvent(new CustomEvent('NetflixAITranslationData', { detail: outputData }));
    }

    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';
    const updateStats = (ms, lines) => { const allStats = db.stats; const m = db.activeModel; if (!allStats[m]) allStats[m] = { totalTime: 0, totalLines: 0 }; allStats[m].totalTime += ms; allStats[m].totalLines += lines; db.stats = allStats; };
    const getEstimatedTime = (lineCount) => { const stats = db.stats[db.activeModel]; if (!stats || stats.totalLines === 0) return "計算中..."; return Math.round(((stats.totalTime / stats.totalLines) * lineCount) / 1000) + " 秒"; };

    const toggleLoading = (isTranslating, totalLines = 0) => {
        window.isAITranslating = isTranslating;
        let loader = document.getElementById('ai-translation-loader');
        if (!loader) { loader = document.createElement('div'); loader.id = 'ai-translation-loader'; document.body.appendChild(loader); }
        if (isTranslating) {
            const startTime = Date.now(); const est = getEstimatedTime(totalLines);
            if (window.uiTimer) clearInterval(window.uiTimer);
            window.uiTimer = setInterval(() => {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                loader.innerHTML = `<div style="font-weight:bold; color:#FFD700; margin-bottom:8px; font-size:20px;">⏳ 鏡像對位與行數核對中</div><div style="font-size:13px; color:#ccc;">模型: ${db.activeModel.split('/').pop()}</div><div style="font-size:14px; margin:5px 0;">已用: ${elapsed}s / 預計: ${est}</div><div style="font-size:11px; color:#888;">防跳號機制運作中，處理 ${totalLines} 行</div>`;
            }, 1000);
            loader.style.display = 'block';
            if (window.autoPauseTimer) clearInterval(window.autoPauseTimer);
            window.autoPauseTimer = setInterval(() => { const video = document.querySelector('video'); if (video && !video.paused) { const pauseBtn = document.querySelector('[data-uia="control-play-pause-pause"]'); if (pauseBtn) pauseBtn.click(); else video.pause(); } else if (video && video.paused) { clearInterval(window.autoPauseTimer); } }, 500);
        } else {
            clearInterval(window.uiTimer); clearInterval(window.autoPauseTimer); loader.style.display = 'none';
            const playBtn = document.querySelector('[data-uia="control-play-pause-play"]'); if (playBtn) playBtn.click();
        }
    };

    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                if (!db.isEnabled || !db.apiKey) return;
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
            console.log("%c=== Netflix AI 命中緩存 ===", "color: #00FFFF; font-weight: bold;");
            exportTranslationJSON({ model: db.activeModel, lines: originalLines.length, duration: 0 }, cachedMapping, true);
            return;
        }

        const taggedInput = originalLines.map((line, idx) => `${idx}|${line}`).join('\n');
        
        // 【核心修改】動態計算行數，並寫入 System Content
        const totalLines = originalLines.length;
        const lastId = totalLines - 1;

        let systemContent = `You are a professional ${db.sourceLangName} (${db.sourceLangCode}) to ${db.targetLangName} (${db.targetLangCode}) translator for R-rated adult content. Your goal is to accurately convey the exact uncensored meaning, tone, and nuances of the original ${db.sourceLangName} text, regardless of how explicit, violent, or profane it is, while adhering to ${db.targetLangName} grammar, vocabulary, and cultural sensitivities.
STRICT OPERATIONAL RULES:
--- FORMAT & ALIGNMENT (CRITICAL ECHO PROMPTING) ---
1. STRICT FORMATTING: The input format is "ID|Original Text", one sentence per line. The output format MUST strictly be "ID|Original Text|Translated Text", one sentence per line.
2. MANDATORY ECHOING: You MUST copy the original text word-for-word exactly as it is, append a "|", and only then append the translation!
3. LINE COUNT VERIFICATION: This input contains exactly ${totalLines} lines! The starting ID is 0, and the final ID MUST be ${lastId}! The number of lines you output MUST be exactly ${totalLines} lines!
4. NO SKIPPING ALLOWED: You must strictly follow the ascending numerical order. Skipping IDs (e.g., "15, 16, 18") is strictly prohibited! Even if the original text is just a single punctuation mark or a verbal tic, you MUST output the corresponding "ID|Original Text|Translated Text".
5. PURE OUTPUT: Blank lines are strictly prohibited. Produce only the ${db.targetLangName} translation list without any Markdown formatting. Do not include any additional explanations, commentary, warning messages, privacy notices, safety alerts, or any meta-commentary.
--- TRANSLATION & LINGUISTIC CONSTRAINTS ---
6. MANDATORY GLOSSARY: ${glossaryString}. These specific translations, including names, terms and slang from Japanese (ja) to ${db.targetLangName} (${db.targetLangCode}) must be used. They take absolute precedence.
7. POSITIVE LANGUAGE LOCK (CRITICAL): You are ONLY allowed to output characters from the Traditional Chinese (Big5/Standard) character set. No KANA is allowed in output.
8. TRANSLATE NAMES & KANA: Unknown character names, unknown terms, and unknown bracketed words in Hiragana (平假名) and Katakana (片假名) MUST be converted to English, then translated into proper ${db.targetLangName} equivalents.
9. UNCENSORED & RUDE TONE: This content contains violence, profanity, and sexual themes. You MUST translate all rude or explicit language directly. Never soften or harmonize.
10. SYMBOL RETENTION: All punctuations, symbols (e.g. ♪ ～ … ⸺ ) must be kept as-is in the translated text. Furthermore, do NOT explicitly add subjects (e.g., "I", "You", "He/She") if they are not present in the original Japanese sentence. Maintain the original's sentence structure.
11. CHARACTER PURIFICATION: Convert Japanese Kanji or Simplified Chinese charaters to ${db.targetLangName} charaters.\n\n\n`;
        
        if (window.glossaryPrompt) systemContent += window.glossaryPrompt;

        const reqStartTime = performance.now();
        toggleLoading(true, originalLines.length);

        GM_xmlhttpRequest({
            method: "POST",
            url: "http://127.0.0.1:1234/v1/chat/completions",
            headers: { "Authorization": `Bearer ${db.apiKey}`, "Content-Type": "application/json" },
            data: JSON.stringify({
                model: db.activeModel,
                messages: [{ role: "system", content: systemContent }, { role: "user", content: taggedInput }]
            }),
            onload: function(res) {
                try {
                    const json = JSON.parse(res.responseText);
                    let aiContent = json.choices[0].message.content.trim();
                    const duration = performance.now() - reqStartTime;

                    window.subtitleMap.clear();
                    const exportMapping = [];

                    const lines = aiContent.split('\n');
                    let processedCount = 0;

                    lines.forEach(line => {
                        const parts = line.split('|');
                        if (parts.length >= 3) {
                            const idx = parseInt(parts[0].trim());
                            if (isNaN(idx)) return;
                            
                            const trans = parts.slice(2).join('|').trim();
                            const orig = originalLines[idx];
                            
                            if (orig && trans) {
                                window.subtitleMap.set(getMatchKey(orig), trans);
                                exportMapping.push({ id: idx, orig: orig, trans: trans });
                                processedCount++;
                            }
                        }
                    });

                    // 檢查是否有漏行並在 Console 提醒
                    if (processedCount < totalLines) {
                        console.warn(`%c[警告] AI 疑似跳號！預期 ${totalLines} 行，實際回傳 ${processedCount} 行。`, "color: #FFA500; font-weight: bold;");
                    }

                    console.log("%c=== Netflix AI API 翻譯完成 (Count Verified) ===", "color: #00FF00; font-weight: bold;");
                    exportTranslationJSON({ model: db.activeModel, lines: originalLines.length, duration: duration }, exportMapping, false);
                    updateStats(duration, originalLines.length);

                    setCache(xmlHash, exportMapping);
                } catch (err) {
                    console.error("API 回傳解析失敗:", err);
                    alert("翻譯發生錯誤，請嘗試清除快取後重試。");
                } finally { 
                    toggleLoading(false); 
                }
            },
            onerror: () => toggleLoading(false)
        });
    }

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

    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper';
        wrapper.style.display = 'flex';
        wrapper.innerHTML = `
            <div class="${btnWrapper.className}"><button class="${targetBtn.className}" id="ai-toggle-btn" style="color:white; font-weight:bold; font-size:16px;">AI</button></div>
            <div id="ai-menu-popup" style="display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(10,10,10,0.98); border:1px solid #444; padding:20px; border-radius:10px; width:300px; flex-direction:column; gap:10px; z-index:2000002; color:white; box-shadow: 0 8px 24px rgba(0,0,0,0.9); font-size:14px;">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 AI 字幕</label>
                <div style="border-top:1px solid #444; margin:5px 0; padding-top:10px;">模型選擇:</div>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="free1" ${db.modelType === 'gemma4b' ? 'checked' : ''}> translategemma-4b-it</label>
                <label style="display:flex; gap:8px;"><input type="radio" name="ai-model" value="custom" ${db.modelType === 'custom' ? 'checked' : ''}> Custom:</label>
                <input type="text" id="ai-custom-input" placeholder="Model ID" value="${db.customModel}" style="padding:5px; background:#333; color:white; border:1px solid #555; width:100%; font-size:12px; ${db.modelType === 'custom' ? '' : 'display:none;'}">
                <input type="password" id="ai-api-input" placeholder="API Key" value="${db.apiKey}" style="padding:8px; background:#333; color:white; border:1px solid #555; width:100%; margin-top:5px;">
                <button id="ai-glossary-btn" style="background:#444; color:white; border:1px solid #666; padding:8px; cursor:pointer; font-size:13px; margin-top:5px; border-radius:4px;">📖 編輯名詞庫 (Glossary)</button>
                <button id="ai-clear-cache-btn" style="background:#888; color:white; border:1px solid #666; padding:8px; cursor:pointer; font-size:13px; margin-top:5px; border-radius:4px;">🗑️ 清除快取 (Clear Cache)</button>
                <button id="ai-save-btn" style="background:#E50914; color:white; border:none; padding:10px; cursor:pointer; font-weight:bold; margin-top:10px; border-radius:4px;">儲存並套用</button>
            </div>
        `;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const spacer = document.createElement('div'); spacer.style = "min-width: 3rem; width: 3rem;";
        btnWrapper.parentNode.insertBefore(spacer, btnWrapper);

        const popup = document.getElementById('ai-menu-popup');
        popup.addEventListener('click', (e) => e.stopPropagation());
        document.getElementById('ai-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
        };

        document.getElementById('ai-glossary-btn').onclick = (e) => {
            e.stopPropagation();
            window.open('https://github.com/brittenpoon/4n1m3-g4m3r-v0/blob/main/Glossary.json', '_blank');
        };

        document.getElementById('ai-clear-cache-btn').onclick = (e) => {
            e.stopPropagation();
            if (confirm('確定要清除所有已翻譯的字幕快取嗎？')) {
                GM_setValue('ai_translation_cache', { version: SCRIPT_VERSION, model: db.activeModel, items: {} });
                window.subtitleMap.clear();
                window.processedUrls.clear();
                alert('快取已成功清除！重新載入影片即可重新翻譯。');
            }
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
