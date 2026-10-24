// ==UserScript==
// @name         超星学习通自动答题助手
// @namespace    https://tampermonkey.net/
// @version      4.3
// @description  自动识别并回答超星学习通作业题目，提供可拖拽设置面板
// @author       Your Name
// @match        *://*.chaoxing.com/*
// @match        *://*.xuexitong.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      ark.cn-beijing.volces.com
// @connect      api.deepseek.com
// ==/UserScript==
/**
 * v4.0 修复说明（对照真实页面源码 mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork）：
 *
 * 旧版为什么“能运行但填不上去”——四个致命问题：
 *  1) 选项容器选择器全部失效：页面真实容器是 .stem_answer，选项是 div.answerBg；
 *     旧版找的 .anwserList/.answerList/.ques_options/.answer 在页面上出现 0 次，
 *     只有 .workTextWrap 命中，而它是题干和选项共用的类，导致 options 恒为空数组。
 *  2) 选项文本正则写错：/[A‑D]/ 里的“‑”是 U+2011 非断行连字符，不是普通连字符“-”，
 *     永远匹配不到 A/B/C/D → 即使拿到容器也提取不到任何选项。
 *  3) 题型判定因此恒为“单选”，多选题、判断题、填空题全部被当成单选处理。
 *  4) 填空题是 UEditor 富文本（iframe），直接给 textarea.value 赋值不会被页面识别；
 *     简答题同样是 UEditor。
 *
 * 本版做法：不再猜测页面内部状态，而是按页面自己的规则作答：
 *  - 用 span.num_option 的 data 属性拿真实选项值（A/B/C… 或 true/false）；
 *  - 调用页面原生 window.addChoice / window.addMultipleChoice 登记答案，
 *    它们会自行维护 .check_answer 类并写入隐藏域 #answer<qid>；
 *  - 填空题/简答题通过 UE.getEditor(id).setContent() 写入并 sync() 回隐藏域；
 *  - 作答后回读隐藏域校验，确保确实写进去了。
 */
