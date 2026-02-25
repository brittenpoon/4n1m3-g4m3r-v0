// ==UserScript==
// @name         KLZ9 Manga Translator Pro
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  OCR and translate manga pages. Improved AI Prompt for contextual and grouped bubble translation.
// @match        https://klz9.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      openrouter.ai
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration & Database ---
    const DB_PREFIX = "MangaTranslator_";

    let settings = {
        apiKey: GM_getValue(DB_PREFIX + "ApiKey", ""),
        aiModel: GM_getValue(DB_PREFIX + "AiModel", "google/gemini-2.5-flash-lite-preview-09-2025"),
        fontSizeJa: GM_getValue(DB_PREFIX + "FontSizeJa", 12),
        fontSizeZh: GM_getValue(DB_PREFIX + "FontSizeZh", 16),
        isMinimized: GM_getValue(DB_PREFIX + "IsMinimized", false)
    };

    function saveSettings() {
        GM_setValue(DB_PREFIX + "ApiKey", settings.apiKey);
        GM_setValue(DB_PREFIX + "AiModel", settings.aiModel);
        GM_setValue(DB_PREFIX + "FontSizeJa", settings.fontSizeJa);
        GM_setValue(DB_PREFIX + "FontSizeZh", settings.fontSizeZh);
        GM_setValue(DB_PREFIX + "IsMinimized", settings.isMinimized);
        updateGlobalStyles();
    }

    // --- UI Construction ---
    const styleSheet = document.createElement("style");
    document.head.appendChild(styleSheet);

    function updateGlobalStyles() {
        styleSheet.innerText = `
            :root {
                --mt-font-ja: ${settings.fontSizeJa}px;
                --mt-font-zh: ${settings.fontSizeZh}px;
            }
            .mt-panel {
                background: #fff;
                color: #000;
                min-width: 320px;
                width: 320px;
                padding: 15px;
                margin-right: 15px;
                font-family: "Microsoft JhengHei", sans-serif;
                box-shadow: 2px 2px 10px rgba(0,0,0,0.3);
                border-radius: 8px;
                overflow-y: auto;
                flex-shrink: 0;
            }
            .mt-row { margin-bottom: 15px; border-bottom: 1px dashed #ddd; padding-bottom: 10px; }
            .mt-ja { color: #666; font-size: var(--mt-font-ja); line-height: 1.5; margin-bottom: 6px; }
            .mt-zh { color: #000; font-weight: bold; font-size: var(--mt-font-zh); line-height: 1.6; }
            .mt-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: sans-serif; font-size: 13px; }
            .mt-control-panel { background: rgba(30, 41, 59, 0.95); color: white; padding: 15px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(5px); width: 260px; }
            .mt-btn { background: #4f46e5; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: background 0.2s; }
            .mt-btn:hover { background: #4338ca; }
            .mt-btn:disabled { background: #6b7280; cursor: not-allowed; }
            .mt-btn-sm { padding: 2px 6px; margin: 0 2px; }
            .mt-btn-retry { background: #f59e0b; margin-left: 5px; }
            .mt-btn-retry:hover { background: #d97706; }
            .mt-btn-hamburger { background: rgba(30, 41, 59, 0.95); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 20px; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.5); cursor: pointer; }
            .mt-btn-hamburger:hover { background: rgba(50, 61, 79, 0.95); }
            .mt-label { margin-right: 5px; display: inline-block; width: 60px; }
            .mt-divider { margin: 10px 0; border-top: 1px solid rgba(255,255,255,0.2); }
        `;
    }

    function createControlPanel() {
        if (document.querySelector('.mt-container')) return; 
        const container = document.createElement('div');
        container.className = 'mt-container';

        const minView = document.createElement('div');
        minView.className = 'mt-btn-hamburger';
        minView.innerHTML = '☰';
        minView.style.display = settings.isMinimized ? 'flex' : 'none';

        const fullView = document.createElement('div');
        fullView.className = 'mt-control-panel';
        fullView.style.display = settings.isMinimized ? 'none' : 'block';

        fullView.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div style="font-weight:bold; font-size:14px;">Manga Translator Pro</div>
                <button id="mt-btn-min" class="mt-btn" style="background:transparent; border:1px solid #94a3b8; padding:0 6px; color:#94a3b8; border-radius:4px;">_</button>
            </div>
            <div style="margin-bottom:5px;">
                <button id="mt-btn-all" class="mt-btn" style="width:100%">一鍵翻譯全部</button>
            </div>
            <div class="mt-divider"></div>
            <div style="margin-bottom:5px; display:flex; align-items:center;">
                <span class="mt-label">日文大小:</span>
                <button class="mt-btn mt-btn-sm" id="mt-ja-minus">-</button>
                <button class="mt-btn mt-btn-sm" id="mt-ja-plus">+</button>
            </div>
            <div style="margin-bottom:5px; display:flex; align-items:center;">
                <span class="mt-label">中文大小:</span>
                <button class="mt-btn mt-btn-sm" id="mt-zh-minus">-</button>
                <button class="mt-btn mt-btn-sm" id="mt-zh-plus">+</button>
            </div>
            <div class="mt-divider"></div>
            <div style="margin-bottom:5px;">
                <button id="mt-btn-model" class="mt-btn" style="width:100%; background:#4b5563; margin-bottom:5px;">設定 AI 模型</button>
                <button id="mt-btn-apikey" class="mt-btn" style="width:100%; background:#374151;">設定 API Key</button>
            </div>
        `;

        container.appendChild(minView);
        container.appendChild(fullView);
        document.body.appendChild(container);

        minView.onclick = () => { settings.isMinimized = false; saveSettings(); minView.style.display = 'none'; fullView.style.display = 'block'; };
        document.getElementById('mt-btn-min').onclick = () => { settings.isMinimized = true; saveSettings(); fullView.style.display = 'none'; minView.style.display = 'flex'; };

        document.getElementById('mt-btn-all').onclick = translateAll;
        document.getElementById('mt-btn-apikey').onclick = promptApiKey;
        document.getElementById('mt-btn-model').onclick = promptModel;

        document.getElementById('mt-ja-minus').onclick = () => { settings.fontSizeJa--; saveSettings(); };
        document.getElementById('mt-ja-plus').onclick = () => { settings.fontSizeJa++; saveSettings(); };
        document.getElementById('mt-zh-minus').onclick = () => { settings.fontSizeZh--; saveSettings(); };
        document.getElementById('mt-zh-plus').onclick = () => { settings.fontSizeZh++; saveSettings(); };
    }

    // --- Core Logic ---
    function promptApiKey() {
        const key = prompt("請輸入 OpenRouter API Key:", settings.apiKey);
        if (key !== null) { settings.apiKey = key.trim(); saveSettings(); alert("API Key 已儲存！"); }
    }

    function promptModel() {
        const m = prompt("請輸入 OpenRouter Model ID:", settings.aiModel);
        if (m !== null && m.trim() !== "") { settings.aiModel = m.trim(); saveSettings(); alert("AI 模型已更新！\n當前使用: " + settings.aiModel); }
    }

    function removeAds() {
        const kofiLinks = document.querySelectorAll('a[href*="ko-fi.com"]');
        kofiLinks.forEach(el => el.remove());
    }

    function injectImageControls() {
        removeAds();

        const images = document.querySelectorAll('img.max-w-3xl');
        
        images.forEach(img => {
            if (img.closest('a')) return;
            if (img.closest('.mt-wrapper')) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'mt-wrapper';
            wrapper.style.display = 'flex';
            wrapper.style.justifyContent = 'center';
            wrapper.style.position = 'relative';
            wrapper.style.marginBottom = '20px';
            wrapper.style.width = '100%';
            wrapper.style.alignItems = 'flex-start';

            img.parentNode.insertBefore(wrapper, img);
            wrapper.appendChild(img);

            const btn = document.createElement('button');
            btn.className = 'mt-btn mt-action-btn';
            btn.innerText = '翻譯此頁';
            btn.style.position = 'absolute';
            btn.style.top = '10px';
            btn.style.right = '10px';
            btn.style.zIndex = '50';
            btn.style.padding = '8px 12px';
            btn.style.fontSize = '14px';
            btn.style.fontWeight = 'bold';

            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                processImage(img, wrapper, btn);
            };
            wrapper.appendChild(btn);
        });
    }

    async function translateAll() {
        if (!settings.apiKey) { promptApiKey(); if(!settings.apiKey) return; }
        
        const buttons = Array.from(document.querySelectorAll('.mt-action-btn'));
        const btnAll = document.getElementById('mt-btn-all');
        btnAll.disabled = true;
        btnAll.innerText = "處理中...";

        let count = 0;
        for (const btn of buttons) {
            if (document.body.contains(btn) && btn.innerText === '翻譯此頁' && btn.style.display !== 'none') {
                btn.click();
                count++;
                await new Promise(r => setTimeout(r, 1500));
            }
        }
        btnAll.disabled = false;
        btnAll.innerText = `完成 (${count} 頁)`;
        setTimeout(() => { btnAll.innerText = "一鍵翻譯全部"; }, 3000);
    }

    function getBase64Image(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: function(response) {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(response.response);
                },
                onerror: reject
            });
        });
    }

    async function processImage(img, wrapper, btn) {
        if (!settings.apiKey) { promptApiKey(); if(!settings.apiKey) return; }
        btn.innerText = '讀取...';
        btn.disabled = true;

        try {
            const base64DataUrl = await getBase64Image(img.src);
            const base64Data = base64DataUrl.split(',')[1];
            btn.innerText = 'AI 思考中...';

            // 強化版 Prompt：強制合併對話框句子，並利用全局語境
            const promptText = `
                You are a professional manga translator. Follow these strict steps:
                1. Read and analyze ALL text on the provided manga page to understand the full context, tone, and flow of the conversation.
                2. Extract the Japanese text. IMPORTANT RULE: Group lines of text that belong to the same speech bubble, the same panel, or the same continuous thought into a SINGLE paragraph. Do NOT separate text line-by-line. (e.g., if a bubble has 3 lines of text, output them as one continuous string).
                3. Translate the grouped text into Hong Kong style Traditional Chinese (書面語, written Chinese). Strictly NO spoken Cantonese characters like 嘅, 咁, 咗, 喺.
                4. Ensure the translation makes logical sense based on the context of the entire page conversation.
                5. Output ONLY a raw, valid JSON array of objects. Do not use markdown code blocks.
                Format: [{"ja": "Grouped Japanese text (e.g. full bubble/panel)", "zh": "Natural contextual Chinese translation"}]
            `;

            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': window.location.href,
                    'X-Title': 'Manga Translator Pro'
                },
                data: JSON.stringify({
                    model: settings.aiModel,
                    response_format: { type: "json_object" },
                    messages: [
                        { role: "user", content: [ { type: "text", text: promptText }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Data}` } } ] }
                    ]
                }),
                onload: function(response) {
                    btn.disabled = false;
                    try {
                        if (response.status !== 200) throw new Error("API Status: " + response.status);
                        const resJson = JSON.parse(response.responseText);
                        let content = resJson.choices[0].message.content;
                        content = content.replace(/^```json\n?/g, '').replace(/\n?```$/g, '').trim();
                        renderTranslation(wrapper, JSON.parse(content), btn);
                    } catch (e) {
                        console.error("Error:", e, response.responseText);
                        btn.innerText = '失敗 (點擊重試)';
                        btn.style.background = '#ef4444';
                    }
                },
                onerror: function(err) {
                    console.error("Network Error:", err);
                    btn.innerText = '網絡錯誤 (重試)';
                    btn.disabled = false;
                    btn.style.background = '#ef4444';
                }
            });
        } catch (error) {
            console.error(error);
            btn.innerText = '錯誤 (重試)';
            btn.disabled = false;
        }
    }

    function renderTranslation(wrapper, data, btn) {
        const existingPanel = wrapper.querySelector('.mt-panel');
        if (existingPanel) existingPanel.remove();

        btn.innerText = '↻ 重試';
        btn.className = 'mt-btn mt-btn-retry';
        btn.style.background = '#f59e0b';

        let dataArray = Array.isArray(data) ? data : (data.translations || Object.values(data));
        const panel = document.createElement('div');
        panel.className = 'mt-panel';
        const imgHeight = wrapper.querySelector('img').clientHeight;
        if (imgHeight > 0) panel.style.maxHeight = imgHeight + 'px';

        let htmlContent = '<h3 style="margin-top:0; border-bottom: 2px solid #333; padding-bottom: 5px; font-size:16px;">日中對照</h3>';
        dataArray.forEach(item => {
            if(item.ja && item.zh) {
                htmlContent += `<div class="mt-row"><div class="mt-ja">${item.ja}</div><div class="mt-zh">${item.zh}</div></div>`;
            }
        });
        panel.innerHTML = htmlContent;
        wrapper.insertBefore(panel, wrapper.firstChild);
    }

    // --- 初始化及簡單定時器 (Timer) ---
    updateGlobalStyles();

    function checkUrlState() {
        const isChapterPage = window.location.href.includes('-chapter-') && window.location.href.includes('.html');
        
        if (isChapterPage) {
            createControlPanel();
            document.querySelector('.mt-container').style.display = 'block';
            injectImageControls();
            document.querySelectorAll('.mt-action-btn, .mt-panel').forEach(el => el.style.display = '');
        } else {
            const container = document.querySelector('.mt-container');
            if (container) container.style.display = 'none';
        }
    }

    setInterval(checkUrlState, 1500);
    checkUrlState();

})();
