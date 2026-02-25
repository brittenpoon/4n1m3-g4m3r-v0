// ==UserScript==
// @name         Netflix AI 雙語字幕 (v1.31.0)
// @version      1.31.0
// @match        https://www.netflix.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      openrouter.ai
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. Database & Settings ---
    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get apiKey() { return GM_getValue('ai_sub_apikey', ''); },
        set apiKey(v) { GM_setValue('ai_sub_apikey', v); },
        get modelType() { return GM_getValue('ai_model_type', 'paid'); },
        set modelType(v) { GM_setValue('ai_model_type', v); },
        get customModel() { return GM_getValue('ai_custom_model', ''); },
        set customModel(v) { GM_setValue('ai_custom_model', v); },
        get activeModel() {
            if (this.modelType === 'paid') return 'google/gemini-2.5-flash-lite-preview-09-2025';
            return this.customModel || 'arcee-ai/trinity-large-preview:free';
        },
        // 譯名資料庫設定
        get glossary() { return GM_getValue('ai_glossary', {}); },
        set glossary(v) { GM_setValue('ai_glossary', v); },
        get githubUrl() { return GM_getValue('ai_github_url', ''); },
        set githubUrl(v) { GM_setValue('ai_github_url', v); }
    };

    window.subtitleMap = new Map();
    window.processedUrls = new Set();
    window.isAITranslating = false;

    // --- 2. 樣式注入 (含解除選取限制) ---
    GM_addStyle(`
        /* 1. 解除 Netflix 文字選取鎖定 */
        .player-timedtext, 
        .player-timedtext-text-container, 
        .player-timedtext-text-container span {
            user-select: text !important;
            -webkit-user-select: text !important;
            pointer-events: auto !important;
        }

        #ai-translation-loader {
            position: fixed; top: 12%; left: 50%; transform: translateX(-50%);
            background: rgba(10, 10, 10, 0.95); color: #fff; padding: 25px 40px;
            border-radius: 15px; font-size: 18px; z-index: 2000001; display: none;
            border: 1px solid #FFD700; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.9); line-height: 1.6;
        }

        #ai-menu-popup, #ai-db-modal {
            position: absolute; background: rgba(15, 15, 15, 0.98);
            border: 1px solid #444; color: white; border-radius: 10px;
            z-index: 2000002; display: none; box-shadow: 0 8px 32px rgba(0,0,0,0.8);
        }

        #ai-menu-popup { bottom: 80px; left: 50%; transform: translateX(-50%); width: 320px; padding: 20px; flex-direction: column; gap: 12px; }
        
        #ai-db-modal {
            top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: 500px; padding: 30px; flex-direction: column; gap: 15px;
        }

        #ai-db-modal textarea {
            width: 100%; height: 200px; background: #222; color: #00FF00;
            border: 1px solid #555; font-family: monospace; padding: 10px; border-radius: 5px;
        }

        .ai-btn-red { background: #E50914; color: white; border: none; padding: 10px; cursor: pointer; font-weight: bold; border-radius: 4px; }
        .ai-btn-gray { background: #444; color: white; border: none; padding: 10px; cursor: pointer; border-radius: 4px; }
        
        .ai-translated-span { display: inline-block !important; }
    `);

    const getMatchKey = (text) => text ? text.replace(/[\s\r\n\u200B-\u200D\uFEFF]+/g, '').trim() : '';

    // --- 3. 資料庫與翻譯邏輯 ---
    async function fetchGithubGlossary() {
        if (!db.githubUrl) return;
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: db.githubUrl,
                onload: (res) => {
                    try {
                        const json = JSON.parse(res.responseText);
                        db.glossary = json;
                        alert("成功從 GitHub 載入資料庫！");
                        resolve();
                    } catch (e) { alert("JSON 格式錯誤，請檢查內容。"); resolve(); }
                },
                onerror: () => { alert("無法連線到 GitHub URL。"); resolve(); }
            });
        });
    }

    async function processAndTranslate(rawXml, url) {
        if (window.processedUrls.has(url) || window.isAITranslating) return;
        window.processedUrls.add(url);

        const parser = new DOMParser();
        const doc = parser.parseFromString(rawXml, "text/xml");
        const originalLines = Array.from(doc.querySelectorAll('p')).map(p => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = p.innerHTML.replace(/<br\s*\/?>/gi, ' ');
            return tempDiv.textContent.trim();
        }).filter(t => t.length > 0);
        
        if (originalLines.length === 0) return;

        // 整合譯名資料庫到 Prompt
        const glossaryStr = JSON.stringify(db.glossary, null, 2);
        const taggedInput = originalLines.map((line, idx) => `[${idx}] ${line} [/${idx}]`).join('\n');

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
                    【譯名資料庫（請嚴格遵守）】：
                    ${glossaryStr}
                    【對位死命令】：
                    1. 你會收到 "[id] 原文 [/id]" 格式。
                    2. 必須 1:1 對應，譯文必須包在標籤內："[id] 譯文 [/id]"。
                    3. 禁止合併 ID，禁止跳過。每一組標籤是獨立的。`
                }, {
                    role: "user",
                    content: taggedInput
                }]
            }),
            onload: function(res) {
                try {
                    const json = JSON.parse(res.responseText);
                    const aiContent = json.choices[0].message.content;
                    window.subtitleMap.clear();
                    const lineRegex = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\/\1\]|\s*\[\d+\]|$)/g;
                    let match;
                    while ((match = lineRegex.exec(aiContent)) !== null) {
                        const idx = parseInt(match[1]);
                        let trans = match[2].replace(/\[\/\d+\]/g, '').trim();
                        if (originalLines[idx]) window.subtitleMap.set(getMatchKey(originalLines[idx]), trans);
                    }
                } finally { toggleLoading(false); }
            },
            onerror: () => toggleLoading(false)
        });
    }

    // --- 4. 介面與渲染 ---
    const toggleLoading = (show, total = 0) => {
        const loader = document.getElementById('ai-translation-loader') || document.createElement('div');
        if (!loader.id) { loader.id = 'ai-translation-loader'; document.body.appendChild(loader); }
        loader.style.display = show ? 'block' : 'none';
        if (show) loader.innerHTML = `⏳ AI 翻譯對位中... (${total} 行)`;
    };

    const observer = new MutationObserver(() => {
        if (!db.isEnabled) return;
        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;
            const key = getMatchKey(container.innerText);
            const translatedText = window.subtitleMap.get(key);

            if (translatedText) {
                const outerSpan = container.querySelector('span');
                if (!outerSpan) return;
                const innerSpan = outerSpan.querySelector('span:not(.ai-translated-span)');
                if (!innerSpan) return;

                // 樣式處理
                outerSpan.style.textAlign = "center";
                const baseFontSize = parseFloat(window.getComputedStyle(innerSpan).fontSize);
                Array.from(outerSpan.querySelectorAll('span')).filter(s => !s.classList.contains('ai-translated-span'))
                    .forEach(s => s.style.fontSize = (baseFontSize * 0.8) + "px");

                if (!document.getElementById(key + '-br')) {
                    const br = document.createElement('br'); br.id = key + '-br';
                    outerSpan.appendChild(br);
                }

                const aiSpan = innerSpan.cloneNode(true);
                aiSpan.classList.add('ai-translated-span');
                aiSpan.innerText = translatedText;
                aiSpan.style.fontSize = baseFontSize + "px";
                outerSpan.appendChild(aiSpan);
                container.dataset.aiTranslated = "true";
            }
        });
        injectControlMenu();
    });

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // --- 5. 選單與資料庫頁面 ---
    function injectControlMenu() {
        if (document.getElementById('ai-subtitle-wrapper')) return;
        const targetBtn = document.querySelector('[data-uia="control-audio-subtitle"]');
        if (!targetBtn) return;
        const btnWrapper = targetBtn.closest('div.medium') || targetBtn.parentElement;
        
        const wrapper = document.createElement('div');
        wrapper.id = 'ai-subtitle-wrapper';
        wrapper.style.display = 'flex';
        wrapper.innerHTML = `
            <div class="${btnWrapper.className}"><button id="ai-toggle-btn" class="${targetBtn.className}" style="color:white; font-weight:bold;">AI 譯</button></div>
            <div id="ai-menu-popup">
                <label><input type="checkbox" id="ai-cb-enable" ${db.isEnabled ? 'checked' : ''}> 啟用 AI 字幕</label>
                <button id="ai-open-db" class="ai-btn-gray">⚙️ 管理譯名資料庫</button>
                <input type="password" id="ai-api-input" placeholder="API Key" value="${db.apiKey}">
                <button id="ai-save-btn" class="ai-btn-red">儲存並套用</button>
            </div>
            <div id="ai-db-modal">
                <h3 style="margin:0">譯名資料庫 (JSON 格式)</h3>
                <p style="font-size:12px; color:#aaa">範例: {"オルン": "歐倫"}</p>
                <textarea id="ai-db-content">${JSON.stringify(db.glossary, null, 2)}</textarea>
                <input type="text" id="ai-db-github" placeholder="GitHub Raw JSON URL (選填)" value="${db.githubUrl}">
                <div style="display:flex; gap:10px">
                    <button id="ai-db-sync" class="ai-btn-gray" style="flex:1">從 GitHub 同步</button>
                    <button id="ai-db-save" class="ai-btn-red" style="flex:1">儲存資料庫</button>
                    <button id="ai-db-close" class="ai-btn-gray">關閉</button>
                </div>
            </div>
        `;
        btnWrapper.parentNode.insertBefore(wrapper, btnWrapper);

        // 事件綁定
        document.getElementById('ai-toggle-btn').onclick = (e) => {
            e.stopPropagation();
            const popup = document.getElementById('ai-menu-popup');
            popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
        };

        document.getElementById('ai-open-db').onclick = () => {
            document.getElementById('ai-menu-popup').style.display = 'none';
            document.getElementById('ai-db-modal').style.display = 'flex';
        };

        document.getElementById('ai-db-close').onclick = () => document.getElementById('ai-db-modal').style.display = 'none';

        document.getElementById('ai-db-sync').onclick = async () => {
            db.githubUrl = document.getElementById('ai-db-github').value.trim();
            await fetchGithubGlossary();
            document.getElementById('ai-db-content').value = JSON.stringify(db.glossary, null, 2);
        };

        document.getElementById('ai-db-save').onclick = () => {
            try {
                db.glossary = JSON.parse(document.getElementById('ai-db-content').value);
                db.githubUrl = document.getElementById('ai-db-github').value.trim();
                alert("資料庫已儲存！下次翻譯時生效。");
            } catch (e) { alert("JSON 格式錯誤！"); }
        };

        document.getElementById('ai-save-btn').onclick = () => {
            db.isEnabled = document.getElementById('ai-cb-enable').checked;
            db.apiKey = document.getElementById('ai-api-input').value.trim();
            location.reload();
        };
    }

    // 攔截器
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.includes(".nflxvideo.net/?o=")) {
            this.addEventListener('load', function() {
                if (db.isEnabled && db.apiKey) processAndTranslate(this.responseText, url);
            });
        }
        oldOpen.apply(this, arguments);
    };
})();