(function () {
    'use strict';

    // ---------- 页面上下文（必须在页面 window 上调用原生函数） ----------
    const page = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    const PROVIDERS = {
        doubao: {
            label: '豆包（火山方舟）',
            url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            defaultModel: 'doubao-seed-2-1-pro-260915',
            models: [
                { id: 'doubao-seed-2-1-pro-260915', name: '豆包 Seed 2.1 Pro' },
                { id: 'doubao-seed-2-1-lite-260915', name: '豆包 Seed 2.1 Lite' },
                { id: 'doubao-seed-2-1-turbo-260628', name: '豆包 Seed 2.1 Turbo' },
                { id: 'doubao-seed-2-1-pro-260628', name: '豆包 Seed 2.1 Pro（260628）' },
                { id: 'doubao-seed-2-0-lite-260428', name: '豆包 Seed 2.0 Lite' },
                { id: 'doubao-seed-2-0-mini-260428', name: '豆包 Seed 2.0 Mini' }
            ]
        },
        deepseek: {
            label: 'DeepSeek 官方 API',
            url: 'https://api.deepseek.com/chat/completions',
            defaultModel: 'deepseek-flash',
            models: [
                { id: 'deepseek-flash', name: 'DeepSeek Flash' },
                { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
            ]
        }
    };

    const CONFIG = {
        PROVIDER: 'doubao',
        API_KEY: '',
        MODEL: PROVIDERS.doubao.defaultModel,
        AUTO_START: false,
        AUTO_SUBMIT: false,
        AUTO_SAVE: false,          // 填完后自动点“保存”；需要防丢答案时可改 true
        TIMEOUT: 40000,
        DELAY_BETWEEN_QUESTIONS: 1200,
        QUESTION_START: 1,
        QUESTION_END: 0,
        QUESTION_ORDER: 'page',
        MAX_RETRIES: 3,
        ENABLE_CACHE: true,
        CACHE_EXPIRY: 24 * 60 * 60 * 1000,
        SCROLL_TO_QUESTION: true,
        VERBOSE: true
    };
    const SETTINGS_KEY = 'cx-auto-settings-v41';
    const PANEL_POSITION_KEY = 'cx-auto-panel-position-v41';
    let dockPosition = null;
    let settingsFormProvider = null;
    const PROVIDER_KEYS = { doubao: '', deepseek: '' };
    const PROVIDER_MODELS = {
        doubao: PROVIDERS.doubao.defaultModel,
        deepseek: PROVIDERS.deepseek.defaultModel
    };

    function loadDockPosition() {
        let saved;
        let checkedScriptStorage = false;
        try {
            if (typeof GM_getValue === 'function') {
                saved = GM_getValue(PANEL_POSITION_KEY, undefined);
                checkedScriptStorage = saved !== undefined;
            }
        } catch (e) {}
        if (!checkedScriptStorage) {
            try { saved = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || 'null'); } catch (e) {}
        }
        if (saved && Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
            dockPosition = { left: Number(saved.left), top: Number(saved.top) };
        }
    }

    function loadSettings() {
        let saved = null;
        try {
            if (typeof GM_getValue === 'function') saved = GM_getValue(SETTINGS_KEY, null);
        } catch (e) {}
        if (!saved) {
            try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) {}
        }
        if (!saved || typeof saved !== 'object') return;

        const inferredProvider = !saved.provider && /^deepseek-/i.test(String(saved.model || '')) ? 'deepseek' : 'doubao';
        const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, saved.provider) ? saved.provider : inferredProvider;
        CONFIG.PROVIDER = provider;
        if (saved.apiKeys && typeof saved.apiKeys === 'object') {
            Object.keys(PROVIDER_KEYS).forEach(name => {
                if (typeof saved.apiKeys[name] === 'string') PROVIDER_KEYS[name] = saved.apiKeys[name];
            });
        }
        if (typeof saved.apiKey === 'string' && !PROVIDER_KEYS[provider]) PROVIDER_KEYS[provider] = saved.apiKey;
        if (saved.models && typeof saved.models === 'object') {
            Object.keys(PROVIDER_MODELS).forEach(name => {
                if (typeof saved.models[name] === 'string' && saved.models[name].trim()) {
                    PROVIDER_MODELS[name] = saved.models[name].trim();
                }
            });
        }
        // 迁移旧版内置的失效接入点占位值到官方模型 ID；用户自定义的 ep-* 接入点仍保留。
        if (typeof saved.model === 'string' && saved.model.trim() &&
            (!saved.models || !saved.models[provider])) PROVIDER_MODELS[provider] = saved.model.trim();
        if (PROVIDER_MODELS.doubao === 'ep-m-20261015153336-4cccp') {
            PROVIDER_MODELS.doubao = PROVIDERS.doubao.defaultModel;
        }
        CONFIG.API_KEY = PROVIDER_KEYS[provider];
        CONFIG.MODEL = PROVIDER_MODELS[provider];
        if (Number.isFinite(Number(saved.delay)) && Number(saved.delay) >= 0) {
            CONFIG.DELAY_BETWEEN_QUESTIONS = Math.min(5000, Number(saved.delay));
        }
        if (Number.isFinite(Number(saved.start)) && Number(saved.start) >= 1) {
            CONFIG.QUESTION_START = Math.floor(Number(saved.start));
        }
        if (Number.isFinite(Number(saved.end)) && Number(saved.end) >= 0) {
            CONFIG.QUESTION_END = Math.floor(Number(saved.end));
        }
        if (['page', 'reverse', 'random'].includes(saved.order)) CONFIG.QUESTION_ORDER = saved.order;
    }
    loadSettings();
    loadDockPosition();

    // 学习通题型编码（#answertype<qid> / input[name="type<qid>"]）
    const TYPE = { SINGLE: 0, MULTI: 1, FILL: 2, JUDGE: 3, SHORT: 4 };
    const TYPE_NAME = { 0: '单选题', 1: '多选题', 2: '填空题', 3: '判断题', 4: '简答题' };
    const RAW_MULTI_TYPES = new Set([1, 21]);
    const RAW_FILL_TYPES = new Set([2, 9, 10]);
    const RAW_JUDGE_TYPES = new Set([3]);
    // 4/5/6/7/8/18 都是主观题：材料题(4)、论述题(6)、名词解释等
    const RAW_SHORT_TYPES = new Set([4, 5, 6, 7, 8, 18]);

    function typeFromRawCode(value) {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const code = parseInt(value, 10);
        if (isNaN(code)) return null;
        if (code === 0) return TYPE.SINGLE;
        if (RAW_MULTI_TYPES.has(code)) return TYPE.MULTI;
        if (RAW_FILL_TYPES.has(code)) return TYPE.FILL;
        if (RAW_JUDGE_TYPES.has(code)) return TYPE.JUDGE;
        if (RAW_SHORT_TYPES.has(code)) return TYPE.SHORT;
        return null;
    }

    function typeFromName(name) {
        const text = String(name || '');
        if (!text) return null;
        if (/多选|不定项/.test(text)) return TYPE.MULTI;
        if (/判断/.test(text)) return TYPE.JUDGE;
        if (/填空/.test(text)) return TYPE.FILL;
        if (/简答|论述|材料|名词解释|计算题|分析题|综合题|解答题/.test(text)) return TYPE.SHORT;
        if (/单选/.test(text)) return TYPE.SINGLE;
        return null;
    }

    // ---------- 样式 ----------
    GM_addStyle(`
        #cx-auto-dock{position:fixed;top:18px;right:18px;z-index:2147483000;display:flex;flex-direction:column;
            align-items:flex-end;gap:8px;width:max-content;max-width:calc(100vw - 24px)}
        #cx-auto-dock.cx-dragging{user-select:none}
        #cx-auto-dock.cx-dragging #cx-auto-btn,#cx-auto-dock.cx-dragging #cx-auto-settings-btn{cursor:grabbing}
        #cx-auto-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;max-width:100%;touch-action:none}
        #cx-auto-btn,#cx-auto-settings-btn{position:static;box-sizing:border-box;min-height:38px;padding:8px 13px;
            border:1px solid transparent;border-radius:8px;cursor:grab;touch-action:none;user-select:none;
            font-size:13px;font-weight:600;line-height:1.25;white-space:nowrap;
            font-family:'Microsoft YaHei',system-ui,sans-serif;transition:.2s}
        #cx-auto-btn{background:#1a73e8;color:#fff;box-shadow:0 4px 14px rgba(26,115,232,.4)}
        #cx-auto-btn:hover:not(:disabled){background:#1557b0;transform:translateY(-1px)}
        #cx-auto-btn:disabled{background:#9aa0a6;cursor:not-allowed;transform:none}
        #cx-auto-btn.cx-stop{background:#d93025;box-shadow:0 4px 14px rgba(217,48,37,.4)}
        #cx-auto-settings-btn{background:#303134;color:#e8eaed;border-color:#5f6368;box-shadow:0 3px 10px rgba(0,0,0,.3)}
        #cx-auto-settings-btn:hover{background:#3c4043;transform:translateY(-1px)}
        #cx-auto-btn:focus-visible,#cx-auto-settings-btn:focus-visible,#cx-auto-panel button:focus-visible,
        #cx-auto-panel input:focus-visible,#cx-auto-panel select:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}
        #cx-auto-panel{position:static;width:min(430px,calc(100vw - 24px));max-height:72vh;
            display:flex;flex-direction:column;background:#202124;color:#e8eaed;border-radius:10px;
            box-shadow:0 8px 30px rgba(0,0,0,.55);overflow:hidden;
            font-family:'Microsoft YaHei',system-ui,sans-serif;font-size:12.5px}
        #cx-auto-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
            background:#2d2e31;border-bottom:1px solid #3c4043;font-weight:700;color:#8ab4f8;flex:0 0 auto;
            cursor:move;touch-action:none;user-select:none}
        #cx-auto-panel .head-actions{display:flex;align-items:center;gap:10px;cursor:default;touch-action:auto}
        #cx-auto-panel [data-role="title"]:focus-visible{outline:2px solid #8ab4f8;outline-offset:3px;border-radius:2px}
        #cx-auto-panel .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
            clip:rect(0,0,0,0);white-space:nowrap;border:0}
        #cx-auto-panel .hd button{background:none;border:0;color:#9aa0a6;font:inherit;font-size:12px;cursor:pointer;padding:2px 4px}
        #cx-auto-panel .hd button:hover{color:#fff}
        #cx-auto-panel .hd .mini:hover{color:#fff}
        #cx-auto-panel .prog{height:3px;background:#3c4043;flex:0 0 auto}
        #cx-auto-panel .prog i{display:block;height:100%;width:0;background:#34a853;transition:width .25s}
        #cx-auto-panel .bd{padding:8px 10px;overflow-y:auto;flex:1 1 auto}
        #cx-auto-panel .settings{padding:14px;overflow-y:auto;flex:1 1 auto}
        #cx-auto-panel .field{display:flex;flex-direction:column;gap:5px;margin:0 0 13px}
        #cx-auto-panel .field label,#cx-auto-panel legend{color:#e8eaed;font-weight:600}
        #cx-auto-panel .field small,#cx-auto-panel .hint{color:#9aa0a6;font-size:11px;line-height:1.5}
        #cx-auto-panel .field input[type="text"],#cx-auto-panel .field input[type="password"],
        #cx-auto-panel .field input[type="number"],#cx-auto-panel .field select{box-sizing:border-box;width:100%;min-height:34px;
            border:1px solid #5f6368;border-radius:5px;padding:6px 8px;background:#303134;color:#e8eaed;font:inherit}
        #cx-auto-panel .field input[type="range"]{width:100%;accent-color:#8ab4f8}
        #cx-auto-panel .key-line{display:flex;gap:6px}
        #cx-auto-panel .key-line input{flex:1;min-width:0}
        #cx-auto-panel .key-line button,#cx-auto-panel .save-settings{border:0;border-radius:5px;padding:7px 11px;
            background:#1a73e8;color:#fff;font:inherit;font-weight:600;cursor:pointer}
        #cx-auto-panel .key-line button{background:#3c4043}
        #cx-auto-panel .settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        #cx-auto-panel .test-connection{border:1px solid #5f6368;border-radius:5px;padding:7px 11px;
            background:#3c4043;color:#e8eaed;font:inherit;font-weight:600;cursor:pointer}
        #cx-auto-panel .test-connection:disabled{opacity:.6;cursor:wait}
        #cx-auto-panel .save-settings:hover,#cx-auto-panel .test-connection:hover:not(:disabled){filter:brightness(1.12)}
        #cx-auto-panel .settings-status{display:block;flex-basis:100%;margin:2px 0 0;line-height:1.5;overflow-wrap:anywhere}
        #cx-auto-panel .range-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        #cx-auto-panel .settings-status{min-height:1.5em;margin-left:9px;color:#81c995}
        #cx-auto-panel .settings-status.error{color:#f28b82}
        #cx-auto-panel .row{margin:5px 0;padding:5px 8px;border-radius:5px;background:rgba(255,255,255,.045);
            line-height:1.55;word-break:break-word}
        #cx-auto-panel .row .t{color:#9aa0a6;margin-right:6px;font-variant-numeric:tabular-nums}
        #cx-auto-panel .ok{color:#81c995;background:rgba(52,168,83,.13)}
        #cx-auto-panel .err{color:#f28b82;background:rgba(217,48,37,.13)}
        #cx-auto-panel .q{color:#fdd663;background:rgba(253,214,99,.1);font-weight:600}
        #cx-auto-panel .ai{color:#c58af9;background:rgba(197,138,249,.12)}
        #cx-auto-panel .warn{color:#fbbc04;background:rgba(251,188,4,.12)}
        #cx-auto-panel .hit{color:#78d9ec;background:rgba(120,217,236,.12)}
        #cx-auto-panel .step{color:#8ab4f8}
        #cx-auto-panel .bd::-webkit-scrollbar{width:8px}
        #cx-auto-panel .bd::-webkit-scrollbar-thumb{background:#5f6368;border-radius:4px}
        #cx-auto-panel.collapsed .bd,#cx-auto-panel.collapsed .settings,#cx-auto-panel.collapsed .prog{display:none}
        .cx-auto-flash{outline:3px solid #1a73e8 !important;outline-offset:2px;transition:outline .3s}
        .cx-auto-filled{background:rgba(52,168,83,.08) !important;border-radius:6px}
        .cx-auto-failed{background:rgba(217,48,37,.08) !important;border-radius:6px}
    `);

    // ---------- 全局状态 ----------
    let running = false;
    let stopRequested = false;
    let dock = null, panel = null, body = null, bar = null;
    const answerCache = new Map();

    // =========================================================
    //  一、页面结构识别（依据真实源码）
    // =========================================================

    /** 收集所有题目容器，只取最内层，避免嵌套重复 */
    function collectQuestions() {
        const found = new Set();
        const push = (el) => { if (el && !found.has(el)) found.add(el); };
        document.querySelectorAll('.questionLi').forEach(push);
        // 兜底：其它版本学习通/考试页面的容器
        document.querySelectorAll('[typeName], .TiMu, .singleQuesId').forEach(el => {
            if (el.classList.contains('questionLi') || el.hasAttribute('typeName')) push(el);
        });
        let list = [...found];
        // 去掉包含其它候选项的外层容器
        list = list.filter(el => !list.some(o => o !== el && el.contains(o)));
        // 必须含有可作答内容才保留
        return list.filter(el =>
            el.querySelector('.stem_answer, .answerBg, .num_option, .num_option_dx, input[type="radio"], input[type="checkbox"], textarea')
        );
    }

    /** 取题目唯一 id */
    function qidOf(el) {
        const raw = el.getAttribute('data') || (el.id || '').replace(/^question|^sigleQuestionDiv_/, '') || '';
        if (raw) return raw;
        const opt = el.querySelector('.answerBg[qid], .saveSingleSelect[qid], .saveMultiSelect[qid]');
        if (opt) return opt.getAttribute('qid');
        const input = el.querySelector('input[name="questionId"]');
        return input ? String(input.value || '').trim() : '';
    }

    /** 读取页面隐藏的题型信息（不同版本分别放在 type<qid> / answertype<qid> / typeName<qid>） */
    function readQuestionTypeInfo(el) {
        const qid = qidOf(el);
        let rawCode = '';
        const codeInput = qid ? el.querySelector(`input[name="type${qid}"]`) : null;
        if (codeInput && String(codeInput.value || '').trim() !== '') rawCode = codeInput.value;
        if (!rawCode && qid) {
            const legacy = document.getElementById('answertype' + qid);
            if (legacy && String(legacy.value || '').trim() !== '') rawCode = legacy.value;
        }

        let name = '';
        const nameInput = qid ? el.querySelector(`input[name="typeName${qid}"]`) : null;
        if (nameInput) name = String(nameInput.value || '').trim();
        if (!name) name = String(el.getAttribute('typeName') || '').trim();
        if (!name) {
            // 题型标签通常是 .colorShallow 的 aria-label，例如“26. (材料题, 15.0分)”
            const label = el.querySelector('.colorShallow, .mark_name [aria-label]');
            if (label) {
                const aria = label.getAttribute('aria-label') || label.textContent || '';
                const match = String(aria).match(/(单选题|多选题|不定项选择题|判断题|填空题|简答题|论述题|材料题|名词解释)/);
                if (match) name = match[1];
            }
        }
        if (!name) {
            // 大题标题：三、 材料题 （共 2题，30.0 分）
            const section = el.closest('.mark_table');
            const title = section && section.querySelector('.type_tit');
            if (title) {
                const match = String(title.textContent || '').match(/(单选题|多选题|不定项选择题|判断题|填空题|简答题|论述题|材料题|名词解释)/);
                if (match) name = match[1];
            }
        }
        return { qid, rawCode, name };
    }

    /** 题干文本：只取 .mark_name / h3，剔除选项区与题号 */
    function getStemText(el) {
        // 题干节点绝不能命中选项（.answerBg / .answer_p / .num_option 都带 workTextWrap）
        const cand = el.querySelector('h3.mark_name, .mark_name, .Zy_TItle, .ques_title, .question-title, .stem, .topic, .questionText')
            || el.querySelector('h3');
        let text = '';
        if (cand) {
            const clone = cand.cloneNode(true);
            clone.querySelectorAll('.answerBg, .answer_p, .num_option, .num_option_dx, .stem_answer, .colorShallow, .ques_count, .mark_letter, script, style').forEach(n => n.remove());
            text = (clone.textContent || '').trim();
        }
        if (!text) {
            // 没有题干节点时：从整个容器文本里切掉第一个选项之前的部分
            const first = el.querySelector('.answerBg, .num_option');
            if (first) {
                const r = document.createRange();
                r.setStartBefore(el);
                r.setEndBefore(first);
                text = r.toString().trim();
            } else {
                text = (el.textContent || '').trim();
            }
        }
        // 清理题号、题型标注、分数、空白
        text = text
            .replace(/^[\s\u3000]*\d+\s*[.、,．)）]\s*/, '')
            .replace(/[（(]\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|材料题|综合题|分析题|计算题|解答题|不定项选择题)\s*[)）]/g, '')
            .replace(/[（(]\s*\d+(\.\d+)?\s*分\s*[)）]/g, '')
            .replace(/[\s\u3000]+/g, ' ')
            .trim();
        return text;
    }

    /**
     * 提取选项 —— 核心修复点
     * 真实结构：div.answerBg[qid][qtype] > span.num_option[data] + div.answer_p > p
     * data 才是页面认可的答案值（单选 "A"、判断 "true"/"false"）。
     */
    function getOptions(el) {
        let nodes = [...el.querySelectorAll('.answerBg[qid]')];
        if (!nodes.length) nodes = [...el.querySelectorAll('.stem_answer .answerBg, .answerBg')];
        if (!nodes.length) {
            // 极少数版本使用 li / label + radio|checkbox
            nodes = [...el.querySelectorAll('li, label')].filter(n =>
                /choice|option|answer/i.test(n.className || '') &&
                n.querySelector('input[type="radio"], input[type="checkbox"], .num_option, .num_option_dx'));
        }
        const opts = [];
        for (const node of nodes) {
            const letterEl = node.querySelector('.num_option, .num_option_dx, .choice_letter, span[data]');
            const textEl = node.querySelector('.answer_p, p, .option_text, label');
            // 页面显示的字母和 data 中的作答值不是一回事（判断题 data 常为 true/false）。
            const data = letterEl ? (letterEl.getAttribute('data') || '').trim() : '';
            const letterText = letterEl ? (letterEl.textContent || '').trim() : '';
            const ariaLabel = (node.getAttribute('aria-label') || '').trim();
            const pageLetter = readDisplayedOptionLetter(letterText)
                || readDisplayedOptionLetter(ariaLabel)
                || readDisplayedOptionLetter(node.textContent || '');
            // 选项正文
            let text = textEl ? (textEl.textContent || '').trim() : '';
            if (!text) {
                // 兜底：整块文本去掉开头的字母
                text = (node.textContent || '').trim().replace(/^[A-Z]\s*[.、．]?\s*/, '');
            }
            text = text.replace(/\s+/g, ' ').trim();
            if (!pageLetter && !text) continue;
            opts.push({ letter: pageLetter, pageLetter, text, data, node, hidden: !isVisible(node) });
        }
        return opts;
    }

    /** 读取页面明确显示的单个选项字母；aria-label 可能是“A对选择”这类无空格形式。 */
    function readDisplayedOptionLetter(value) {
        const text = String(value || '').trim();
        const match = text.match(/^([A-Z])(?=$|[^A-Za-z0-9])/i);
        return match ? match[1].toUpperCase() : '';
    }

    /** 页面标签完整且唯一时沿用原字母；否则按可见选项的屏幕位置生成 A/B/C… */
    function prepareAnswerOptions(options) {
        const visible = options.filter(option => !option.hidden);
        const candidates = visible.length ? visible : options;
        const pageLetters = candidates.map(option => String(option.pageLetter || '').trim().toUpperCase());
        const hasUniquePageLetters = pageLetters.length > 0
            && pageLetters.every(letter => /^[A-Z]$/.test(letter))
            && new Set(pageLetters).size === pageLetters.length;

        if (hasUniquePageLetters) {
            return candidates.map((option, index) => ({
                ...option,
                answerLetter: pageLetters[index]
            }));
        }

        const visualOrder = sortOptionsByDisplayOrder(candidates);
        return visualOrder.map((option, index) => ({
            ...option,
            answerLetter: optionLetterFromIndex(index)
        }));
    }

    /** 按屏幕上的行列位置排序，并让同一行内的选项按从左到右排列。 */
    function sortOptionsByDisplayOrder(options) {
        const positioned = options.map((option, index) => {
            const rect = option.node && option.node.getBoundingClientRect
                ? option.node.getBoundingClientRect()
                : null;
            return { option, index, top: rect ? rect.top : NaN, left: rect ? rect.left : NaN };
        });
        const measuredCount = positioned.filter(item => Number.isFinite(item.top) && Number.isFinite(item.left)).length;
        if (measuredCount < 2 || measuredCount !== options.length) {
            return options;
        }

        const measured = positioned
            .filter(item => Number.isFinite(item.top) && Number.isFinite(item.left))
            .sort((a, b) => a.top - b.top || a.index - b.index);
        const rows = [];
        for (const item of measured) {
            // 同一视觉行的 top 可能因字体或对齐方式相差几像素，按最近行归组。
            let row = null;
            let distance = Infinity;
            for (const candidate of rows) {
                const d = Math.abs(candidate.top - item.top);
                if (d <= 4 && d < distance) {
                    row = candidate;
                    distance = d;
                }
            }
            if (!row) {
                row = { top: item.top, items: [] };
                rows.push(row);
            }
            row.items.push(item);
        }
        rows.sort((a, b) => a.top - b.top);
        return rows.flatMap(row => row.items
            .sort((a, b) => a.left - b.left || a.index - b.index)
            .map(item => item.option));
    }

    function optionLetterFromIndex(index) {
        let value = index + 1;
        let label = '';
        while (value > 0) {
            value--;
            label = String.fromCharCode(65 + (value % 26)) + label;
            value = Math.floor(value / 26);
        }
        return label;
    }

    function answerLetterForOption(option) {
        return String(option && (option.answerLetter || option.letter) || '').trim().toUpperCase();
    }

    /** 题型：优先读页面隐藏域（type<qid> / answertype<qid>），再读题型名称，最后才看 DOM */
    function getQuestionType(el) {
        const info = readQuestionTypeInfo(el);
        const fromCode = typeFromRawCode(info.rawCode);
        if (fromCode !== null) return fromCode;
        const fromName = typeFromName(info.name);
        if (fromName !== null) return fromName;
        if (el.querySelector('.num_option_dx, input[type="checkbox"], .saveMultiSelect')) return TYPE.MULTI;
        if (el.querySelector('.num_option, input[type="radio"], .saveSingleSelect')) return TYPE.SINGLE;
        // 主观题（含材料/论述）是单个 textarea[name="answer<qid>"]；填空题是 answerEditor<qid><n>
        if (info.qid && el.querySelector(`textarea[name="answer${info.qid}"], textarea[id="answer${info.qid}"]`)) return TYPE.SHORT;
        if (el.querySelector('textarea, .textDIV')) return TYPE.FILL;
        return TYPE.SINGLE;
    }

    /** 展示用题型名称：材料题、论述题等原样保留，便于日志与提示词区分 */
    function getQuestionTypeName(el) {
        const info = readQuestionTypeInfo(el);
        if (info.name) return info.name;
        return TYPE_NAME[getQuestionType(el)] || '单选题';
    }

    /** 该题在页面上登记的答案（多选 id 仍是 answer<qid>，name 是 answers<qid>） */
    function hiddenAnswer(el) {
        const qid = qidOf(el);
        if (!qid) return null;
        return document.getElementById('answer' + qid)
            || document.querySelector(`input[name="answers${qid}"]`);
    }

    function meaningfulAnswer(value) {
        return String(value == null ? '' : value)
            .replace(/<br\s*\/?\s*>/gi, '')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;|&#160;|&#x0*a0;/gi, '')
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .trim().length > 0;
    }

    function readEditorAnswer(editorId, textarea) {
        const editor = getEditor(editorId, textarea);
        if (editor) {
            try {
                const text = typeof editor.getContentTxt === 'function' ? editor.getContentTxt() : editor.getContent();
                if (meaningfulAnswer(text)) return text;
            } catch (e) {}
        }
        if (textarea && meaningfulAnswer(textarea.value)) return textarea.value;
        if (textarea) {
            const holder = textarea.closest('.edui-default, .edui-editor, .edui-container');
            const editable = holder && holder.querySelector('[contenteditable="true"], iframe');
            try {
                const text = editable && editable.tagName === 'IFRAME'
                    ? editable.contentDocument && editable.contentDocument.body && editable.contentDocument.body.innerText
                    : editable && editable.innerText;
                if (meaningfulAnswer(text)) return text;
            } catch (e) {}
        }
        return '';
    }

    /** 空数：填空/简答各几个输入位 */
    function blankCount(el) {
        const qid = qidOf(el);
        const sizeInput = qid ? document.querySelector(`input[name="tiankongsize${qid}"]`) : null;
        const n = sizeInput ? parseInt(sizeInput.value, 10) : 0;
        if (n > 0) return n;
        const editors = el.querySelectorAll('.textDIV textarea, .Answer textarea, textarea');
        return Math.max(editors.length, 1);
    }

    function isVisible(el) {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    // =========================================================
    //  二、作答写入（驱动页面原生逻辑）
    // =========================================================

    function choiceClass(multi) {
        return multi ? 'check_answer_dx' : 'check_answer';
    }

    /** 选项真正保存选中状态的元素：真页面在 span.num_option(_dx)，部分旧版在 .answerBg 上 */
    function optionFlag(node, multi) {
        if (!node) return null;
        return node.querySelector(multi ? '.num_option_dx, .saveMultiSelect' : '.num_option, .saveSingleSelect')
            || node.querySelector('.num_option_dx, .num_option')
            || node;
    }

    function isOptionMarked(node, multi) {
        const cls = choiceClass(multi);
        const flag = optionFlag(node, multi);
        return !!((flag && flag.classList.contains(cls)) || (node && node.classList.contains(cls)));
    }

    /**
     * 页面原生函数需要的元素必须带 qid：
     * 真考试页把 qid 放在 span.saveSingleSelect 上，.answerBg 本身没有 qid；
     * 旧版作业页则直接放在 .answerBg 上。传错元素会让页面写到 #answerundefined。
     */
    function optionActionElement(node, multi) {
        if (!node) return null;
        if (node.getAttribute && node.getAttribute('qid')) return node;
        const selector = multi ? '.saveMultiSelect[qid], .num_option_dx[qid], [qid]' : '.saveSingleSelect[qid], .num_option[qid], [qid]';
        return node.querySelector(selector) || node;
    }

    /** 按页面自己的规则重算隐藏域，保证“已选中”和“已绑定”一致 */
    function syncChoiceHidden(el, multi) {
        const qid = qidOf(el);
        if (!qid) return '';
        const cls = choiceClass(multi);
        const content = [...el.querySelectorAll('.choice' + qid)]
            .filter(s => s.classList.contains(cls))
            .map(s => s.getAttribute('data') || '')
            .join('');
        const box = document.getElementById('answer' + qid)
            || document.querySelector(`input[name="answers${qid}"]`);
        if (box) box.value = content;
        const sheet = document.getElementById('answerSheet' + qid);
        if (sheet) content.length ? sheet.classList.add('active') : sheet.classList.remove('active');
        return content;
    }

    function notifyAnswerContentChange() {
        try {
            const cb = page.answerContentChange || window.answerContentChange;
            if (typeof cb === 'function') cb();
        } catch (e) {}
    }

    /** 调用页面自己的保存流程：sync 富文本 → 暂存到服务端，避免只改前端状态 */
    function requestQuestionSave(el) {
        const qid = qidOf(el);
        if (!qid) return false;
        try {
            if (typeof page.saveQuestion === 'function') { page.saveQuestion(qid, qid); return true; }
            if (typeof page.submitForm === 'function' && page.$) {
                page.submitForm(true, page.$('#sigleQuestionDiv_' + qid));
                return true;
            }
        } catch (e) { log('触发页面保存失败: ' + e.message, 'warn'); }
        return false;
    }

    /**
     * 让选项进入页面认可且已绑定的状态。
     * 返回 { ok, clicked }：clicked=true 表示已走页面点击流程（页面会自行暂存）。
     */
    function selectOption(opt, multi, el) {
        const node = opt && opt.node;
        if (!node) return { ok: false, clicked: false };
        const cls = choiceClass(multi);

        // 0) 已经选中过：不要再点，点击会把答案取消
        if (isOptionMarked(node, multi)) return { ok: true, clicked: false };

        // 1) 首选：触发页面自己的点击处理（saveSingleSelect / clickSaveMultiSelect → addChoice → submitForm）
        if (typeof node.click === 'function') {
            try {
                node.click();
                if (isOptionMarked(node, multi)) {
                    // 页面可能只改了样式却没写隐藏域，这种情况交给调用方补同步与暂存
                    const box = hiddenAnswer(el);
                    const bound = !box || String(box.value || '').trim().length > 0;
                    return { ok: true, clicked: bound };
                }
            } catch (e) { log('选项点击失败: ' + e.message, 'warn'); }
        }

        // 2) 原生函数兜底：必须传入带 qid 的元素
        const actionEl = optionActionElement(node, multi);
        const qid = actionEl && actionEl.getAttribute ? actionEl.getAttribute('qid') : qidOf(el);
        const fnName = multi ? 'addMultipleChoice' : 'addChoice';
        let nativeCalled = false;
        const fn = page[fnName] || window[fnName];
        if (typeof fn === 'function' && actionEl) {
            try { fn.call(page, actionEl); nativeCalled = true; } catch (e) { log('原生 ' + fnName + ' 调用异常: ' + e.message, 'warn'); }
        }
        if (nativeCalled && isOptionMarked(node, multi)) return { ok: true, clicked: false };

        // 3) 最后兜底：按页面规则手工维护类名与隐藏域
        if (qid) {
            if (!multi) {
                el.querySelectorAll('.choice' + qid).forEach(s => s.classList.remove(cls));
            }
            const flag = optionFlag(node, multi);
            if (flag) flag.classList.add(cls);
            if (!node.classList.contains(cls)) node.classList.add(cls);
            node.setAttribute('aria-checked', 'true');
            syncChoiceHidden(el, multi);
            notifyAnswerContentChange();
        }
        return { ok: isOptionMarked(node, multi), clicked: false };
    }

    function clearQuestion(el, multi) {
        const qid = qidOf(el);
        if (!qid) return;
        const cls = choiceClass(multi);
        el.querySelectorAll('.choice' + qid).forEach(s => s.classList.remove(cls));
        el.querySelectorAll('.answerBg.' + cls).forEach(s => {
            s.classList.remove(cls);
            s.setAttribute('aria-checked', 'false');
        });
        syncChoiceHidden(el, multi);
    }

    /** UEditor 实例解析：先按约定 id，再从 textarea 反查 */
    function getEditor(editorId, textarea) {
        const UE = page.UE || window.UE;
        if (UE && typeof UE.getEditor === 'function') {
            if (editorId) {
                try { const ed = UE.getEditor(editorId); if (ed && typeof ed.setContent === 'function') return ed; } catch (e) {}
            }
            if (typeof UE.instants === 'object' && UE.instants) {
                for (const key in UE.instants) {
                    const ed = UE.instants[key];
                    try {
                        if (ed && ed.textarea && textarea && ed.textarea[0] === textarea) return ed;
                        if (ed && ed.container && textarea && ed.container[0] && ed.container[0].contains(textarea)) return ed;
                    } catch (e) {}
                }
            }
            if (textarea && textarea.id) {
                try { const ed = UE.getEditor(textarea.id); if (ed && typeof ed.setContent === 'function') return ed; } catch (e) {}
            }
        }
        return null;
    }

    /** 写入一个富文本答案位，返回是否成功 */
    function writeEditor(editorId, textarea, value) {
        // 主观题答案常含换行，UEditor 里需要转成 <br> 才会保留段落
        const html = escapeHtml(value).replace(/\r?\n/g, '<br>');
        const ed = getEditor(editorId, textarea);
        if (ed) {
            try {
                ed.setContent(html);
                if (typeof ed.sync === 'function') ed.sync();
                // 关键：本地 setContent 不会触发 UEditor 的 contentChange 回调，
                // 而页面正是靠它调用 loadEditorAnswerd / answerContentChange。
                // 手动补发一次 input 事件，让页面的监听器自己跑起来。
                try {
                    if (ed.body && typeof ed.body.dispatchEvent === 'function') {
                        ed.body.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } catch (e) {}
                // 再保险：直接调用页面回调
                try {
                    if (textarea && typeof textarea.dispatchEvent === 'function') {
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        textarea.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } catch (e) {}
                return true;
            } catch (e) { log('UEditor 写入失败(' + editorId + '): ' + e.message, 'warn'); }
        }
        // 无 UEditor（部分页面是纯 textarea）
        if (textarea) {
            textarea.value = value;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        return false;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** 填空题：按空写入 */
    function fillBlanks(el, values) {
        const qid = qidOf(el);
        const list = Array.isArray(values) ? values : [values];
        const total = blankCount(el);
        let done = 0;
        for (let i = 1; i <= total; i++) {
            const value = list[i - 1];
            if (value === undefined || value === null || String(value).trim() === '') continue;
            const editorId = 'answerEditor' + qid + i;
            let ta = document.getElementById(editorId);
            if (!ta) {
                const all = el.querySelectorAll('.textDIV textarea, .Answer textarea, textarea');
                ta = all[i - 1] || null;
            }
            if (!ta) continue;
            if (writeEditor(editorId, ta, String(value).trim())) done++;
        }
        if (done === 0) {
            // 单空兜底
            const ta = el.querySelector('textarea');
            if (ta && list[0]) done = writeEditor(ta.id, ta, String(list[0]).trim()) ? 1 : 0;
        }
        return { ok: done > 0, detail: `已写入 ${done}/${total} 空` };
    }

    /** 简答 / 材料 / 论述：单个富文本，编辑器 id 固定为 answer<qid> */
    function fillShortAnswer(el, value) {
        const qid = qidOf(el);
        const editorId = 'answer' + qid;
        let ta = document.getElementById(editorId);
        if (!ta || ta.tagName !== 'TEXTAREA') {
            const all = [...el.querySelectorAll('textarea')];
            ta = all.find(t => t.id === editorId) || all.find(t => t.name === editorId) || all[0] || ta;
        }
        if (!ta) return { ok: false, detail: '未找到主观题输入框' };
        const text = String(value || '').trim();
        if (!writeEditor(editorId, ta, text)) return { ok: false, detail: '主观题写入失败' };

        const recorded = readEditorAnswer(editorId, ta);
        if (!meaningfulAnswer(recorded)) return { ok: false, detail: '写入后编辑器仍为空（页面未接收内容）' };

        // 页面的提交逻辑会先 sync 富文本再暂存，这里主动走一次，避免刷新后答案丢失
        requestQuestionSave(el);
        const preview = String(recorded).replace(/\s+/g, ' ').trim();
        return { ok: true, detail: `已写入主观题（${preview.length} 字）` };
    }

    // =========================================================
    //  三、答案归一化（把 AI 的各种输出形状统一）
    // =========================================================

    function norm(s) {
        return String(s == null ? '' : s)
            .replace(/[\s\u3000]/g, '')
            .replace(/^[（(【\[]+|[）)】\]]+$/g, '')
            .replace(/[。．.,，、；;：:！!？?"'“”‘’]+$/g, '')
            .toLowerCase();
    }

    /** 从 AI 返回里取出题目答案数组 */
    function extractRawAnswers(ans) {
        if (ans == null) return [];
        if (Array.isArray(ans)) return ans;
        if (typeof ans === 'string') return [ans];
        if (typeof ans === 'object') {
            for (const k of ['answers', 'answer', 'letters', 'choices', 'result', 'data', 'content']) {
                const v = ans[k];
                if (v === undefined || v === null) continue;
                if (Array.isArray(v)) return v;
                if (typeof v === 'string' && v.trim()) {
                    // 可能是 "A,B" 或 JSON 字符串
                    const t = v.trim();
                    if (/^[[{]/.test(t)) { try { return extractRawAnswers(JSON.parse(t)); } catch (e) {} }
                    if (/^[A-Za-z](\s*[,，、|/]\s*[A-Za-z])+$/.test(t)) return t.split(/[,，、|/]/);
                    return [t];
                }
                if (typeof v === 'object') return extractRawAnswers(v);
            }
            // 材料题可能按小问编号返回 {"1":"…","2":"…"}，没有固定字段名
            const keys = Object.keys(ans);
            if (keys.length) {
                return keys.sort((a, b) => (+a || 0) - (+b || 0)).map(k => ans[k]);
            }
        }
        return [];
    }

    /** 归一化成：{letters:[], judges:[], values:[]} */
    function normalizeAnswer(ans, type, options) {
        const raw = extractRawAnswers(ans);
        const out = { letters: [], judges: [], values: [] };
        const letterSet = options.map(o => (o.letter || '').toUpperCase()).filter(Boolean);

        const pushValue = (v) => {
            if (v === undefined || v === null) return;
            if (typeof v === 'object') {
                if (v.answer !== undefined) return pushValue(v.answer);
                if (v.content !== undefined) return pushValue(v.content);
                if (v.value !== undefined) return pushValue(v.value);
                if (v.text !== undefined) return pushValue(v.text);
                return;
            }
            const s = String(v).trim();
            if (s) out.values.push(s);
        };

        for (const item of raw) {
            if (item === undefined || item === null) continue;
            if (typeof item === 'object') {
                // 多空答案对象 {1:"x",2:"y"} 或 {name,content}
                if (item.content !== undefined || item.value !== undefined || item.answer !== undefined) {
                    pushValue(item);
                } else {
                    Object.keys(item).sort((a, b) => (+a || 0) - (+b || 0)).forEach(k => pushValue(item[k]));
                }
                continue;
            }
            let s = String(item).trim();
            if (!s) continue;

            const n = norm(s);
            if (type === TYPE.SINGLE || type === TYPE.MULTI) {
                // "A" / "AB" / "A、B" / "选项A"
                let letters = '';
                const cleaned = s.replace(/选项|答案|正确|：|:/g, '');
                if (/^[A-Za-z]+$/.test(cleaned.trim())) {
                    letters = cleaned.trim().toUpperCase();
                } else {
                    const m = cleaned.match(/[A-Za-z]/g);
                    if (m && m.length && cleaned.replace(/[^A-Za-z]/g, '').length === m.length) letters = m.join('').toUpperCase();
                }
                if (letters && (!letterSet.length || [...letters].every(L => letterSet.includes(L)))) {
                    letters.split('').forEach(L => { if (!out.letters.includes(L)) out.letters.push(L); });
                } else {
                    out.values.push(s);   // 字母对不上就当作文本，稍后按文本匹配
                }
            } else if (type === TYPE.JUDGE) {
                if (/^(对|正确|是|真|t|true|y|yes|√|✓|1)$/.test(n)) out.judges.push(true);
                else if (/^(错|错误|否|假|f|false|n|no|×|✗|x|0)$/.test(n)) out.judges.push(false);
                else out.values.push(s);
            } else {
                out.values.push(s);
            }
        }
        return out;
    }

    // =========================================================
    //  四、答题主流程
    // =========================================================

    async function start() {
        if (running) return;
        if (!String(CONFIG.API_KEY || '').trim() || !String(CONFIG.MODEL || '').trim()) {
            showPanel('settings');
            setSettingsMessage('请先填写模型名称和 API Key。', true);
            return;
        }
        running = true;
        stopRequested = false;
        const btn = document.getElementById('cx-auto-btn');
        if (btn) { btn.disabled = false; btn.textContent = '停止'; btn.classList.add('cx-stop'); }

        showPanel();
        log('开始处理题目…', 'step');

        const allQuestions = collectQuestions();
        const total = allQuestions.length;
        if (!total) {
            log('识别到 0 道题目', 'err');
            log('未识别到题目：请确认已进入作业作答页面（.questionLi 容器）', 'err');
            finish(); return;
        }

        const startAt = Math.max(1, Math.floor(Number(CONFIG.QUESTION_START) || 1));
        const configuredEnd = Math.floor(Number(CONFIG.QUESTION_END) || 0);
        const endAt = configuredEnd <= 0 ? total : Math.min(total, configuredEnd);
        if (startAt > total) {
            log(`答题区间从第 ${startAt} 题开始，但页面只有 ${total} 道题。`, 'err');
            showPanel('settings');
            finish(); return;
        }
        if (endAt < startAt) {
            log('答题区间无效：结束题号不能小于开始题号，请到设置中调整。', 'err');
            showPanel('settings');
            finish(); return;
        }
        let questions = allQuestions.slice(startAt - 1, endAt);
        if (CONFIG.QUESTION_ORDER === 'reverse') questions.reverse();
        if (CONFIG.QUESTION_ORDER === 'random') {
            for (let i = questions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [questions[i], questions[j]] = [questions[j], questions[i]];
            }
        }
        const orderName = { page: '页面顺序', reverse: '倒序', random: '随机' }[CONFIG.QUESTION_ORDER] || '页面顺序';
        log(`识别到 ${total} 道题目；本次处理第 ${startAt}–${endAt} 题，共 ${questions.length} 道，${orderName}`, 'step');

        let ok = 0, fail = 0;
        for (let i = 0; i < questions.length; i++) {
            if (stopRequested) { log('已被用户停止', 'warn'); break; }
            const el = questions[i];
            setProgress((i / questions.length) * 100);
            log(`—— 第 ${i + 1}/${questions.length} 题 ——`, 'step');

            if (CONFIG.SCROLL_TO_QUESTION && isVisible(el) === false) {
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
            } else if (CONFIG.SCROLL_TO_QUESTION) {
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
            }
            flash(el);

            try {
                const r = await handleQuestion(el);
                if (r.ok) {
                    ok++;
                    log(`第 ${i + 1} 题 ✓ ${r.detail}`, 'ok');
                    el.classList.add('cx-auto-filled'); el.classList.remove('cx-auto-failed');
                } else {
                    fail++;
                    log(`第 ${i + 1} 题 ✗ ${r.detail}`, 'err');
                    el.classList.add('cx-auto-failed'); el.classList.remove('cx-auto-filled');
                }
            } catch (e) {
                fail++;
                log(`第 ${i + 1} 题异常: ${e.message}`, 'err');
            }

            if (i < questions.length - 1 && !stopRequested) await delay(CONFIG.DELAY_BETWEEN_QUESTIONS);
        }

        setProgress(100);
        log(`全部完成：成功 ${ok}，失败 ${fail}`, ok >= fail ? 'ok' : 'err');

        if (CONFIG.AUTO_SAVE && !stopRequested) {
            await delay(400);
            clickByText(/^保存$|保存作业|暂存/);
        }
        if (CONFIG.AUTO_SUBMIT && !stopRequested) {
            await delay(800);
            submitWork();
        }
        finish();
    }

    async function handleQuestion(el) {
        const type = getQuestionType(el);
        const typeName = getQuestionTypeName(el);
        const stem = getStemText(el);
        const options = prepareAnswerOptions(getOptions(el));

        if (!stem || stem.length < 3) return { ok: false, detail: '题干提取失败' };
        log(`题干：${stem.slice(0, 70)}${stem.length > 70 ? '…' : ''}`, 'q');
        log(`题型：${typeName}｜选项 ${options.length} 个`, 'step');

        const needsOptions = (type === TYPE.SINGLE || type === TYPE.MULTI);
        if (needsOptions && options.length < 2) return { ok: false, detail: `选项识别失败（仅 ${options.length} 个）` };

        const prompt = buildPrompt(stem, typeName, type, options, el);
        const maxTokens = type === TYPE.SHORT ? 2000 : 400;
        const aiAnswer = await askAI(prompt, CONFIG.MAX_RETRIES, { maxTokens });
        if (!aiAnswer) return { ok: false, detail: '未获取到 AI 答案' };
        log(`AI 返回：${JSON.stringify(aiAnswer).slice(0, 160)}`, 'ai');

        const applyChoiceAnswer = answer => {
            if (type === TYPE.SINGLE) return fillChoiceSingle(el, options, answer);
            if (type === TYPE.MULTI) return fillChoiceMulti(el, options, answer);
            if (type === TYPE.JUDGE) return fillJudge(el, options, answer);
            return null;
        };
        if (type === TYPE.SINGLE || type === TYPE.MULTI || type === TYPE.JUDGE) {
            const firstResult = applyChoiceAnswer(aiAnswer);
            if (!firstResult || firstResult.ok || !['unmatched-answer', 'empty-answer'].includes(firstResult.reason)) return firstResult;

            log('AI 答案无法对应页面选项，正在按页面实际选项重新询问一次…', 'warn');
            const retryPrompt = buildOptionFallbackPrompt(stem, typeName, type, options, aiAnswer);
            const retryAnswer = await askAI(retryPrompt, 0);
            let retryDetail = '兜底重试没有返回可用答案';
            if (retryAnswer) {
                log(`兜底重试返回：${JSON.stringify(retryAnswer).slice(0, 160)}`, 'ai');
                const retryResult = applyChoiceAnswer(retryAnswer);
                if (retryResult && retryResult.ok) {
                    return { ...retryResult, detail: `兜底重试匹配成功：${retryResult.detail}` };
                }
                if (retryResult && retryResult.detail) retryDetail = retryResult.detail;
            }
            return {
                ok: false,
                detail: `AI 答案无法对应页面选项；${retryDetail}。该题已跳过并标红，请人工核对。`
            };
        }
        if (type === TYPE.FILL) return fillFill(el, aiAnswer);
        if (type === TYPE.SHORT) return fillShort(el, aiAnswer);
        // 未知类型：有选项按单选，否则按填空
        return options.length >= 2 ? fillChoiceSingle(el, options, aiAnswer) : fillFill(el, aiAnswer);
    }

    function buildOptionFallbackPrompt(stem, typeName, type, options, previousAnswer) {
        const optionText = options.map(o => `${answerLetterForOption(o)}：${o.text}`).join('\n');
        const output = type === TYPE.MULTI ? '{"answers":["A","C"]}' : '{"answer":"A"}';
        const previous = JSON.stringify(previousAnswer).slice(0, 300);
        return `请重新判断下面这道${typeName}。\n题目：${stem}\n页面中的可选项（只能从这些选项中选择）：\n${optionText}\n上一次回答无法对应页面选项：${previous}\n要求：只根据题目和选项作答；答案必须是上面列出的选项字母，禁止输出选项正文、解释或其他文字；只输出严格 JSON：${output}`;
    }

    function buildPrompt(stem, typeName, type, options, el) {
        let prompt = `题目：${stem}`;
        if (options.length) {
            prompt += `\n选项：\n` + options.map(o => {
                if (type === TYPE.JUDGE) return `${answerLetterForOption(o)}.${o.text}`;
                return `${answerLetterForOption(o)}. ${o.text}`;
            }).join('\n');
        }
        prompt += `\n题型：${typeName}`;
        if (type === TYPE.FILL) {
            const n = blankCount(el);
            prompt += `（共 ${n} 空）\n要求：只输出严格 JSON，不要任何解释、markdown 代码块或多余文字。\n填空题输出 {"answers":["第1空答案","第2空答案"]}`;
        } else if (type === TYPE.MULTI) {
            prompt += `\n要求：只从上方实际列出的选项字母中选择所有正确项；只输出严格 JSON，不要选项正文、解释、markdown 代码块或多余文字。\n多选题输出 {"answers":["A","B"]}`;
        } else if (type === TYPE.JUDGE) {
            prompt += `\n要求：只能从上方实际列出的选项字母中选择；只输出严格 JSON，不要选项正文、解释、markdown 代码块或多余文字。\n判断题输出对应选项字母，例如 {"answer":"A"}`;
        } else if (type === TYPE.SHORT) {
            if (/材料|阅读|案例|分析/.test(typeName)) {
                prompt += `\n要求：本题为材料题，请紧扣材料逐问作答，用（1）（2）标明小问；答案完整、具体，不要只写提纲。` +
                    `只输出严格 JSON，不要解释输出格式，不要 markdown 代码块或多余文字。\n材料题输出 {"answer":"完整作答内容"}`;
            } else if (/论述|综合|解答|计算/.test(typeName)) {
                prompt += `\n要求：本题为论述题，请给出结构完整、论点明确、有论证过程的答案，可分段落展开（不少于 300 字）。` +
                    `只输出严格 JSON，不要解释输出格式，不要 markdown 代码块或多余文字。\n论述题输出 {"answer":"完整答案文字"}`;
            } else {
                prompt += `\n要求：答案应完整、准确；只输出严格 JSON，不要任何解释、markdown 代码块或多余文字。\n简答题输出 {"answer":"完整答案文字"}`;
            }
        } else {
            prompt += `\n要求：答案只能是上方实际列出的选项字母；只输出严格 JSON，不要选项正文、解释、markdown 代码块或多余文字。\n单选题输出 {"answer":"A"}`;
        }
        return prompt;
    }

    // ---------- 各题型写入 ----------

    function fillChoiceSingle(el, options, ans) {
        const a = normalizeAnswer(ans, TYPE.SINGLE, options);
        if (!a.letters.length && !a.values.length) return { ok: false, reason: 'empty-answer', detail: '答案为空' };

        let target = null;
        if (a.letters.length) target = options.find(o => answerLetterForOption(o) === a.letters[0]);
        if (!target && a.values.length) target = matchByText(options, a.values[0]);
        if (!target) return { ok: false, reason: 'unmatched-answer', detail: `未匹配到选项 ${a.letters.join('') || a.values[0]}` };

        clearQuestion(el, false);
        const selected = selectOption(target, false, el);
        syncChoiceHidden(el, false);
        if (!selected.clicked) requestQuestionSave(el);
        return verifyChoice(el, options, false, [target]);
    }

    function fillChoiceMulti(el, options, ans) {
        const a = normalizeAnswer(ans, TYPE.MULTI, options);
        if (!a.letters.length && !a.values.length) return { ok: false, reason: 'empty-answer', detail: '答案为空' };

        const targets = [];
        for (const L of a.letters) {
            const t = options.find(o => answerLetterForOption(o) === L);
            if (t && !targets.includes(t)) targets.push(t);
        }
        for (const v of a.values) {
            const t = matchByText(options, v);
            if (t && !targets.includes(t)) targets.push(t);
        }
        if (!targets.length) {
            const answerText = [...a.letters, ...a.values].join('、');
            return { ok: false, reason: 'unmatched-answer', detail: `未匹配到多选项 ${answerText || '（空答案）'}` };
        }

        clearQuestion(el, true);
        const selections = targets.map(t => selectOption(t, true, el));
        syncChoiceHidden(el, true);
        if (selections.some(s => !s.clicked)) requestQuestionSave(el);
        return verifyChoice(el, options, true, targets);
    }

    function fillJudge(el, options, ans) {
        const a = normalizeAnswer(ans, TYPE.JUDGE, options);
        let target = null;

        if (a.judges.length) {
            const wantTrue = a.judges[0];
            // 优先按 data 属性（true/false）精确匹配
            target = options.find(o => String(o.data).toLowerCase() === String(wantTrue));
            if (!target) {
                // 按选项文字匹配
                target = options.find(o => {
                    const n = norm(o.text);
                    return wantTrue ? /^(对|正确|是|真|√|✓|t|true|y|yes|1)$/.test(n)
                                    : /^(错|错误|否|假|×|✗|x|f|false|n|no|0)$/.test(n);
                });
            }
        }
        if (!target && a.values.length) target = matchByText(options, a.values[0]);
        if (!target) {
            if (!a.judges.length && !a.values.length) return { ok: false, reason: 'empty-answer', detail: '判断题答案为空' };
            return { ok: false, reason: 'unmatched-answer', detail: `未匹配到判断选项 ${JSON.stringify(a)}` };
        }

        clearQuestion(el, false);
        const selected = selectOption(target, false, el);
        syncChoiceHidden(el, false);
        if (!selected.clicked) requestQuestionSave(el);
        return verifyChoice(el, options, false, [target]);
    }

    function fillFill(el, ans) {
        const a = normalizeAnswer(ans, TYPE.FILL, []);
        const values = a.values.length ? a.values : extractRawAnswers(ans).map(v => String(v));
        if (!values.length) return { ok: false, detail: '答案为空' };
        const r = fillBlanks(el, values);
        if (!r.ok) return r;
        // 回读校验：编辑器内容或隐藏 textarea
        const qid = qidOf(el);
        const total = blankCount(el);
        let filled = 0;
        for (let i = 1; i <= total; i++) {
            const editorId = 'answerEditor' + qid + i;
            let ta = document.getElementById(editorId);
            if (!ta) {
                const all = el.querySelectorAll('.textDIV textarea, .Answer textarea, textarea');
                ta = all[i - 1] || null;
            }
            if (meaningfulAnswer(readEditorAnswer(editorId, ta))) filled++;
        }
        if (filled > 0) requestQuestionSave(el);
        return { ok: filled > 0, detail: `${r.detail}，校验到 ${filled} 空有内容` };
    }

    function fillShort(el, ans) {
        const a = normalizeAnswer(ans, TYPE.SHORT, []);
        const text = a.values.join('\n') || String(extractRawAnswers(ans).join('\n') || '');
        if (!text.trim()) return { ok: false, detail: '答案为空' };
        return fillShortAnswer(el, text);
    }

    /** 选项文本匹配 */
    function matchByText(options, value) {
        const n = norm(value);
        if (!n) return null;
        // 1) 文本完全相等
        let t = options.find(o => norm(o.text) === n);
        if (t) return t;
        // 2) 文本互相包含
        t = options.find(o => { const on = norm(o.text); return on && (on.includes(n) || n.includes(on)) && Math.min(on.length, n.length) >= 2; });
        if (t) return t;
        // 3) 值本身是字母
        const L = String(value).trim().toUpperCase();
        if (/^[A-Z]$/.test(L)) return options.find(o => answerLetterForOption(o) === L) || null;
        // 4) 值里含字母
        const m = String(value).match(/\b([A-Z])\b/) || String(value).match(/[（(]?([A-Z])[）)]?\s*[.、．]/);
        if (m) return options.find(o => answerLetterForOption(o) === m[1]) || null;
        return null;
    }

    /** 回读校验：确认页面既显示了选中标记，也把答案写进了隐藏域 */
    function verifyChoice(el, options, multi, targets) {
        const cls = choiceClass(multi);
        const box = hiddenAnswer(el);
        const val = box ? String(box.value || '').trim() : '';
        const marked = options.filter(o => o.node && isOptionMarked(o.node, multi));

        if (!marked.length) {
            return { ok: false, detail: `点击未生效（未出现 ${cls} 标记）` };
        }
        const missing = (targets || []).filter(t => !t.node || !isOptionMarked(t.node, multi));
        if (missing.length) {
            return { ok: false, detail: `部分选项未选中：${missing.map(o => answerLetterForOption(o)).join('、') || '未知'}` };
        }
        if (box && !val) {
            return { ok: false, detail: '选项已标记，但答案隐藏域仍为空（未绑定到答案）' };
        }
        const letters = marked.map(o => answerLetterForOption(o)).join('');
        return { ok: true, detail: `已选择 ${letters}${val ? `（页面记录：${val}）` : ''}` };
    }

    // =========================================================
    //  五、AI 调用
    // =========================================================

    async function askAI(prompt, maxRetries = CONFIG.MAX_RETRIES, options = {}) {
        const maxTokens = Math.max(200, Math.min(4000, Number(options.maxTokens) || 400));
        if (CONFIG.ENABLE_CACHE) {
            const key = cacheKey(prompt);
            const hit = readCache(key);
            if (hit) { log('命中本地缓存，跳过 API 请求', 'hit'); return hit; }
        }
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const ans = await callAPI(prompt, maxTokens);
                if (ans) {
                    if (CONFIG.ENABLE_CACHE) writeCache(cacheKey(prompt), ans);
                    return ans;
                }
            } catch (e) {
                log(`API 请求失败(${attempt + 1}/${maxRetries + 1})：${e.message}`, 'err');
                if (e && e.retryable === false) break;
            }
            if (attempt < maxRetries) await delay(1000 * (attempt + 1));
        }
        return null;
    }

    function callAPI(prompt, maxTokens = 400) {
        const promptLimit = maxTokens >= 1000 ? 8000 : 3000;
        return requestCompletion(
            CONFIG.PROVIDER,
            CONFIG.MODEL,
            CONFIG.API_KEY,
            prompt.slice(0, promptLimit),
            maxTokens,
            '你是答题助手，只输出纯净 JSON，禁止使用 ```json 代码块，禁止任何多余文字。'
        ).then(parseAnswer);
    }

    function requestCompletion(provider, model, apiKey, prompt, maxTokens, systemPrompt) {
        return new Promise((resolve, reject) => {
            const providerInfo = PROVIDERS[provider];
            if (!providerInfo) { reject(makeApiError('未知的 AI 服务商', false)); return; }
            if (!String(apiKey || '').trim()) { reject(makeApiError('未填写 API Key', false)); return; }
            if (!String(model || '').trim()) { reject(makeApiError('未选择模型 ID', false)); return; }
            const payload = {
                model: String(model).trim(),
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: maxTokens,
                stream: false
            };
            // DeepSeek 新版思考模型不接受 temperature 参数，豆包支持固定温度。
            if (provider === 'doubao') payload.temperature = 0;
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(makeApiError('GM_xmlhttpRequest 不可用；请在 Tampermonkey 中启用脚本并允许跨域请求。', false));
                return;
            }
            GM_xmlhttpRequest({
                method: 'POST',
                url: providerInfo.url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${String(apiKey).trim()}`
                },
                data: JSON.stringify(payload),
                timeout: CONFIG.TIMEOUT,
                onload(res) {
                    let data;
                    try {
                        data = JSON.parse(res.responseText || '');
                    } catch (e) {
                        reject(makeApiError(`HTTP ${res.status || 0}：服务端返回的不是 JSON。${trimApiDetail(res.responseText)}`, Number(res.status) >= 500));
                        return;
                    }
                    const status = Number(res.status) || 0;
                    if (status < 200 || status >= 300 || data.error) {
                        const details = data.error && (data.error.message || data.error.msg || data.error) || data.message || data.msg || '';
                        reject(makeApiError(formatApiError(status, details), status === 429 || status >= 500));
                        return;
                    }
                    const choice = data.choices && data.choices[0];
                    const message = choice && choice.message;
                    let content = message && message.content;
                    if (Array.isArray(content)) content = content.map(part => part && (part.text || part.content) || '').join('');
                    const raw = String(content || '').trim();
                    if (!raw) {
                        const reason = choice && choice.finish_reason === 'length' ? '模型输出被截断，请重试或换一个模型。' : 'API 返回成功，但没有回答内容。';
                        reject(makeApiError(reason, false));
                        return;
                    }
                    resolve(raw);
                },
                onerror() {
                    reject(makeApiError(`网络请求失败。请确认油猴脚本已更新并允许访问 ${new URL(providerInfo.url).hostname}。`, true));
                },
                ontimeout() { reject(makeApiError('请求超时；可检查网络、模型服务状态，或在答题设置中调低请求频率。', true)); }
            });
        });
    }

    function makeApiError(message, retryable) {
        const error = new Error(message);
        error.retryable = retryable;
        return error;
    }

    function trimApiDetail(value) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return text ? `接口详情：${text.slice(0, 240)}` : '';
    }

    function formatApiError(status, details) {
        const detail = trimApiDetail(details);
        let hint = '';
        if (status === 401) hint = 'API Key 无效，或 API Key 与所选服务商不匹配。';
        else if (status === 403) hint = '当前 Key 没有调用该模型的权限，请检查账户权限或模型开通状态。';
        else if (status === 404) hint = '接口地址或模型 ID 不存在；豆包可尝试选择列表模型，或填写控制台中的接入点 ID。';
        else if (status === 429) hint = '调用频率或账户额度已达到限制，请稍后重试并检查服务商额度。';
        else if (status >= 500) hint = '模型服务暂时异常，请稍后重试。';
        else hint = '请求未成功，请检查服务商、模型 ID 和 API Key。';
        return `HTTP ${status || 0}：${hint}${detail ? ` ${detail}` : ''}`;
    }

    /** 高容错解析：代码块、前后缀文字、换行截断都能救回来 */
    function parseAnswer(raw) {
        let s = String(raw).trim();
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const tryJSON = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };

        let v = tryJSON(s);
        if (v !== undefined) return v;

        // 截取第一个 { 到最后一个 }
        const a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a !== -1 && b > a) {
            v = tryJSON(s.slice(a, b + 1));
            if (v !== undefined) return v;
        }
        const c = s.indexOf('['), d = s.lastIndexOf(']');
        if (c !== -1 && d > c) {
            v = tryJSON(s.slice(c, d + 1));
            if (v !== undefined) return v;
        }
        // 去掉裸换行再试
        v = tryJSON(s.replace(/[\r\n]+/g, ' '));
        if (v !== undefined) return v;

        // 主观题输出被 max_tokens 截断时，尽量救回已经生成的正文
        const truncated = s.match(/^\{\s*"(?:answer|answers)"\s*:\s*"([\s\S]*)$/);
        if (truncated) {
            let text = truncated[1];
            const close = text.lastIndexOf('"}');
            if (close !== -1) text = text.slice(0, close);
            text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
            if (text) return { answer: text };
        }

        // 完全不是 JSON：按纯文本处理
        log('AI 返回非 JSON，按纯文本解析', 'warn');
        return { answer: s };
    }

    function cacheKey(s) {
        try { return btoa(unescape(encodeURIComponent(s))).slice(0, 48); }
        catch (e) { return String(s.length) + ':' + s.slice(0, 40); }
    }
    function readCache(k) {
        const d = answerCache.get(k);
        if (!d) return null;
        if (Date.now() - d.t >= CONFIG.CACHE_EXPIRY) { answerCache.delete(k); return null; }
        return d.a;
    }
    function writeCache(k, a) {
        const now = Date.now();
        for (const [key, val] of answerCache) if (now - val.t >= CONFIG.CACHE_EXPIRY) answerCache.delete(key);
        answerCache.set(k, { a, t: now });
    }

    // =========================================================
    //  六、提交 / 保存
    // =========================================================

    function clickByText(re) {
        const nodes = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], .btn, .submit, .tjBtn, span');
        for (const n of nodes) {
            const t = (n.textContent || n.value || '').trim();
            if (t && re.test(t) && isVisible(n)) { n.click(); log(`已点击「${t}」`, 'ok'); return true; }
        }
        return false;
    }

    function submitWork() {
        log('尝试提交作业…', 'step');
        // 页面自带提交入口
        const fn = page.submitValidate || window.submitValidate;
        if (typeof fn === 'function') {
            try { fn.call(page, 0); log('已调用页面 submitValidate', 'ok'); return true; } catch (e) {}
        }
        if (clickByText(/^(提交作业|提交|交卷)$/)) return true;
        log('未找到提交按钮', 'err');
        return false;
    }

    // =========================================================
    //  七、界面
    // =========================================================

    function createButton() {
        dock = document.getElementById('cx-auto-dock');
        if (!dock) {
            dock = document.createElement('div');
            dock.id = 'cx-auto-dock';
            dock.innerHTML = '<div id="cx-auto-toolbar"></div>';
            document.body.appendChild(dock);
            const toolbar = dock.querySelector('#cx-auto-toolbar');
            toolbar.addEventListener('pointerdown', beginDockDrag);
            toolbar.addEventListener('pointermove', moveDockDrag);
            toolbar.addEventListener('pointerup', endDockDrag);
            toolbar.addEventListener('pointercancel', endDockDrag);
        }
        const toolbar = dock.querySelector('#cx-auto-toolbar');
        if (!document.getElementById('cx-auto-btn')) {
            const btn = document.createElement('button');
            btn.id = 'cx-auto-btn';
            btn.type = 'button';
            btn.textContent = '开始答题';
            btn.setAttribute('aria-label', '开始答题，也可拖动以移动答题工具');
            btn.onclick = handleStartButtonClick;
            toolbar.appendChild(btn);
        }
        if (!document.getElementById('cx-auto-settings-btn')) {
            const settingsBtn = document.createElement('button');
            settingsBtn.id = 'cx-auto-settings-btn';
            settingsBtn.type = 'button';
            settingsBtn.textContent = '答题设置';
            settingsBtn.setAttribute('aria-label', '答题设置，也可拖动以移动答题工具');
            settingsBtn.setAttribute('aria-controls', 'cx-auto-panel');
            settingsBtn.setAttribute('aria-expanded', 'false');
            settingsBtn.onclick = (event) => {
                if (shouldSuppressDockClick(event)) return;
                showPanel('settings');
            };
            toolbar.appendChild(settingsBtn);
        }
        if (dockPosition) applyDockPosition(dockPosition.left, dockPosition.top);
    }

    function handleStartButtonClick(event) {
        if (shouldSuppressDockClick(event)) return;
        if (running) requestStop();
        else start();
    }

    function showPanel(view) {
        if (!dock || !document.body.contains(dock)) createButton();
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'cx-auto-panel';
            panel.innerHTML = `
                <div class="hd">
                    <span data-role="title" tabindex="0" aria-describedby="cx-auto-drag-hint">答题进度</span>
                    <span id="cx-auto-drag-hint" class="sr-only">拖动任一顶部按钮或面板标题栏移动整组工具。聚焦标题后可用方向键微调，按 Home 恢复默认位置。</span>
                    <div class="head-actions">
                        <button type="button" data-act="settings" aria-expanded="false">设置</button>
                        <button type="button" class="mini" data-act="toggle" aria-expanded="true">收起</button>
                    </div>
                </div>
                <div class="prog"><i></i></div>
                <div class="bd"></div>
                <section class="settings" hidden aria-label="答题设置">
                    <form id="cx-auto-settings-form">
                        <div class="field">
                            <label for="cx-setting-provider">AI 服务商</label>
                            <select id="cx-setting-provider" name="provider">
                                <option value="doubao">豆包（火山方舟）</option>
                                <option value="deepseek">DeepSeek 官方 API</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="cx-setting-model">模型</label>
                            <select id="cx-setting-model" name="model" required></select>
                        </div>
                        <div class="field" data-role="custom-model-field" hidden>
                            <label for="cx-setting-custom-model">自定义模型 ID / 接入点 ID</label>
                            <input id="cx-setting-custom-model" name="customModel" type="text" autocomplete="off" spellcheck="false">
                            <small>豆包可填写火山方舟控制台中的模型 ID 或 ep-* 接入点 ID。</small>
                        </div>
                        <div class="field">
                            <label for="cx-setting-key">API Key</label>
                            <div class="key-line">
                                <input id="cx-setting-key" name="apiKey" type="password" required autocomplete="new-password" spellcheck="false">
                                <button type="button" data-act="reveal-key" aria-controls="cx-setting-key" aria-pressed="false">显示</button>
                            </div>
                            <small data-role="key-help">请填写火山方舟 API Key。Key 保存在浏览器用户脚本存储中，不会写入脚本文件。</small>
                        </div>
                        <fieldset class="field" style="border:0;padding:0;margin-left:0;margin-right:0">
                            <legend>答题区间（按页面题号）</legend>
                            <div class="range-fields">
                                <div class="field">
                                    <label for="cx-setting-start">开始题号</label>
                                    <input id="cx-setting-start" name="start" type="number" min="1" step="1" required>
                                </div>
                                <div class="field">
                                    <label for="cx-setting-end">结束题号</label>
                                    <input id="cx-setting-end" name="end" type="number" min="0" step="1" required>
                                </div>
                            </div>
                            <small class="hint">结束题号设为 0 表示处理到最后一题。</small>
                        </fieldset>
                        <div class="field">
                            <label for="cx-setting-order">答题顺序</label>
                            <select id="cx-setting-order" name="order">
                                <option value="page">页面顺序</option>
                                <option value="reverse">倒序</option>
                                <option value="random">随机</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="cx-setting-delay">每题间隔 <output id="cx-setting-delay-label" for="cx-setting-delay"></output></label>
                            <input id="cx-setting-delay" name="delay" type="range" min="0" max="5000" step="100">
                            <small>间隔越短速度越快；0 表示连续处理。</small>
                        </div>
                        <div class="settings-actions">
                            <button class="test-connection" type="button" data-act="test-connection">测试连接</button>
                            <button class="save-settings" type="submit">保存设置</button>
                            <span class="settings-status" data-role="settings-status" role="status" aria-live="polite"></span>
                        </div>
                    </form>
                </section>`;
            dock.appendChild(panel);
            body = panel.querySelector('.bd');
            bar = panel.querySelector('.prog i');
            const toggleBtn = panel.querySelector('[data-act="toggle"]');
            toggleBtn.onclick = (e) => {
                panel.classList.toggle('collapsed');
                const collapsed = panel.classList.contains('collapsed');
                e.currentTarget.textContent = collapsed ? '展开' : '收起';
                e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
            };
            panel.querySelector('[data-act="settings"]').onclick = () => {
                const isSettings = panel.querySelector('.settings').hidden;
                setPanelView(isSettings ? 'settings' : 'progress');
            };
            panel.querySelector('[data-act="reveal-key"]').onclick = (e) => {
                const input = panel.querySelector('#cx-setting-key');
                const shown = input.type === 'password';
                input.type = shown ? 'text' : 'password';
                e.currentTarget.textContent = shown ? '隐藏' : '显示';
                e.currentTarget.setAttribute('aria-pressed', String(shown));
            };
            panel.querySelector('#cx-setting-provider').addEventListener('change', changeSettingsProvider);
            panel.querySelector('#cx-setting-model').addEventListener('change', updateCustomModelVisibility);
            panel.querySelector('[data-act="test-connection"]').addEventListener('click', testSettingsConnection);
            panel.querySelector('#cx-setting-delay').addEventListener('input', updateDelayLabel);
            panel.querySelector('#cx-auto-settings-form').addEventListener('submit', saveSettingsFromForm);
            panel.querySelector('.hd').addEventListener('pointerdown', beginDockDrag);
            panel.querySelector('.hd').addEventListener('pointermove', moveDockDrag);
            panel.querySelector('.hd').addEventListener('pointerup', endDockDrag);
            panel.querySelector('.hd').addEventListener('pointercancel', endDockDrag);
            panel.querySelector('[data-role="title"]').addEventListener('keydown', moveDockWithKeyboard);
            if (typeof window.addEventListener === 'function') window.addEventListener('resize', keepDockInViewport);
            populateSettingsForm();
        }
        if (panel.parentElement !== dock) dock.appendChild(panel);
        setPanelView(view || 'progress');
        panel.style.display = '';
        if (dockPosition) applyDockPosition(dockPosition.left, dockPosition.top);
    }

    let activeDockDrag = null;
    let suppressDockClickUntil = 0;

    function beginDockDrag(event) {
        const target = event.target;
        if (event.button !== 0 || event.isPrimary === false ||
            (target.closest && target.closest('#cx-auto-panel button, #cx-auto-panel input, #cx-auto-panel select, #cx-auto-panel textarea, #cx-auto-panel a'))) return;
        const rect = dock.getBoundingClientRect();
        activeDockDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            didMove: false
        };
        try {
            const captureTarget = target.setPointerCapture ? target : event.currentTarget;
            captureTarget.setPointerCapture(event.pointerId);
        } catch (e) {}
    }

    function moveDockDrag(event) {
        if (!activeDockDrag || event.pointerId !== activeDockDrag.pointerId) return;
        const dx = event.clientX - activeDockDrag.startX;
        const dy = event.clientY - activeDockDrag.startY;
        if (!activeDockDrag.didMove && Math.hypot(dx, dy) < 5) return;
        activeDockDrag.didMove = true;
        dock.classList.add('cx-dragging');
        applyDockPosition(activeDockDrag.left + dx, activeDockDrag.top + dy);
        event.preventDefault();
    }

    function endDockDrag(event) {
        if (!activeDockDrag || event.pointerId !== activeDockDrag.pointerId) return;
        if (activeDockDrag.didMove) suppressDockClickUntil = Date.now() + 250;
        dock.classList.remove('cx-dragging');
        activeDockDrag = null;
        saveDockPosition();
    }

    function shouldSuppressDockClick(event) {
        if (Date.now() > suppressDockClickUntil) return false;
        event.preventDefault();
        event.stopPropagation();
        suppressDockClickUntil = 0;
        return true;
    }

    function applyDockPosition(left, top) {
        if (!dock) return;
        const bounds = document.documentElement;
        const viewportWidth = bounds.clientWidth || window.innerWidth || 1280;
        const viewportHeight = bounds.clientHeight || window.innerHeight || 800;
        const maxLeft = Math.max(0, viewportWidth - dock.offsetWidth);
        const maxTop = Math.max(0, viewportHeight - dock.offsetHeight);
        const x = Math.min(maxLeft, Math.max(0, Number(left) || 0));
        const y = Math.min(maxTop, Math.max(0, Number(top) || 0));
        dock.style.left = `${x}px`;
        dock.style.top = `${y}px`;
        dock.style.right = 'auto';
        dockPosition = { left: x, top: y };
    }

    function saveDockPosition() {
        if (!dockPosition) return;
        let persisted = false;
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(PANEL_POSITION_KEY, dockPosition);
                persisted = true;
            }
        } catch (e) {}
        if (!persisted) {
            try { localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(dockPosition)); } catch (e) {}
        }
    }

    function keepDockInViewport() {
        if (!dock || !dockPosition || !dock.offsetWidth) return;
        applyDockPosition(dockPosition.left, dockPosition.top);
        saveDockPosition();
    }

    function moveDockWithKeyboard(event) {
        const step = event.shiftKey ? 48 : 16;
        const delta = {
            ArrowLeft: [-step, 0], ArrowRight: [step, 0],
            ArrowUp: [0, -step], ArrowDown: [0, step]
        }[event.key];
        if (event.key === 'Home') {
            event.preventDefault();
            dockPosition = null;
            dock.style.left = '';
            dock.style.top = '18px';
            dock.style.right = '18px';
            try {
                if (typeof GM_setValue === 'function') GM_setValue(PANEL_POSITION_KEY, { reset: true });
                else localStorage.removeItem(PANEL_POSITION_KEY);
            } catch (e) { try { localStorage.removeItem(PANEL_POSITION_KEY); } catch (ignored) {} }
            return;
        }
        if (!delta) return;
        event.preventDefault();
        const rect = dock.getBoundingClientRect();
        applyDockPosition(rect.left + delta[0], rect.top + delta[1]);
        saveDockPosition();
    }

    function setPanelView(view) {
        if (!panel) return;
        const settingsView = view === 'settings';
        panel.querySelector('.bd').hidden = settingsView;
        panel.querySelector('.settings').hidden = !settingsView;
        panel.querySelector('.prog').hidden = settingsView;
        panel.querySelector('[data-role="title"]').textContent = settingsView ? '答题设置' : '答题进度';
        const settingsToggle = panel.querySelector('[data-act="settings"]');
        settingsToggle.textContent = settingsView ? '返回进度' : '设置';
        settingsToggle.setAttribute('aria-expanded', String(settingsView));
        const settingsBtn = document.getElementById('cx-auto-settings-btn');
        if (settingsBtn) settingsBtn.setAttribute('aria-expanded', String(settingsView));
    }

    function populateSettingsForm() {
        panel.querySelector('#cx-setting-provider').value = CONFIG.PROVIDER;
        settingsFormProvider = CONFIG.PROVIDER;
        populateModelOptions(CONFIG.PROVIDER, CONFIG.MODEL);
        panel.querySelector('#cx-setting-key').value = CONFIG.API_KEY;
        updateProviderHelp(CONFIG.PROVIDER);
        panel.querySelector('#cx-setting-start').value = CONFIG.QUESTION_START;
        panel.querySelector('#cx-setting-end').value = CONFIG.QUESTION_END;
        panel.querySelector('#cx-setting-order').value = CONFIG.QUESTION_ORDER;
        panel.querySelector('#cx-setting-delay').value = Math.min(5000, CONFIG.DELAY_BETWEEN_QUESTIONS);
        updateDelayLabel();
    }

    function populateModelOptions(provider, selectedModel) {
        const select = panel.querySelector('#cx-setting-model');
        const info = PROVIDERS[provider];
        select.innerHTML = '';
        info.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = `${model.name} · ${model.id}`;
            select.appendChild(option);
        });
        const customOption = document.createElement('option');
        customOption.value = '__custom__';
        customOption.textContent = '自定义模型 ID / 接入点 ID…';
        select.appendChild(customOption);

        if (info.models.some(model => model.id === selectedModel)) {
            select.value = selectedModel;
            panel.querySelector('#cx-setting-custom-model').value = '';
        } else {
            select.value = '__custom__';
            panel.querySelector('#cx-setting-custom-model').value = selectedModel || '';
        }
        updateCustomModelVisibility();
    }

    function getSettingsFormModel() {
        const modelSelect = panel.querySelector('#cx-setting-model');
        return modelSelect.value === '__custom__'
            ? panel.querySelector('#cx-setting-custom-model').value.trim()
            : modelSelect.value;
    }

    function rememberCurrentProviderForm() {
        if (!panel) return;
        const provider = settingsFormProvider || panel.querySelector('#cx-setting-provider').value;
        if (!PROVIDERS[provider]) return;
        PROVIDER_KEYS[provider] = panel.querySelector('#cx-setting-key').value.trim();
        PROVIDER_MODELS[provider] = getSettingsFormModel();
    }

    function changeSettingsProvider() {
        rememberCurrentProviderForm();
        const provider = panel.querySelector('#cx-setting-provider').value;
        if (!PROVIDERS[provider]) return;
        settingsFormProvider = provider;
        populateModelOptions(provider, PROVIDER_MODELS[provider]);
        panel.querySelector('#cx-setting-key').value = PROVIDER_KEYS[provider] || '';
        updateProviderHelp(provider);
        setSettingsMessage('', false);
    }

    function updateCustomModelVisibility() {
        if (!panel) return;
        const custom = panel.querySelector('#cx-setting-model').value === '__custom__';
        const field = panel.querySelector('[data-role="custom-model-field"]');
        const input = panel.querySelector('#cx-setting-custom-model');
        field.hidden = !custom;
        input.required = custom;
    }

    function updateProviderHelp(provider) {
        if (!panel) return;
        const help = panel.querySelector('[data-role="key-help"]');
        help.textContent = provider === 'deepseek'
            ? '请填写 DeepSeek 开放平台 API Key（platform.deepseek.com）；豆包/火山方舟 Key 不能用于此处。Key 仅保存在本机浏览器用户脚本存储中。'
            : '请填写火山方舟 API Key（console.volcengine.com/ark）；DeepSeek Key 不能用于此处。Key 仅保存在本机浏览器用户脚本存储中。';
    }

    async function testSettingsConnection(event) {
        const button = event.currentTarget;
        const provider = panel.querySelector('#cx-setting-provider').value;
        const model = getSettingsFormModel();
        const apiKey = panel.querySelector('#cx-setting-key').value.trim();
        if (!PROVIDERS[provider] || !model || !apiKey) {
            setSettingsMessage('请先选择模型并填写与服务商匹配的 API Key。', true);
            return;
        }
        button.disabled = true;
        button.textContent = '正在测试…';
        setSettingsMessage('正在向所选服务商发送一次简短测试请求…', false);
        try {
            await requestCompletion(
                provider,
                model,
                apiKey,
                '请只回复 JSON：{"ok":true}',
                128,
                '这是 API 连接测试。请只输出一个简短 JSON 对象，不要输出其他内容。'
            );
            setSettingsMessage(`连接成功：${PROVIDERS[provider].label} / ${model}。设置尚未保存。`, false);
        } catch (error) {
            setSettingsMessage(error.message || '连接失败，请检查配置。', true);
        } finally {
            button.disabled = false;
            button.textContent = '测试连接';
        }
    }

    function updateDelayLabel() {
        if (!panel) return;
        const delay = Number(panel.querySelector('#cx-setting-delay').value) || 0;
        panel.querySelector('#cx-setting-delay-label').textContent = delay ? `（${(delay / 1000).toFixed(1)} 秒）` : '（连续）';
    }

    function setSettingsMessage(message, isError) {
        if (!panel) return;
        const status = panel.querySelector('[data-role="settings-status"]');
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('error', !!isError);
        status.setAttribute('role', isError ? 'alert' : 'status');
        status.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    }

    function saveSettingsFromForm(event) {
        event.preventDefault();
        const providerInput = panel.querySelector('#cx-setting-provider');
        const modelInput = panel.querySelector('#cx-setting-model');
        const customModelInput = panel.querySelector('#cx-setting-custom-model');
        const keyInput = panel.querySelector('#cx-setting-key');
        const startInput = panel.querySelector('#cx-setting-start');
        const endInput = panel.querySelector('#cx-setting-end');
        const provider = providerInput.value;
        const model = getSettingsFormModel();
        const apiKey = keyInput.value.trim();
        const start = Math.floor(Number(startInput.value));
        const end = Math.floor(Number(endInput.value));
        const invalid = [providerInput, modelInput, customModelInput, keyInput, startInput, endInput];
        invalid.forEach(input => input.removeAttribute('aria-invalid'));

        if (!PROVIDERS[provider] || !model || !apiKey || !Number.isFinite(start) || start < 1 || !Number.isFinite(end) || end < 0 || (end > 0 && end < start)) {
            if (!PROVIDERS[provider]) providerInput.setAttribute('aria-invalid', 'true');
            if (!model) (modelInput.value === '__custom__' ? customModelInput : modelInput).setAttribute('aria-invalid', 'true');
            if (!apiKey) keyInput.setAttribute('aria-invalid', 'true');
            if (!Number.isFinite(start) || start < 1) startInput.setAttribute('aria-invalid', 'true');
            if (!Number.isFinite(end) || end < 0 || (end > 0 && end < start)) endInput.setAttribute('aria-invalid', 'true');
            setSettingsMessage('请检查必填项；结束题号须为 0 或不小于开始题号。', true);
            return;
        }

        CONFIG.PROVIDER = provider;
        CONFIG.MODEL = model;
        CONFIG.API_KEY = apiKey;
        settingsFormProvider = provider;
        PROVIDER_KEYS[provider] = apiKey;
        PROVIDER_MODELS[provider] = model;
        CONFIG.QUESTION_START = start;
        CONFIG.QUESTION_END = end;
        CONFIG.QUESTION_ORDER = panel.querySelector('#cx-setting-order').value;
        CONFIG.DELAY_BETWEEN_QUESTIONS = Number(panel.querySelector('#cx-setting-delay').value) || 0;
        const saved = {
            provider: CONFIG.PROVIDER,
            model: CONFIG.MODEL,
            apiKey: CONFIG.API_KEY,
            apiKeys: { ...PROVIDER_KEYS },
            models: { ...PROVIDER_MODELS },
            start: CONFIG.QUESTION_START,
            end: CONFIG.QUESTION_END,
            order: CONFIG.QUESTION_ORDER,
            delay: CONFIG.DELAY_BETWEEN_QUESTIONS
        };
        let persisted = false;
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(SETTINGS_KEY, saved); persisted = true; }
        } catch (e) {}
        if (!persisted) {
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); persisted = true; } catch (e) {}
        }
        setSettingsMessage(persisted ? '设置已保存。' : '本页已应用设置，但浏览器存储不可用，刷新后需重新填写。', !persisted);
    }

    function log(msg, type) {
        if (!body) return;
        if (!CONFIG.VERBOSE && type === 'step') return;
        const row = document.createElement('div');
        row.className = 'row ' + (type || 'step');
        const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        row.innerHTML = `<span class="t">[${t}]</span>${escapeHtml(msg)}`;
        body.appendChild(row);
        // 最多保留 200 条
        while (body.childElementCount > 200) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
    }

    function setProgress(p) {
        if (bar) bar.style.width = Math.max(0, Math.min(100, p)) + '%';
    }

    function flash(el) {
        el.classList.add('cx-auto-flash');
        setTimeout(() => el.classList.remove('cx-auto-flash'), 900);
    }

    function requestStop() {
        stopRequested = true;
        const btn = document.getElementById('cx-auto-btn');
        if (btn) { btn.textContent = '停止中…'; btn.disabled = true; }
        log('已请求停止，等待当前题处理完成…', 'warn');
    }

    function finish() {
        running = false;
        stopRequested = false;
        const btn = document.getElementById('cx-auto-btn');
        if (btn) { btn.disabled = false; btn.textContent = '开始答题'; btn.classList.remove('cx-stop'); }
    }

    // =========================================================
    //  八、启动
    // =========================================================

    function boot() {
        createButton();
        if (CONFIG.AUTO_START) setTimeout(() => { if (!running) start(); }, 2500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    // 页面异步渲染新题时补按钮
    try {
        new MutationObserver(() => {
            if (document.body && (!document.getElementById('cx-auto-dock') ||
                !document.getElementById('cx-auto-btn') || !document.getElementById('cx-auto-settings-btn'))) createButton();
        }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}

    // 暴露给控制台调试
    page.__cxAutoAnswer = { start, collectQuestions, getOptions, getStemText, getQuestionType, getQuestionTypeName, prepareAnswerOptions, CONFIG };

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
