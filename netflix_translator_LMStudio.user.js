// ==UserScript==
// @name         Netflix AI 字幕 (LM Studio 版)
// @version      5.0.18-LM
// @description  還原 v4.38.0 完整邏輯與 Observer，並強化 Rule 5 嚴禁輸出任何警告、隱私提示或廢話。
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
// @require      https://cdn.jsdelivr.net/npm/@willh/opencc-js@1.2.0/dist/umd/full.min.js
// @require      https://unpkg.com/nzh/dist/nzh.min.js
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = "5.0.18";
    //const HYBRID_MODEL_NAME = "netflix-gemma-hybrid";
    let currentAbortController = null;
    let modelBuildPromise = null;

    const translateToHK = OpenCC.Converter({ from: 'cn', to: 'hk' });

    const nzhhk = Nzh.hk;
    function convertText(input) {
        if (!input) return "";
        return input.replace(/\d+(\.\d+)?/g, (match) => {
            try {
                return `'${nzhhk.encodeS(match)}'`;
            } catch (e) {
                return match;
            }
        });
    }

/**
 * 檢查翻譯後的中文數字與原文日文數字是否一致
 * @param {string} translated - 翻譯後的文本
 * @param {string} text - 日文原文
 * @param {string} sourceLangName - 原文語言名稱
 */
function invalidNumber(translated, text, sourceLangName) {
    if (sourceLangName !== 'Japanese') return [false, ""];

    let originalNumbersSet = new Set();

    // 1. 提取原文中的阿拉伯數字 (支援標準小數點 '.' 以及日文中點 '･', '・' 作為小數點)
    const numRegex = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:[.\uFF65\u30FB]\d+)?/g;
    const originalMatches = text.match(numRegex) || [];
    originalMatches.forEach(num => {
        // 先將逗號移除，再將日文中點轉換為標準小數點，然後再 parseFloat
        originalNumbersSet.add(parseFloat(num.replace(/,/g, '').replace(/[･・]/g, '.')));
    });

    // 2. 處理日文關連單位 (百千万億兆)
    const jpUnitMap = {
        '百': 100,
        '千': 1000,
        '万': 10000,
        '億': 100000000,
        '兆': 1000000000000
    };

    let compounds = [];
    // 同步更新 compoundRegex 支援日文中點小數點
    const compoundRegex = /((?:\d{1,3}(?:,\d{3})+|\d+)(?:[.\uFF65\u30FB]\d+)?)\s*([百千万億兆])/g;
    let cMatch;
    while ((cMatch = compoundRegex.exec(text)) !== null) {
        const num = parseFloat(cMatch[1].replace(/,/g, '').replace(/[･・]/g, '.'));
        const unit = jpUnitMap[cMatch[2]];
        compounds.push({ num, unit, total: num * unit });

        originalNumbersSet.add(unit);
    }

    // 3. 處理獨立的片假名數字
    const kanaNumMap = {
        'ゼロ': 0, 'ワン': 1, 'トゥー': 2, 'ツー' :2, 'スリー': 3, 'フォー': 4,
        'ファイブ': 5, 'シックス': 6, 'セブン': 7, 'エイト': 8, 'ナイン': 9,
        'テン': 10,
        'イレブン': 11, 'トゥエルブ': 12, 'サーティーン': 13, 'フォーティーン': 14,
        'フィフティーン': 15, 'シックスティーン': 16, 'セブンティーン': 17,
        'エィティーン': 18, 'ナインティーン': 19, 'トゥエンティ': 20,
        'セコンド': 2, 'サード': 3, 'フォース': 4
    };

    const jpChars = '\\u3040-\\u309F\\u30A0-\\u30FF';
    const allowedHiragana = 'とはがをにへでやのもかねよならしばすぜぞわくまださて';
    const kanaKeys = Object.keys(kanaNumMap).sort((a, b) => b.length - a.length).join('|');

    const lookbehind = `(?<!(?![${allowedHiragana}])[${jpChars}])`;
    const lookahead = `(?!(?![${allowedHiragana}])[${jpChars}])`;
    const kanaRegex = new RegExp(`${lookbehind}(${kanaKeys})${lookahead}`, 'g');

    const kanaMatches = text.match(kanaRegex) || [];
    kanaMatches.forEach(match => {
        originalNumbersSet.add(kanaNumMap[match]);
    });

    const originalNumbers = [...originalNumbersSet];

    // 4. 處理譯文中的數字
    let translatedNumbersSet = new Set();

    const transArbicMatches = translated.match(numRegex) || [];
    transArbicMatches.forEach(num => {
        translatedNumbersSet.add(parseFloat(num.replace(/,/g, '').replace(/[･・]/g, '.')));
    });

    // B. 處理中文數字常用字排除邏輯
    let exclusions = ["零", "一", "兩", "二", "三", "四", "八", "十", "百", "千", "萬", "點"];

    const hasDigit = (digit) => originalNumbers.some(num => num.toString().includes(digit));

    if (hasDigit('0')) exclusions = exclusions.filter(c => c !== "零");
    if (hasDigit('1')) exclusions = exclusions.filter(c => c !== "一");
    if (hasDigit('2')) exclusions = exclusions.filter(c => c !== "二" && c !== "兩");
    if (hasDigit('3')) exclusions = exclusions.filter(c => c !== "三");
    if (hasDigit('4')) exclusions = exclusions.filter(c => c !== "四");
    if (hasDigit('8')) exclusions = exclusions.filter(c => c !== "八");

    const hasNumGte10 = originalNumbers.some(num => num >= 10);
    if (hasNumGte10) exclusions = exclusions.filter(c => c !== "十");

    if (originalNumbersSet.has(100)) exclusions = exclusions.filter(c => c !== "百");
    if (originalNumbersSet.has(1000)) exclusions = exclusions.filter(c => c !== "千");
    if (originalNumbersSet.has(10000)) exclusions = exclusions.filter(c => c !== "萬");

    // 檢查原文是否包含小數點 (包含標準點及日文中點)
    const hasDecimal = originalMatches.some(match => /[.\uFF65\u30FB]/.test(match));
    if (hasDecimal) exclusions = exclusions.filter(c => c !== "點");

    let processedTranslated = translated;
    if (exclusions.length > 0) {
        const excludeRegex = new RegExp(`[${exclusions.join('')}]`, 'g');
        processedTranslated = processedTranslated.replace(excludeRegex, '');
    }

    // C. 提取譯文中的中文數字並轉換
    const chineseNumPattern = /[零一兩二三四五六七八九十百千萬億點]+/g;
    const chineseMatches = processedTranslated.match(chineseNumPattern) || [];

    chineseMatches.forEach(chineseStr => {
        try {
            const normalizedStr = chineseStr.replace(/兩/g, '二');
            const decodedS = nzhhk.decodeS(normalizedStr);

            if (typeof decodedS === 'number' && !isNaN(decodedS)) {
                translatedNumbersSet.add(decodedS);
            }
        } catch (e) {
            // 轉換失敗跳過
        }
    });

    if (originalNumbersSet.has(1000000000000) && translated.includes('兆')) {
        translatedNumbersSet.add(1000000000000);
    }

    const translatedNumbers = [...translatedNumbersSet];

    if (originalNumbers.length === 0 && translatedNumbers.length === 0) {
        return [false, ""];
    }

    // 5. 雙向對比差異
    let missingInTrans = originalNumbers.filter(num => !translatedNumbers.includes(num));
    let extraInTrans = translatedNumbers.filter(num => !originalNumbers.includes(num));

    // A. 處理乘積合併邏輯
    compounds.forEach(comp => {
        if (extraInTrans.includes(comp.total) &&
            missingInTrans.includes(comp.num) &&
            missingInTrans.includes(comp.unit)) {

            extraInTrans = extraInTrans.filter(x => x !== comp.total);
            missingInTrans = missingInTrans.filter(x => x !== comp.num && x !== comp.unit);
        }
    });

    // B. 處理連字情況 (例如 "二一" 被解析為 21)
    let extraToKeep = [];
    extraInTrans.forEach(extra => {
        const extraStr = extra.toString();
        if (Number.isInteger(extra) && extra >= 10) {
            let canBeSplit = true;
            let digitsToRemove = [];

            for (let char of extraStr) {
                const digit = parseInt(char);
                if (missingInTrans.includes(digit)) {
                    digitsToRemove.push(digit);
                } else {
                    canBeSplit = false;
                    break;
                }
            }

            if (canBeSplit) {
                digitsToRemove.forEach(d => {
                    const mIdx = missingInTrans.indexOf(d);
                    if (mIdx !== -1) missingInTrans.splice(mIdx, 1);
                });
            } else {
                extraToKeep.push(extra);
            }
        } else {
            extraToKeep.push(extra);
        }
    });
    extraInTrans = extraToKeep;

    // 6. 印出結果便於 Debug
    if (originalNumbers.length > 0 || translatedNumbers.length > 0) {
        console.log("originalNumbers: ", originalNumbers, "; translatedNumbers: ", translatedNumbers);
    }

    // 7. 回傳錯誤訊息
    let errorMessages = [];

    if (missingInTrans.length > 0) {
        errorMessages.push(`數字缺失: ${missingInTrans.join(', ')}`);
    }

    if (extraInTrans.length > 0) {
        errorMessages.push(`新增了原句沒有的數字: ${extraInTrans.join(', ')}`);
    }

    if (errorMessages.length > 0) {
        return [true, errorMessages.join('；')];
    }

    return [false, ""];
}


