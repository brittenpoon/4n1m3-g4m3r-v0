// ==UserScript==
// @name         Netflix AI 字幕 (Ollama TranslateGemma 版)
// @version      4.0.0
// @description  本地 Ollama 部署，官方 Prompt 格式，內建語言選單。
// @author       Gemini
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. 設定與語言庫 ---
    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get sourceLangCode() { return GM_getValue('ai_source_lang_code', 'ja'); },
        set sourceLangCode(v) { GM_setValue('ai_source_lang_code', v); },
        get sourceLangName() { return GM_getValue('ai_source_lang_name', 'Japanese'); },
        set sourceLangName(v) { GM_setValue('ai_source_lang_name', v); },
        get targetLangCode() { return GM_getValue('ai_target_lang_code', 'zh-Hant-HK'); },
        set targetLangCode(v) { GM_setValue('ai_target_lang_code', v); },
        get targetLangName() { return GM_getValue('ai_target_lang_name', 'Chinese'); },
        set targetLangName(v) { GM_setValue('ai_target_lang_name', v); }
    };

    // 常用語言清單 (可自行擴充)
    const SUPPORTED_LANGUAGES = [
        { code: 'en', name: 'English' },
        { code: 'ja', name: 'Japanese' },
        { code: 'zh-Hant-HK', name: 'Chinese' }, // 配合 TranslateGemma 官方命名習慣
        { code: 'zh-Hant-TW', name: 'Chinese' },
        { code: 'zh-Hans', name: 'Chinese' },
        { code: 'ko', name: 'Korean' },
        { code: 'fr', name: 'French' },
        { code: 'de', name: 'German' },
        { code: 'es', name: 'Spanish' },
        { code: 'vi', name: 'Vietnamese' },
        { code: 'th', name: 'Thai' }
    ];

    window.subtitleMap = new Map();
    window.processedUrls = new Set();
    window.isAITranslating = false;

    // --- 2. 樣式設定 ---
    GM_addStyle(`
        * { -webkit-user-select: text !important; -moz-user-select: text !important; -ms-user-select: text !important; user-select: text !important; }
        .player-timedtext-text-container { pointer-events: auto !important; }
        #ai-menu-popup { pointer-events: auto !important; z-index: 2000002; }
        body.hide-ai-subs .ai-translated-span, body.hide-ai-subs .ai-translated-br { display: none !important; }
        .ai-translated-span { display: inline-block !important; color: #FFD700 !important; font-weight: bold; text-shadow: 1px 1px 2px black, 0 0 1em black !important; }
    `);

    // 解除文字選取限制
    const events = ['copy', 'contextmenu', 'selectstart', 'mousedown', 'mouseup'];
    events.forEach(evt => document.addEventListener(evt, (e) => e.stopPropagation(), true));
    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';

    // --- 3. 攔截 XML 與 API 呼叫 ---
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', async function() {
                if (!db.isEnabled || window.location.pathname.startsWith('/browse')) return;
                await processAndTranslate(this.responseText, url);
            });
        }
        oldOpen.apply(this, arguments);
    };

    async function processAndTranslate(rawXml, url) {
        if (window.processedUrls.has(url) || window.isAITranslating) return;
        window.processedUrls.add(url);
        window.isAITranslating = true;

        const parser = new DOMParser();
        const doc = parser.parseFromString(rawXml, "text/xml");
        const pTags = Array.from(doc.querySelectorAll('p'));
        
        // 單行 ID 合併處理：將 <br> 或換行符號替換為空格，確保一個 ID 只有一行
        const originalLines = pTags.map(p => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = p.innerHTML.replace(/<br\s*\/?>/gi, ' ');
            return tempDiv.textContent.replace(/\n/g, ' ').trim();
        }).filter(t => t.length > 0);

        if (originalLines.length === 0) {
            window.isAITranslating = false;
            return;
        }

        // 格式化為 ID|原文
        const processedLines = originalLines.map((line, idx) => `${idx}|${line}`).join('\n');

        // TranslateGemma 官方指定 Prompt (注意兩行空行)
        const SOURCE_LANG = db.sourceLangName;
        const SOURCE_CODE = db.sourceLangCode;
        const TARGET_LANG = db.targetLangName;
        const TARGET_CODE = db.targetLangCode;

        const officialPrompt = `You are a professional ${SOURCE_LANG} (${SOURCE_CODE}) to ${TARGET_LANG} (${TARGET_CODE}) translator. Your goal is to accurately convey the meaning and nuances of the original ${SOURCE_LANG} text while adhering to ${TARGET_LANG} grammar, vocabulary, and cultural sensitivities. Produce only the ${TARGET_LANG} translation, without any additional explanations or commentary. Please translate the following ${SOURCE_LANG} text into ${TARGET_LANG}:


${processedLines}`;

        console.log(`[Ollama] 開始翻譯: ${SOURCE_CODE} -> ${TARGET_CODE} (${originalLines.length} 行)`);

        GM_xmlhttpRequest({
            method: "POST",
            url: "http://localhost:11434/api/generate",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                model: "translategemma:12b",
                prompt: officialPrompt,
                stream: false,
                options: {
                    temperature: 0.0,
                    num_ctx: 8192,
                    num_predict: 4096
                }
            }),
            onload: function(res) {
                try {
                    const json = JSON.parse(res.responseText);
                    const aiContent = json.response.trim();

                    window.subtitleMap.clear();
                    const lines = aiContent.split('\n');

                    lines.forEach(line => {
                        const parts = line.split('|');
                        if (parts.length >= 2) {
                            const idx = parseInt(parts[0].trim());
                            if (isNaN(idx)) return;
                            
                            // 擷取最後一部分作為譯文
                            const trans = parts.slice(1).join('|').trim();
                            const orig = originalLines[idx];
                            
                            if (orig && trans) {
                                window.subtitleMap.set(getMatchKey(orig), trans);
                            }
                        }
                    });
                    console.log("[Ollama] 翻譯完成並已載入記憶體。");
                } catch (err) {
                    console.error("[Ollama] 解析失敗:", err);
                } finally {
                    window.isAITranslating = false;
                }
            },
            onerror: () => {
                console.error("[Ollama] 連線失敗，請檢查 Ollama 是否運行中。");
                window.isAITranslating = false;
            }
        });
    }

    // --- 4. 字幕渲染邏輯 ---
    const observer = new MutationObserver(() => {
        if (!db.isEnabled) return;

        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;

            // 將當前畫面上的多行字幕合併後再比對
            let currentText = "";
            const spans = container.querySelectorAll('span');
            spans.forEach(s => {
                 if (s.tagName.toLowerCase() !== 'br' && !s.classList.contains('ai-translated-span')) {
                     currentText += s.innerText + " ";
                 }
            });
            const currentMatchKey = getMatchKey(currentText);
            const translatedText = window.subtitleMap.get(currentMatchKey);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;
                
                outerSpan.style.textAlign = "center";
                outerSpan.style.display = "inline-block";
                
                // 調整原始字體大小
                const innerSpan = outerSpan.querySelector('span:not(.ai-translated-span)');
                if (innerSpan) {
                    const style = window.getComputedStyle(innerSpan);
                    const baseFontSize = parseFloat(style.fontSize);
                    const originalSpans = Array.from(outerSpan.querySelectorAll('span')).filter(s => s.getAttribute('lang') !== 'zh' && !s.classList.contains('ai-translated-span'));
                    originalSpans.forEach(s => s.style.fontSize = (baseFontSize * 0.75) + "px");

                    const br = document.createElement('br');
                    br.className = 'ai-translated-br';
                    outerSpan.appendChild(br);

                    const aiSpan = innerSpan.cloneNode(true);
                    aiSpan.classList.add('ai-translated-span');
                    aiSpan.setAttribute('lang', 'zh');
                    aiSpan.style.fontSize = (baseFontSize * 1.1) + "px"; // 放大中文字幕
                    aiSpan.innerText = translatedText;

                    outerSpan.appendChild(aiSpan);
                    container.dataset.aiTranslated = "true";
                }
            }
        });
        injectControlMenu();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 5. UI 控制面板 ---
    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper';
        wrapper.style.display = 'flex';
        
        // 生成語言選項 HTML
        const langOptions = SUPPORTED_LANGUAGES.map(lang => 
            `<option value="${lang.code}" data-name="${lang.name}">${lang.name} (${lang.code})</option>`
        ).join('');

        wrapper.innerHTML = `
            <div class="${btnWrapper.className}">
                <button class="${targetBtn.className}" id="ai-toggle-btn" style="color:#FFD700; font-weight:bold; font-size:16px;">AI 字幕</button>
            </div>
            <div id="ai-menu-popup" style="display:none; position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:rgba(10,10,10,0.95); border:1px solid #444; padding:20px; border-radius:10px; width:280px; flex-direction:column; gap:10px; z-index:2000002; color:white; font-size:14px; box-shadow: 0 8px 24px rgba(0,0,0,0.8);">
                <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                    <input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用本地 Ollama 翻譯
                </label>
                
                <div style="border-top:1px solid #444; margin:5px 0; padding-top:10px; color:#bbb;">語言設定 (重新載入生效):</div>
                
                <label style="display:flex; flex-direction:column; gap:5px;">
                    來源 (Source):
                    <select id="ai-source-lang-select" style="background:#333; color:white; padding:6px; border:1px solid #666; border-radius:4px; outline:none;">
                        ${langOptions}
                    </select>
                </label>

                <label style="display:flex; flex-direction:column; gap:5px;">
                    目標 (Target):
                    <select id="ai-target-lang-select" style="background:#333; color:white; padding:6px; border:1px solid #666; border-radius:4px; outline:none;">
                        ${langOptions}
                    </select>
                </label>

                <button id="ai-save-btn" style="background:#E50914; color:white; border:none; padding:10px; cursor:pointer; font-weight:bold; margin-top:10px; border-radius:4px; transition:0.2s;">儲存設定</button>
            </div>
        `;
        
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);
        const spacer = document.createElement('div'); 
        spacer.style = "min-width: 3rem; width: 3rem;";
        btnWrapper.parentNode.insertBefore(spacer, btnWrapper);

        const popup = document.getElementById('ai-menu-popup');
        popup.addEventListener('click', (e) => e.stopPropagation());
        
        document.getElementById('ai-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
        };

        // 載入預設值
        document.getElementById('ai-source-lang-select').value = db.sourceLangCode;
        document.getElementById('ai-target-lang-select').value = db.targetLangCode;

        // 儲存邏輯
        document.getElementById('ai-save-btn').onclick = () => {
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            
            const sourceSelect = document.getElementById('ai-source-lang-select');
            db.sourceLangCode = sourceSelect.value;
            db.sourceLangName = sourceSelect.options[sourceSelect.selectedIndex].getAttribute('data-name');
            
            const targetSelect = document.getElementById('ai-target-lang-select');
            db.targetLangCode = targetSelect.value;
            db.targetLangName = targetSelect.options[targetSelect.selectedIndex].getAttribute('data-name');
            
            location.reload();
        };

        document.addEventListener('click', (e) => { 
            if (popup.style.display === 'flex' && !wrapper.contains(e.target)) popup.style.display = 'none'; 
        });
    }
})();