/*    function invalidNumber(translated, text, sourceLangName) {
        if (sourceLangName !== 'Japanese') return [false, ""];

        // 1. 預處理：去除引號、空格、全形空格，確保數字連貫
        let cleanText = text;
        let cleanTranslated = translated;

        // 2. 排除詞：消除非數值的干擾
        const exclusions = [
            "一度", "一貫", "一體", "一体", "一併", "四方", "統一", "万一", "万分", "萬一", "萬分", "一瞬", "三半", "一見鍾情",
            "一流", "一番", "一樣", "一致", "一定", "一路", "一起", "一切", "一般", "一下", "一緒", "下一集", "一髪", "同一","一會",
            "一些", "一堆", "一無", "第一次", "一直", "一輛", "一家", "多", "一堂", "一份", "一點", "同樣", "一目", "三踏板",
            "兩者", "一身", "二度", "一無", "一種", "一斉", "一齊", "一氣", "一気", "一旦", "一角", "一邊", "三明治"
        ];
        const exclusionRegex = new RegExp(exclusions.join('|'), 'g');

        cleanText = cleanText.replace(exclusionRegex, '');
        cleanTranslated = cleanTranslated.replace(exclusionRegex, '');

        // 3. 片假名配置
        const kanaNumMap = {
            'ゼロ': 0, 'ワン': 1, 'トゥー': 2, 'ツー' :2, 'スリー': 3, 'フォー': 4,
            'ファイブ': 5, 'シックス': 6, 'セブン': 7, 'エイト': 8, 'ナイン': 9, 'テン': 10,
            'イレブン': 11, 'トゥエルブ': 12, 'サーティーン': 13, 'フォーティーン': 14,
            'フィフティーン': 15, 'シックスティーン': 16, 'セブンティーン': 17,
            'エィティーン': 18, 'ナインティーン': 19, 'トゥエンティ': 20,
            'セコンド': 2, 'サード': 3, 'フォース': 4
        };
        const kanaRegex = new RegExp(Object.keys(kanaNumMap).join('|'), 'g');

        // 4. 數字解析零件
        const multiplierMap = { '萬': 10000, '万': 10000, '億': 100000000, '亿': 100000000 };
        const baseNumsOnly = "零一二三四五六七八九十百千拾佰仟壹貳參肆伍陸柒捌玖";
        const numRegex = new RegExp(`\\d+(\\.\\d+)?|[${baseNumsOnly}兩]+[點.][${baseNumsOnly}兩]+|[${baseNumsOnly}兩]+`, 'g');

        const extractValues = (str, label) => {
            if (!str) return [];
            let vals = [];

            // --- 處理片假名 ---
            const kanaMatches = [...str.matchAll(new RegExp(Object.keys(kanaNumMap).join('|'), 'g'))];

            kanaMatches.forEach(match => {
                const m = match[0];
                const index = match.index;
                const prevChar = str.charAt(index - 1);
                const nextChar = str.charAt(index + m.length);

                // 判斷前後是否為片假名
                const isPrevKana = /[\u30A0-\u30FF]/.test(prevChar);
                const isNextKana = /[\u30A0-\u30FF]/.test(nextChar);

                let isRealNumber = true;

                // 邏輯：如果前後是片假名，檢查這個「鄰居」是不是也是數字的一部分
                // 如果鄰居只是普通片假名（如「ウエイト」中的「ウ」），則判定為單字，不提取
                if (isPrevKana) {
                    // 往前看一個字，如果不是數字 Map 的結尾，就當它是普通單詞
                    const possibleEnding = str.substring(Math.max(0, index - 4), index);
                    if (!Object.keys(kanaNumMap).some(k => possibleEnding.endsWith(k))) {
                        isRealNumber = false;
                    }
                }

                // 如果前面的檢查過咗，再睇後面
                if (isRealNumber && isNextKana) {
                    // 往後看一個字，如果不是數字 Map 的開始，就當它是普通單詞
                    const possibleStarting = str.substring(index + m.length, index + m.length + 4);
                    if (!Object.keys(kanaNumMap).some(k => possibleStarting.startsWith(k))) {
                        isRealNumber = false;
                    }
                }

                if (isRealNumber) {
                    const num = kanaNumMap[m];
                    if (num !== undefined) vals.push(num);
                }
            });

            // --- 處理中文/阿拉伯數字 ---
            let match;
            numRegex.lastIndex = 0;

            while ((match = numRegex.exec(str)) !== null) {
                let fullMatch = match[0];
                let clean = fullMatch.replace(/兩/g, '二');

                if (clean.length === 1 && "十百千拾佰仟".includes(clean)) continue;

                try {
                    let val;
                    if (/^\d+(\.\d+)?$/.test(clean)) {
                        val = parseFloat(clean);
                    } else if (clean === "百分百") {
                        val = 100;
                    } else {
                        val = nzhhk.decodeS(clean);
                    }

                    if (val !== null && !isNaN(val)) {
                        if (val === 0 && !["零", "0", "ゼロ", "0.0"].includes(clean)) continue;

                        const nextCharIndex = match.index + fullMatch.length;
                        const nextChar = str.charAt(nextCharIndex);

                        if (multiplierMap[nextChar]) {
                            vals.push(val * multiplierMap[nextChar]);
                            numRegex.lastIndex++;
                        } else {
                            if (clean.length > 1 && /^[一二三四五六七八九]+$/.test(clean)) {
                                if (label === "Source") {
                                    const digits = clean.split('').map(d => nzhhk.decodeS(d));
                                    vals.push(...digits);
                                } else {
                                    vals.push(val);
                                    const digits = clean.split('').map(d => nzhhk.decodeS(d));
                                    vals.push(...digits);
                                }
                            } else {
                                vals.push(val);
                            }
                        } // 這裡補上了 multiplierMap 的 else 閉合
                    } // 這裡補上了 val !== null 的閉合
                } catch (e) {}
            }
            const result = [...new Set(vals)].filter(v => typeof v === 'number');
            console.log(`Debug - ${label} Values:`, result);
            return result;
        };

        const originalValues = extractValues(cleanText, "Source");
        const translatedValues = extractValues(cleanTranslated, "Translated");

        // --- 嚴謹比對邏輯 ---

        // 1. Forward Check (原句有，翻譯冇)
        const missingInTrans = originalValues.filter(sv => {
            // 特例：如果 sv 是組合數 (10-99)，且翻譯已經有齊拆散嘅數字，就唔算缺失
            if (sv >= 10 && sv < 100) {
                const digits = sv.toString().split('').map(Number);
                if (digits.every(d => translatedValues.includes(d))) return false;
            }
            return !translatedValues.includes(sv);
        });
        if (originalValues.length > 0 && missingInTrans.length > 0) {
            return [true, `數字缺失: ${missingInTrans.join(', ')}`];
        }

        // 2. Reverse Check (翻譯多咗，原句冇)
        const extraInTrans = translatedValues.filter(tv => {
            // 特例：如果 tv 是組合數 (10-99)，且原句已經有齊拆散嘅數字，就唔算多出
            if (tv >= 10 && tv < 100) {
                const digits = tv.toString().split('').map(Number);
                if (digits.every(d => originalValues.includes(d))) return false;
            }
            return !originalValues.includes(tv);
        });
        if (extraInTrans.length > 0) {
            return [true, `新增了原句沒有的數字: ${extraInTrans.join(', ')}`];
        }

        return [false, ""];
    }
*/


    // --- 核心 API 配置變更 ---
    // LM Studio 預設連接埠為 1234
    const LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

    // 還原 v4.38.0 的完整 db 與防呆邏輯
    let savedUrl = GM_getValue('ai_glossary_url', 'https://github.com/brittenpoon/4n1m3-g4m3r-v0/raw/refs/heads/main/Glossary.json');
    if (savedUrl.includes('your-username/your-repo')) {
        savedUrl = 'https://github.com/brittenpoon/4n1m3-g4m3r-v0/raw/refs/heads/main/Glossary.json';
        GM_setValue('ai_glossary_url', savedUrl);
    }

    const db = {
        get isEnabled() { return GM_getValue('ai_sub_enabled', true); },
        set isEnabled(v) { GM_setValue('ai_sub_enabled', v); },
        get baseModel() { return GM_getValue('ai_model_name', 'translategemma-12b-it-i1'); },
        set baseModel(v) { GM_setValue('ai_model_name', v); },
        get sourceLangName() { return GM_getValue('ai_source_lang_name', 'Japanese'); },
        set sourceLangName(v) { GM_setValue('ai_source_lang_name', v); },
        get sourceLangCode() { return GM_getValue('ai_source_lang_code', 'ja'); },
        set sourceLangCode(v) { GM_setValue('ai_source_lang_code', v); },
        get targetLangName() { return GM_getValue('ai_target_lang_name', 'Chinese (Traditional)'); },
        set targetLangName(v) { GM_setValue('ai_target_lang_name', v); },
        get targetLangCode() { return GM_getValue('ai_target_lang_code', 'zh-Hant'); },
        set targetLangCode(v) { GM_setValue('ai_target_lang_code', v); },
        get glossaryUrl() { return GM_getValue('ai_glossary_url', savedUrl); },
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
    let hasPausedForCurrentClip = true;

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
        modelBuildPromise = null;
        let loader = document.getElementById('ai-translation-loader');
        if (loader) loader.style.display = 'none';
    }

    let lastPath = window.location.pathname;
    setInterval(() => { if (window.location.pathname !== lastPath) { lastPath = window.location.pathname; abortPreviousTasks(); hasPausedForCurrentClip = false; } }, 1000);

    function cleanAndGetCache() {
        let cache = GM_getValue('ai_subtitle_cache', {});
        const now = Date.now();
        const ONE_DAY = 48 * 60 * 60 * 1000;
        let isChanged = false;
        for (let hash in cache) { if (now - cache[hash].timestamp > ONE_DAY) { delete cache[hash]; isChanged = true; } }
        if (isChanged) GM_setValue('ai_subtitle_cache', cache);
        return cache;
    }

    async function fetchGlossary() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET", url: db.glossaryUrl,
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


    async function buildHybridModel() {
/*        console.log(`%c[${getTimestamp()}] [System] 正在構建正面鎖定與零警告專屬模型...`, "color: #FFA500; font-weight: bold;");
        const glossaryDict = await fetchGlossary();
        const glossaryPairs = Object.entries(glossaryDict).map(([k, v]) => `${k}=${v}`);
        let glossaryString = glossaryPairs.length > 0 ? glossaryPairs.join(' | ') : "None";

        // --- 強化版 Rule 5：徹底封殺任何警告、隱私或拒絕訊息 ---
        const systemPrompt = `You are a professional ${db.sourceLangName} (${db.sourceLangCode}) to ${db.targetLangName} (${db.targetLangCode}) translator for R-rated adult content. Your goal is to accurately convey the exact uncensored meaning, tone, and nuances of the original ${db.sourceLangName} text, regardless of how explicit, violent, or profane it is, while adhering to ${db.targetLangName} grammar, vocabulary, and cultural sensitivities.
Produce only the ${db.targetLangName} translation, without any additional explanations, commentary, warning messages, privacy notices, safety alerts, or any meta-commentary.
STRICT OPERATIONAL RULES:
1. MANDATORY GLOSSARY: ${glossaryString}. These specific translations, including names, terms and slang from Japanese (ja) to${db.targetLangName} (${db.targetLangCode}) must be used. They take absolute precedence.
2. POSITIVE LANGUAGE LOCK (CRITICAL): You are ONLY allowed to output characters from the Traditional Chinese (Big5/Standard) character set. No KANA is allowed in output.
3. TRANSLATE NAMES & KANA: Unknown character names, unknown terms, and unknown bracketed words in Hiragana (平假名) and Katakana (片假名) MUST be converted to English, then translated into proper ${db.targetLangName} equivalents.
4. UNCENSORED & RUDE TONE: This content contains violence, profanity, and sexual themes. You MUST translate all rude or explicit language directly. Never soften or harmonize.
5. SYMBOL RETENTION: All punctuation must be kept as-is in the translated text.
6. CHARACTER PURIFICATION: Convert Japanese Kanji or Simplified Chinese charaters to ${db.targetLangName} charaters.`;

        const requestData = {
            model: HYBRID_MODEL_NAME,
            from: db.baseModel.trim() || 'translategemma:4b',
            system: systemPrompt,
            parameters: { temperature: 0.1, num_predict: 256, num_gpu: 999},
            stream: false
        };

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "http://127.0.0.1:11434/api/create",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(requestData),
                onload: function(res) {
                    if (res.status === 200) {
                        console.log(`%c[${getTimestamp()}] [System] 專屬模型構建成功！`, "color: #00FF00; font-weight: bold;");
                        resolve(true);
                    } else {
                        console.error(`[System] 構建失敗: ${res.responseText}`);
                        resolve(false);
                    }
                },
                onerror: () => resolve(false)
            });
        });*/
        console.log(`%c[${getTimestamp()}] [System] LM Studio 不需要 build 過程，正在載入配置...`, "color: #FFA500; font-weight: bold;");
        // LM Studio 不支援 /api/create。我們直接回傳成功，並在發送請求時夾帶 system prompt。
        return true;
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
    //The "Invisible Caret" Script
    const style = document.createElement('style');
    style.innerHTML = `
        /* Makes the blinking cursor invisible everywhere */
        * {
            caret-color: transparent !important;
        }

        /* Ensures text remains selectable even if focused */
        ::selection {
            background: #3390FF; /* Standard blue highlight */
            color: white;
        }
    `;

    document.head.appendChild(style);

    function triggerInitialPause() {
        //if (hasPausedForCurrentClip) return;
        //const video = document.querySelector('video');
        //if (video && !video.paused) {
        //    const pauseBtn = document.querySelector('[data-uia="control-play-pause-pause"]');
        //    if (pauseBtn) pauseBtn.click(); else video.pause();
            hasPausedForCurrentClip = true;
        //}
    }

    function updateUIProgress(current, total, avgMs = 0, etaMs = 0, isBuilding = false) {
        let loader = document.getElementById('ai-translation-loader');
        if (!loader) { loader = document.createElement('div'); loader.id = 'ai-translation-loader'; document.body.appendChild(loader); }
        loader.style.display = 'block';
        if (isBuilding) {
            loader.innerHTML = `
                <div style="font-weight:bold; color:#00BFFF;">🔗 正在連線至 LM Studio 本地伺服器...</div>
                <div style="font-size:13px; color:#aaa; margin-top:8px;">請確保 LM Studio Server 已啟動 (Port 1234)</div>
            `;
            return;
        }
        let statsHtml = avgMs > 0 ? `<div style="font-size:13px; color:#aaa; margin-top:8px; border-top:1px solid #333; padding-top:8px;">平均: ${(avgMs/1000).toFixed(2)}s | 剩餘: ${formatTime(etaMs)}</div>` : '';
        loader.innerHTML = `<div style="font-weight:bold; color:#FFD700;">⏳ AI 模型翻譯中</div><div style="font-size:15px; margin-top:5px;">進度: ${current} / ${total}</div>${statsHtml}`;
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

    const toHalfWidth = (str) => str.replace(/[\uff01-\uff5e]/g, s =>
              String.fromCharCode(s.charCodeAt(0) - 0xfee0)
          ).toLowerCase();

    const toFullWidthUpper = (str) =>
    str.toUpperCase().replace(/[!-~]/g, s =>
        String.fromCharCode(s.charCodeAt(0) + 0xfee0)
    );

    function getCleanSourceText(node, dynamicStyles = [], glossaryDict = {}, terms = []) {
        if (!node) return "";
        const temp = node.cloneNode(true);
        temp.querySelectorAll('rt').forEach(rt => rt.remove());
        if (dynamicStyles.length > 0) {
                const selector = dynamicStyles.map(id => `span[style*="${id}"]`).join(', ');
                try {
                    temp.querySelectorAll(selector).forEach(s => s.remove());
                } catch (e) {
                    console.error("Furigana selector error:", e);
                }
            }
        temp.querySelectorAll('br').forEach(br => {
            br.replaceWith(document.createTextNode(' '));
        });



        let text = temp.textContent || "";
        text = toHalfWidth(text);
        //text = convertText(text);
        text = text.replace(/[\r\n]+/g, ' ').replace(/… /g, "").replace(/[♪〜～～⁓~⸺…]+/g, '').replace(/\s+/g, ' ').trim();
        if (terms.length > 0) {
            terms.forEach(term => {
                const normalisedTerm = term.replace(/ー+$/, '');
                const fuzzyPattern = normalisedTerm.split('').join('ー*') + 'ー*';
                const regex = new RegExp(fuzzyPattern, 'g');
                text = text.replace(regex, glossaryDict[term]);
            });
        }
 return text;
    }

    async function processAndTranslate(rawXml, url) {
        if (window.processedUrls.has(url) || !db.isEnabled) return;
        window.processedUrls.add(url);
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawXml, "text/xml");
        const styleTags = Array.from(doc.querySelectorAll('style'));

        const furiganaIds = styleTags
            .filter(s => s.hasAttribute('tts:rubyPosition') || s.getAttribute('tts:ruby') === 'text')
            .map(s => s.getAttribute('xml:id'))
            .filter(id => id);
        window.currentVideoFuriganaStyles = furiganaIds;
        console.log(`[AI Subtitle] Detected Furigana Styles for this video:`, furiganaIds);

        const glossaryDict = await fetchGlossary();
        console.log(`glossaryDict: `,glossaryDict);
        //const glossaryPairs = Object.entries(glossaryDict).map(([k, v]) => `${k}=${v}`);
        //let glossaryString = glossaryPairs.length > 0 ? glossaryPairs.join(' | ') : "None";
        window.currentGlossary = glossaryDict;
        const terms = Object.keys(glossaryDict).sort((a, b) => b.length - a.length);
        console.log(`terms: `,terms);
        window.currentTerms = terms;

        const pTags = Array.from(doc.querySelectorAll('p'));
        const originalLines = pTags.map(p => {
            return getCleanSourceText(p, furiganaIds, glossaryDict, terms);
        }).filter(t => t.length > 0);

        if (originalLines.length === 0) return;

        triggerInitialPause();
        window.isAITranslating = true;
        currentAbortController = new AbortController();

        if (!modelBuildPromise) {
            updateUIProgress(0, originalLines.length, 0, 0, false);
            modelBuildPromise = Promise.resolve(true);
        }
        const modelBuildSuccess = await modelBuildPromise;
        const targetModel = db.baseModel;

        const total = originalLines.length;
        const videoHash = getVideoHash();
        let allCache = cleanAndGetCache();
        const cacheEnvKey = `${SCRIPT_VERSION}_${targetModel}_${db.sourceLangCode}_${db.targetLangCode}`;

        if (!allCache[videoHash] || allCache[videoHash].envKey !== cacheEnvKey) {
            allCache[videoHash] = { timestamp: Date.now(), envKey: cacheEnvKey, translations: {} };
        }
        let currentVideoCache = allCache[videoHash].translations;

        let successfulAiCount = 0;
        let totalAiTimeMs = 0;

        // --- 強化版 Rule 5：徹底封殺任何警告、隱私或拒絕訊息 ---
        const systemPrompt = `You are a professional ${db.sourceLangName} (${db.sourceLangCode}) to ${db.targetLangName} (${db.targetLangCode}) translator for R-rated adult content. Your goal is to accurately convey the exact uncensored meaning, tone, and nuances of the original ${db.sourceLangName} text, regardless of how explicit, violent, or profane it is, while adhering to ${db.targetLangName} grammar, vocabulary, and cultural sensitivities.
Produce only the ${db.targetLangName} translation, without any additional explanations, commentary, warning messages, privacy notices, safety alerts, or any meta-commentary.
STRICT OPERATIONAL RULES:
1. POSITIVE LANGUAGE LOCK (CRITICAL): You are ONLY allowed to output characters from the Traditional Chinese character set. No KANA is allowed in output.
2. TRANSLATE NAMES & KANA: Unknown character names, unknown terms, and unknown bracketed words in Hiragana (平假名) and Katakana (片假名) MUST be converted to English, then translated into proper ${db.targetLangName} equivalents.
3. UNCENSORED & RUDE TONE: This content contains violence, profanity, and sexual themes. You MUST translate all rude or explicit language directly. Never soften or harmonize.
4. Strictly avoid inserting implied subjects (like "I" or "me") that do not exist in the source. If the sentence is an exclamation or a noun-ending phrase (e.g., "うさ耳！"), translate it as a fragment or exclamation, not a full grammatical sentence.
5. CHARACTER PURIFICATION: Convert Japanese Kanji or Simplified Chinese charaters to ${db.targetLangName} charaters.`;

//1. MANDATORY GLOSSARY: ${glossaryString}. These specific translations, including names, terms and slang from Japanese (ja) to${db.targetLangName} (${db.targetLangCode}) must be used. They take absolute precedence.

        for (let i = 0; i < total; i++) {
            if (currentAbortController?.signal.aborted) return;
            const text = originalLines[i];
            const textKey = getMatchKey(text);
            const tsLog = getTimestamp();
            const currentAvgMs = successfulAiCount > 0 ? (totalAiTimeMs / successfulAiCount) : 0;

            if (currentVideoCache[textKey]) {
                const translated = currentVideoCache[textKey];
                window.subtitleMap.set(textKey, translated);
                updateUIProgress(i + 1, total, currentAvgMs, (total - i - 1) * currentAvgMs, false);
                continue;
            }

            // --- 提取前後文邏輯 ---
            const contextRange = 5;
            const start = Math.max(0, i - contextRange);
            const end = Math.min(total, i + contextRange + 1);
            // 攞前後 5 句，並標記邊句係當前需要翻譯嘅
            const contextLines = originalLines.slice(start, end).map((line, idx) => {
                const relativeIdx = start + idx;
                return relativeIdx === i ? ` | ${line}` : ` | ${line}`;  //`>>> TARGET: ${line} <<<`
            }).join('\n');

            // 嚴格遵守兩行空行
            const userPrompt = `7. Context Reference:${contextLines}. These lines are for reference only (not for translation) to help understand the context; they may not be directly relevant.
Please translate the following ${db.sourceLangName} text into ${db.targetLangName} in one line:\n\n\n${text}`;

            // --- 加入重試機制 ---
            let retryCount = 0;
            const maxRetries = 41;
            let success = false;
            let lastResult = "";

            const checkForeignLanguage = (translated) => {
                const patterns = [
                    { name: "韓文", regex: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/ },
                    { name: "西里爾文", regex: /[\u0400-\u04FF]/ },
                    { name: "阿拉伯文", regex: /[\u0600-\u06FF\u0750-\u077F]/ },
                    { name: "南亞文字", regex: /[\u0900-\u0D7F]/ },
                    { name: "泰文", regex: /[\u0E00-\u0E7F]/ }
                ];
                for (const p of patterns) {
                    if (p.regex.test(translated)) return [true, `偵測到${p.name}`];
                }
                return [false, ""];
            };

            function isAIGeneratedRefusal(text) {
                if (!text || text.length < 10) return [false, ""];
                const refusalKeywords = ["對不起", "翻譯", "日語", "日文", "文字", "對應", "繁體", "當然", "按照", "要求", "完全", "不加", "修飾", "方式", "詞語", "內容", "不適宜", "無法", "包含", "隨時", "內容", "露骨", "提供", "轉述", "指令", "規則", "詢問"];
                let matchCount = refusalKeywords.filter(word => text.includes(word)).length;
                const isRefusal = matchCount >= 3 && text.length > 12;
                return [isRefusal, isRefusal ? `命中 ${matchCount} 個拒絕關鍵字` : ""];
            }

            while (retryCount <= maxRetries && !success) {
                const startTime = Date.now();
                await new Promise((resolve) => {
                    GM_xmlhttpRequest({
                        method: "POST", url: `${LM_STUDIO_BASE_URL}/chat/completions`,
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({
                            model: db.baseModel, // LM Studio 通常會忽略此項並使用當前載入的模型
                            messages: [
                                {
                                    "role": "user",
                                    "content": systemPrompt + userPrompt
                                        }
                            ],
                            temperature: 0.0 + parseFloat(((retryCount % 21) * 0.1 + (Math.floor(retryCount / 21) * 0.01)).toFixed(2)),
                            max_tokens: 1024,
                            stream: false
                        }),
                        onload: function(res) {
                            try {
                                const json = JSON.parse(res.responseText);
                                const rawtranslated = json.choices[0].message.content.trim().replace(/^"|"$/g, '');
                                const translated = translateToHK(rawtranslated);
                                if (translated !== rawtranslated) {
                                    console.log(rawtranslated, ` ➔ translateToHK ➔ `, translated);
                                }
                                lastResult = translated;

                                const hasNewEnglish = (translated, text) => {
                                    const translatedWords = translated.match(/[a-zA-Z\uff21-\uff3a\uff41-\uff5a]{2,}/g) || [];
                                    const normalizedSource = toHalfWidth(text);
                                    const newWords = translatedWords.filter(word => {
                                        const normalizedWord = toHalfWidth(word);
                                        return !normalizedSource.includes(normalizedWord);
                                    });
                                    const hasError = newWords.length > 0;
                                    return [hasError, hasError ? `新增英文: ${newWords.join(', ')}` : ""];
                                };

                                const invalidJapaneseKana = (translated, text) => {
                                    const brackets = /[\(\)\[\]\{\}\uff08\uff09\u3010\u3011\u300c\u300d]/g;
                                    const separators = /[:\uff1a\s]/g;
                                    const kanaPattern = /[\u3040-\u309F\u30A0-\u30FF]/;
                                    const bracketContentRegex = /[\(\uff08\u300c\u3010\[][^\(\)\uff08\uff09\u300c\u300d\u3010\u3011\[\]]+[\)\uff09\u300d\u3011\]]/g;

                                    const sourceMatches = text.match(bracketContentRegex) || [];
                                    let cleanedTranslated = translated;

                                    if (sourceMatches.length > 0) {
                                        const allowedPhrases = sourceMatches.map(m => m.replace(brackets, ''));
                                        allowedPhrases.forEach(phrase => {
                                            cleanedTranslated = cleanedTranslated.split(phrase).join('');
                                        });
                                    }
                                    cleanedTranslated = cleanedTranslated.replace(brackets, '').replace(separators, '');
                                    const hasKana = kanaPattern.test(cleanedTranslated);
                                    return [hasKana, hasKana ? "殘留日文假名" : ""];
                                };

                                const isUnreasonablyLong = (translated, text, sourceLangName) => {
                                    if (sourceLangName !== 'Japanese') return [false, ""];
                                    const sourceLen = text.replace(/\s/g, '').length;
                                    const transLen = translated.replace(/\s/g, '').length;
                                    const MAX_RATIO = 1.55;
                                    const MIN_RATIO = 0.3;

                                    if (sourceLen > 0 && transLen > (sourceLen * MAX_RATIO + 5)) return [true, `比例過長 (${transLen}/${sourceLen})`];
                                    if (sourceLen > 10 && (transLen / sourceLen) < MIN_RATIO) return [true, `比例過短 (${transLen}/${sourceLen})`];
                                    return [false, ""];
                                };

                                const hasInvalidNewlines = (translated) => {
                                    if (!translated.includes('\n')) return [false, ""];
                                    const invalid = (/\n(.|\n)/.test(translated)) || (translated.indexOf('\n') !== translated.length - 1);
                                    return [invalid, invalid ? "包含非法換行" : ""];
                                };

                                //let wrongLanguage = isForeignLanguage || containsSimplified(translated);
                                const errorChecks = [
                                    { id: "AI拒絕回應", run: () => isAIGeneratedRefusal(translated) },
                                    { id: "外語偵測", run: () => checkForeignLanguage(translated) },
                                    { id: "新增英文", run: () => hasNewEnglish(translated, text) },
                                    { id: "日文殘留", run: () => invalidJapaneseKana(translated, text) },
                                    { id: "長度異常", run: () => isUnreasonablyLong(translated, text, db.sourceLangName) },
                                    { id: "換行錯誤", run: () => hasInvalidNewlines(translated) },
                                    { id: "數字錯誤", run: () => invalidNumber(translated, text, db.sourceLangName) }
                                ];

                                let failedReason = "";
                                const hasError = errorChecks.some(item => {
                                    const [isInvalid, reason] = item.run();
                                    if (isInvalid) {
                                        failedReason = `${item.id} (${reason})`;
                                        return true;
                                    }
                                    return false;
                                });

                                if (hasError && retryCount < maxRetries) {
                                    console.warn(`[${getTimestamp()}] 重試原因: [${failedReason}]，正在進行第 ${retryCount + 1}/${maxRetries} 次重試... 內容: ${translated}`);
                                    retryCount++;
                                    resolve();
                                    return;
                                }

                                const duration = Date.now() - startTime;
                                successfulAiCount++;
                                totalAiTimeMs += duration;

                                window.subtitleMap.set(textKey, lastResult);
                                currentVideoCache[textKey] = lastResult;
                                allCache[videoHash].translations = currentVideoCache;
                                GM_setValue('ai_subtitle_cache', allCache);

                                console.log(`[${getTimestamp()}] [${i+1}/${total}] (${(duration/1000).toFixed(2)}s) ${text} ➔ ${lastResult}`);
                                updateUIProgress(i + 1, total, totalAiTimeMs / successfulAiCount, (total - i - 1) * (totalAiTimeMs / successfulAiCount), false);

                                success = true; // 標記成功，跳出 while
                            } catch (e) {
                                console.error("LM Studio 回傳格式錯誤:", e);
                            }
                            resolve();
                        },
                        onerror: () => {
                            retryCount++;
                            resolve();
                        }
                    });
                });
            }
        }
        window.isAITranslating = false;
        currentAbortController = null;
    }

    // --- 還原 v4.38.0 的 Observer，不做任何優化或改動 ---
    const observer = new MutationObserver(() => {
        injectControlMenu();
        if (!db.isEnabled || !window.location.pathname.includes('/watch/')) return;
        document.querySelectorAll('.player-timedtext-text-container').forEach(container => {
            if (container.dataset.aiTranslated === "true") return;
            // --- 關鍵修正：在 Observer 也要過濾注音 ---
            const furiganaIds = window.currentVideoFuriganaStyles || [];
            const glossaryDict = window.currentGlossary || {};
            const terms = window.currentTerms || [];
            const cleanText = getCleanSourceText(container, furiganaIds, glossaryDict, terms);
            const currentMatchKey = getMatchKey(cleanText);
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
                const brPrefix = document.createElement('br');
                brPrefix.className = 'ai-translated-br';
                outerSpan.appendChild(brPrefix);
                let chunkSize = 999; // 預設不分段
                    if (isVertical && translatedText.length > 18) {
                        chunkSize = 18; // 直排每 18 字換列
                    } else if (!isVertical && translatedText.length > 30) {
                        chunkSize = 30; // 橫排每 30 字換行
                    }

                    if (translatedText.length > chunkSize) {
                        for (let i = 0; i < translatedText.length; i += chunkSize) {
                            const chunk = translatedText.substring(i, i + chunkSize);

                            const aiSpan = innerSpan.cloneNode(true);
                            aiSpan.classList.add('ai-translated-span');
                            aiSpan.style.textCombineUpright = "none";
                            aiSpan.style.webkitTextCombine = "none";
                            aiSpan.setAttribute('lang', 'zh');
                            aiSpan.style.fontSize = baseFontSize + "px";
                            aiSpan.innerText = toFullWidthUpper(chunk);
                            outerSpan.appendChild(aiSpan);

                            // 如果還有後續文字，添加換行
                            if (i + chunkSize < translatedText.length) {
                                const brBetween = document.createElement('br');
                                brBetween.className = 'ai-translated-br';
                                outerSpan.appendChild(brBetween);
                            }
                        }
                    } else {
                        // 一般情況
                        const aiSpan = innerSpan.cloneNode(true);
                        aiSpan.classList.add('ai-translated-span');
                        aiSpan.style.textCombineUpright = "none";
                        aiSpan.style.webkitTextCombine = "none";
                        aiSpan.setAttribute('lang', 'zh');
                        aiSpan.style.fontSize = baseFontSize + "px";
                        aiSpan.innerText = toFullWidthUpper(translatedText);
                        outerSpan.appendChild(aiSpan);
                    }

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
                <label>基礎模型: <input type="text" id="ai-model-input" value="${db.baseModel}"></label>
                <label>Glossary JSON: <input type="text" id="ai-glossary-input" value="${db.glossaryUrl}"></label>
                <button id="ai-edit-glossary-btn" style="background:#0078D7; color:white; border:none; padding:6px; border-radius:4px;">📝 編輯名詞庫</button>
                <label>來源: <select id="ai-source-lang-select">${langOptions}</select></label>
                <label>目標: <select id="ai-target-lang-select">${langOptions}</select></label>
                <button id="ai-save-btn" style="background:#E50914; color:white; border:none; padding:10px; border-radius:4px; cursor:pointer;">儲存並刷新</button>
                <button id="ai-clear-cache-btn" style="background:#444; color:#ccc; border:none; padding:8px; border-radius:4px; cursor:pointer;">清除快取</button>
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
            db.baseModel = document.getElementById('ai-model-input').value.trim();
            db.glossaryUrl = document.getElementById('ai-glossary-input').value.trim();
            db.sourceLangCode = document.getElementById('ai-source-lang-select').value;
            db.targetLangCode = document.getElementById('ai-target-lang-select').value;
            location.reload();
        };
        document.getElementById('ai-clear-cache-btn').onclick = () => {
            if (confirm('確定要清除所有影片的翻譯快取嗎？')) {
                GM_setValue('ai_subtitle_cache', {});
                setTimeout(() => location.reload(), 300);
            }
        };
        document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) popup.style.display = 'none'; });
    }
})();
