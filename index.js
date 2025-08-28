/**
 * SillyTavern API空内容重试插件
 * 专注于检测并重试空内容的API响应
 */

(() => {
    'use strict';

    const EXTENSION_NAME = 'ST-API-Retry-Plugin';
    const EXTENSION_DISPLAY_NAME = 'API空内容重试插件';

    // 导入SillyTavern API
    let extension_settings, saveSettingsDebounced;
    let toastr, eventSource, event_types;
    let callGenericPopup, POPUP_TYPE;
    let getTokenCountAsyncFn;

    // 默认设置
    const DEFAULT_SETTINGS = {
        enabled: true,
        maxRetries: 3,
        baseDelay: 1000,        // 基础延迟(毫秒)
        enableLogging: true,    // 启用日志
        minContentLength: 5,    // 最小内容长度
        checkWhitespace: true,  // 检查空白字符
        interceptRules: [],     // API拦截规则（为空：不拦截）
        enableMinTokenRetry: true, // 启用少于Token阈值的重试（默认开启）
        minTokenThreshold: 400, // Token阈值（默认400）
        // 默认无拦截规则（白名单模式，需要手动添加）
        interceptRules: []
    };

    let settings = {};
    let originalFetch = null;

    // 检查响应是否为空内容
    function isEmptyContent(text) {
        if (!text || text === null || text === undefined) {
            return true;
        }

        // 转换为字符串
        const content = String(text).trim();

        // 检查长度
        if (content.length < settings.minContentLength) {
            return true;
        }

        // 检查是否只包含空白字符
        if (settings.checkWhitespace && content.replace(/\s/g, '').length === 0) {
            return true;
        }

        return false;
    }

    // 延迟函数（可感知 AbortSignal）
    function delay(ms, signal) {
        if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
        if (signal.aborted) {
            // 立即以 AbortError 结束
            throw new DOMException('Aborted', 'AbortError');
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                cleanup();
                reject(new DOMException('Aborted', 'AbortError'));
            };
            const cleanup = () => {
                try { signal.removeEventListener('abort', onAbort); } catch {}
            };
            try { signal.addEventListener('abort', onAbort, { once: true }); } catch {}
        });
    }

    // 计算重试延迟（固定间隔，不使用指数退避）
    function calculateDelay(attempt) {
        return Number(settings.baseDelay) || 0;
    }

    function isAbortError(error) {
        if (!error) return false;
        // 标准 Fetch AbortError
        if (error.name === 'AbortError') return true;
        // 一些环境中仅 message 含有 aborted/canceled
        const msg = String(error.message || error.toString() || '').toLowerCase();
        return msg.includes('aborted') || msg.includes('abort') || msg.includes('canceled') || msg.includes('cancelled');
    }

    // 记录日志
    function log(message, isError = false) {
        if (settings.enableLogging) {
            const prefix = `[${EXTENSION_NAME}]`;
            if (isError) {
                console.error(prefix, message);
            } else {
                console.log(prefix, message);
            }
        }
    }

    // 显示Toast通知
    function showNotification(message, type = 'info') {
        if (typeof toastr !== 'undefined') {
            toastr[type](message, 'API重试插件');
        }
    }

    // 从常见的API响应JSON中提取候选文本内容
    function extractResponseContent(rawText) {
        try {
            const obj = JSON.parse(rawText);
            let parts = [];

            // OpenAI风格
            if (Array.isArray(obj?.choices)) {
                for (const ch of obj.choices) {
                    if (typeof ch?.message?.content === 'string') parts.push(ch.message.content);
                    if (typeof ch?.delta?.content === 'string') parts.push(ch.delta.content);
                    if (typeof ch?.text === 'string') parts.push(ch.text);
                }
            }

            // 一些推理或文本生成接口
            if (Array.isArray(obj?.results)) {
                for (const r of obj.results) {
                    if (typeof r?.text === 'string') parts.push(r.text);
                    if (typeof r?.content === 'string') parts.push(r.content);
                    if (typeof r?.output_text === 'string') parts.push(r.output_text);
                }
            }

            // 常见字段回退
            const fallbackKeys = ['message', 'content', 'response', 'output_text', 'generated_text'];
            for (const k of fallbackKeys) {
                if (typeof obj?.[k] === 'string') parts.push(obj[k]);
            }

            if (Array.isArray(obj?.data) && typeof obj.data[0]?.text === 'string') {
                parts.push(obj.data[0].text);
            }

            const joined = parts.filter(Boolean).join('\n');
            return joined || null;
        } catch {
            return null;
        }
    }

    function showRetryToast(nextAttempt, totalAttempts, delayMs) {
        if (typeof toastr !== 'undefined') {
            const msg = `重试第 ${nextAttempt}/${totalAttempts} 次，等待 ${delayMs}ms...`;
            toastr.info(msg, '正在重试');
        }
    }

    async function getTokenCountFor(text) {
        try {
            if (typeof getTokenCountAsyncFn === 'function') {
                return await getTokenCountAsyncFn(String(text || ''), 0);
            }
        } catch (e) {
            // ignore and fallback
        }
        // 退化估算: 使用与ST一致的字符/Token比率
        const ratio = 3.35;
        const s = String(text || '');
        return Math.ceil(s.length / ratio);
    }

    // 判断是否需要拦截某个请求
    function matchesRule(url, rule) {
        if (!rule || typeof rule !== 'string') return false;
        // 正则规则：以 / 开头且以 / 结尾
        if (rule.length >= 2 && rule.startsWith('/') && rule.endsWith('/')) {
            try {
                const re = new RegExp(rule.slice(1, -1));
                return re.test(url);
            } catch (e) {
                // 无效正则则忽略
                return false;
            }
        }
        // 子串匹配（大小写不敏感，包含即匹配）
        try {
            return String(url).toLowerCase().includes(String(rule).toLowerCase());
        } catch {
            return false;
        }
    }

    function shouldIntercept(url) {
        const rules = Array.isArray(settings.interceptRules) ? settings.interceptRules : [];
        if (!rules.length) {
            // 规则为空：不拦截任何请求（白名单模式）
            return false;
        }
        return rules.some(rule => matchesRule(url, rule));
    }

    // 增强的fetch函数
    async function enhancedFetch(url, options = {}) {
        if (!settings.enabled) {
            return originalFetch(url, options);
        }

        // 未命中拦截规则：直接透传
        try {
            const u = typeof url === 'string' ? url : (url?.url || String(url));
            if (!shouldIntercept(u)) {
                return originalFetch(url, options);
            }
        } catch (e) {
            // URL 解析失败则按不拦截处理
            return originalFetch(url, options);
        }

        let lastError = null;
        const abortSignal = options && options.signal ? options.signal : undefined;

        for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
            try {
                // 若已被中断，直接停止重试
                if (abortSignal?.aborted) {
                    log(`请求已被中断，停止重试: ${url}`);
                    throw new DOMException('Aborted', 'AbortError');
                }
                log(`尝试请求 ${url} (第${attempt + 1}次)`);

                const response = await originalFetch(url, options);

                // 检查响应状态
                if (!response.ok) {
                    // 尝试附加原始错误正文
                    try {
                        const errClone = response.clone();
                        const errText = await errClone.text();
                        const httpError = new Error(`HTTP ${response.status}: ${response.statusText}\n${errText || ''}`.trim());
                        httpError.status = response.status;
                        httpError.statusText = response.statusText;
                        httpError.body = errText;
                        throw httpError;
                    } catch (e) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                }

                // 克隆响应以便检查内容
                const clonedResponse = response.clone();
                let text;

                try {
                    text = await clonedResponse.text();
                } catch (e) {
                    // 如果无法读取文本，返回原响应
                    return response;
                }

                // 检查是否为空内容或低Token
                let treatAsEmpty = isEmptyContent(text);
                if (!treatAsEmpty && settings.enableMinTokenRetry) {
                    const candidate = extractResponseContent(text) ?? text;
                    const tokens = await getTokenCountFor(candidate);
                    if (tokens < Number(settings.minTokenThreshold || 0)) {
                        treatAsEmpty = true;
                        log(`检测到Token过少: ${tokens} < ${settings.minTokenThreshold}`);
                    }
                }

                if (treatAsEmpty) {
                    if (attempt < settings.maxRetries) {
                        const delayMs = calculateDelay(attempt);
                        log(`检测到空内容，${delayMs}ms后重试`, true);
                        showRetryToast(attempt + 2, settings.maxRetries + 1, delayMs);
                        await delay(delayMs, abortSignal);
                        continue;
                    } else {
                        // 重试全部失败：显示内置错误弹窗并抛出错误
                        const msg = `检测到空内容，已连续 ${settings.maxRetries + 1} 次尝试无有效响应。`;
                        log(`达到最大重试次数：${msg}`, true);
                        // 若为中断，不弹出错误
                        if (!abortSignal?.aborted) {
                            showBuiltinError(msg);
                        }
                        throw new Error(msg);
                    }
                } else {
                    if (attempt > 0) {
                        log(`第${attempt + 1}次尝试成功获得内容`);
                        showNotification(`重试成功获得响应`, 'success');
                    }
                }

                return response;

            } catch (error) {
                lastError = error;
                log(`请求失败: ${error.message}`, true);
                // 中断：立即抛出，不再重试，也不弹窗
                if (isAbortError(error) || abortSignal?.aborted) {
                    throw error;
                }
                if (attempt < settings.maxRetries) {
                    const delayMs = calculateDelay(attempt);
                    log(`${delayMs}ms后重试`);
                    showRetryToast(attempt + 2, settings.maxRetries + 1, delayMs);
                    await delay(delayMs, abortSignal);
                }
            }
        }

        // 所有重试都失败了
        log(`所有重试尝试失败，抛出最后一个错误`, true);
        const err = lastError || new Error('重试次数已达上限');
        // 发生中断：直接抛出，不显示弹窗
        if (!isAbortError(err) && !(abortSignal?.aborted)) {
            // 使用酒馆自带弹窗显示原始错误
            showBuiltinError(err && (err.stack || err.message || String(err)));
        }
        throw err;
    }

    // 显示酒馆自带的错误弹窗
    function showBuiltinError(message) {
        if (!message) return;
        try {
            if (typeof callGenericPopup === 'function' && POPUP_TYPE) {
                callGenericPopup(String(message), POPUP_TYPE.TEXT, '请求失败');
            } else if (typeof toastr !== 'undefined') {
                toastr.error(String(message), '请求失败');
            } else {
                console.error(`[${EXTENSION_NAME}]`, message);
            }
        } catch (e) {
            console.error(`[${EXTENSION_NAME}] 显示错误弹窗失败:`, e);
            try { toastr?.error(String(message), '请求失败'); } catch {}
        }
    }

    // 加载设置
    function loadSettings() {
        // 不要在这里写回 extension_settings，避免覆盖主程序稍后异步加载的持久化值
        // 仅读取并合并到本地 settings
        let persisted = {};
        try {
            // 兼容早期兜底的 localStorage
            const raw = localStorage.getItem('sillytavern_extension_settings');
            if (raw) {
                const obj = JSON.parse(raw);
                if (obj && obj[EXTENSION_NAME] && typeof obj[EXTENSION_NAME] === 'object') {
                    persisted = { ...obj[EXTENSION_NAME] };
                }
            }
        } catch {}

        if (extension_settings && extension_settings[EXTENSION_NAME]) {
            persisted = { ...persisted, ...extension_settings[EXTENSION_NAME] };
        }

        settings = { ...DEFAULT_SETTINGS, ...persisted };
    }

    // 保存设置
    function saveSettings() {
        extension_settings[EXTENSION_NAME] = { ...settings };
        if (saveSettingsDebounced) {
            saveSettingsDebounced();
        }
    }

    // 创建设置UI
    function createSettingsUI() {
        const settingsHtml = `
            <style>
                /* Scope button layout fixes to this extension only */
                #${EXTENSION_NAME}-settings .menu_button {
                    width: auto !important;
                    white-space: nowrap !important;
                    display: inline-flex;
                }
            </style>
            <div id="${EXTENSION_NAME}-settings">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>API空内容重试设置</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content" style="display: none;">
                        <div class="flex-container flexFlowColumn">
                            <label class="checkbox_label">
                                <input id="retry-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                                <span>启用空内容重试</span>
                            </label>

                            <div class="range-block">
                                <div class="range-block-title">最大重试次数: <span id="retry-count-value">${settings.maxRetries}</span></div>
                                <input id="retry-count" type="range" min="1" max="40" step="1" value="${settings.maxRetries}">
                            </div>

                            <div class="range-block">
                                <div class="range-block-title">基础延迟(毫秒): <span id="base-delay-value">${settings.baseDelay}</span></div>
                                <input id="base-delay" type="range" min="500" max="5000" step="100" value="${settings.baseDelay}">
                            </div>

                            

                            <label class="checkbox_label">
                                <input id="check-whitespace" type="checkbox" ${settings.checkWhitespace ? 'checked' : ''}>
                                <span>检查纯空白字符内容</span>
                            </label>

                            <label class="checkbox_label">
                                <input id="enable-logging" type="checkbox" ${settings.enableLogging ? 'checked' : ''}>
                                <span>启用控制台日志</span>
                            </label>

                            <div class="range-block">
                                <label class="checkbox_label">
                                    <input id="enable-token-threshold" type="checkbox" ${settings.enableMinTokenRetry ? 'checked' : ''}>
                                    <span>少于 Token 阈值时重试</span>
                                </label>
                                <div class="range-block-title">Token 阈值: <span id="token-threshold-value">${settings.minTokenThreshold}</span></div>
                                <input id="token-threshold" type="number" min="1" step="1" value="${settings.minTokenThreshold}" class="text_pole" style="max-width: 120px;">
                                <small class="notes">使用当前模型的分词器估算，未可用时采用字符比率估算。</small>
                            </div>

                            <hr class="menu_divider">

                            <div class="range-block-title">API拦截管理</div>
                            <small class="notes">仅当请求 URL 匹配以下任一规则时才应用重试。规则以 /.../ 形式可使用正则；否则为不区分大小写的“包含”匹配（如：URL 为 https://FF.exmaple.xyz/v1，规则写 FF.exmaple 或 FF 均可匹配）。未配置规则时，不拦截任何请求。</small>
                            <div class="flex-container" style="gap: 8px; align-items: center; margin-top: 6px;">
                                <input id="intercept-pattern" type="text" class="text_pole" placeholder="例如：/api/chat/ 或 /\\/api\\/openai\\//">
                                <button id="add-intercept-rule" class="menu_button">添加规则</button>
                            </div>
                            <ul id="intercept-rules-list" class="list-group" style="margin-top: 8px;"></ul>

                            <div class="flex-container" style="display:flex; flex-direction:row; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;">
                                <button id="retry-test" class="menu_button" style="width:auto; white-space:nowrap;">测试重试功能</button>
                                <button id="insert-default-rule" class="menu_button" style="width:auto; white-space:nowrap;">插入默认规则</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        return settingsHtml;
    }

    // 绑定设置事件
    function bindSettingsEvents() {
        // 将 settings 应用到UI，不触发保存
        function applySettingsToUI() {
            try {
                $('#retry-enabled').prop('checked', !!settings.enabled);
                $('#retry-count').val(Number(settings.maxRetries));
                $('#retry-count-value').text(String(settings.maxRetries));
                $('#base-delay').val(Number(settings.baseDelay));
                $('#base-delay-value').text(String(settings.baseDelay));
                $('#check-whitespace').prop('checked', !!settings.checkWhitespace);
                $('#enable-logging').prop('checked', !!settings.enableLogging);
                $('#enable-token-threshold').prop('checked', !!settings.enableMinTokenRetry);
                $('#token-threshold').val(Number(settings.minTokenThreshold));
                $('#token-threshold-value').text(String(settings.minTokenThreshold));
                updateTokenInputsState();
            } catch {}
        }
        // 开关切换
        $('#retry-enabled').on('change', function() {
            settings.enabled = this.checked;
            saveSettings();
            showNotification(`重试功能已${this.checked ? '启用' : '禁用'}`, 'info');
        });

        // 滑块事件
        $('#retry-count').on('input', function() {
            settings.maxRetries = parseInt(this.value);
            $('#retry-count-value').text(this.value);
            saveSettings();
        });

        $('#base-delay').on('input', function() {
            settings.baseDelay = parseInt(this.value);
            $('#base-delay-value').text(this.value);
            saveSettings();
        });

        
        // 复选框事件
        $('#check-whitespace').on('change', function() {
            settings.checkWhitespace = this.checked;
            saveSettings();
        });

        $('#enable-logging').on('change', function() {
            settings.enableLogging = this.checked;
            saveSettings();
        });

        // Token 阈值
        function updateTokenInputsState() {
            const enabled = !!settings.enableMinTokenRetry;
            $('#token-threshold').prop('disabled', !enabled);
        }

        $('#enable-token-threshold').on('change', function() {
            settings.enableMinTokenRetry = this.checked;
            saveSettings();
            updateTokenInputsState();
        });

        $('#token-threshold').on('input', function() {
            const v = Math.max(1, parseInt(this.value || '1'));
            settings.minTokenThreshold = v;
            $('#token-threshold-value').text(String(v));
            saveSettings();
        });

        // 初始化一次，确保禁用状态与勾选同步
        updateTokenInputsState();

        // 渲染拦截规则列表
        function renderRules() {
            const list = $('#intercept-rules-list');
            list.empty();
            const rules = Array.isArray(settings.interceptRules) ? settings.interceptRules : [];
            if (!rules.length) {
                list.append('<li class="list-group-item">未配置规则（当前不拦截任何请求）</li>');
                return;
            }
            rules.forEach((rule, idx) => {
                const item = $(`
                    <li class="list-group-item" data-index="${idx}">
                        <span class="rule-text">${$('<div>').text(rule).html()}</span>
                        <div style="float:right; display:flex; gap:6px;">
                            <button class="menu_button small edit-rule">编辑</button>
                            <button class="menu_button small delete-rule">删除</button>
                        </div>
                    </li>
                `);
                list.append(item);
            });
        }

        renderRules();
        applySettingsToUI();

        // 一次延迟同步，避免主程序稍后载入的持久化值未就绪
        setTimeout(() => { loadSettings(); applySettingsToUI(); }, 500);

        // 添加规则
        $('#add-intercept-rule').on('click', function() {
            const val = String($('#intercept-pattern').val() || '').trim();
            if (!val) return;
            settings.interceptRules = Array.isArray(settings.interceptRules) ? settings.interceptRules : [];
            settings.interceptRules.push(val);
            saveSettings();
            $('#intercept-pattern').val('');
            renderRules();
            showNotification('已添加拦截规则', 'success');
        });

        // 编辑/删除规则（事件委托）
        $('#intercept-rules-list').on('click', '.delete-rule', function() {
            const idx = parseInt($(this).closest('li').attr('data-index'));
            if (Number.isInteger(idx)) {
                settings.interceptRules.splice(idx, 1);
                saveSettings();
                renderRules();
            }
        });

        $('#intercept-rules-list').on('click', '.edit-rule', function() {
            const li = $(this).closest('li');
            const idx = parseInt(li.attr('data-index'));
            const oldVal = settings.interceptRules[idx];
            const newVal = prompt('编辑规则（/.../ 为正则，否则为子串匹配）', oldVal);
            if (newVal != null) {
                const v = String(newVal).trim();
                if (v) {
                    settings.interceptRules[idx] = v;
                    saveSettings();
                    renderRules();
                }
            }
        });

        // 测试按钮
        $('#retry-test').on('click', function() {
            showNotification('重试功能测试：模拟一次空内容响应的重试', 'info');
            log('用户触发了重试功能测试');
        });

        // 重置按钮
        // 插入默认规则（不刷新页面）
        $('#insert-default-rule').on('click', function() {
            const defaultRule = '/chat-completions/generate';
            const rules = Array.isArray(settings.interceptRules) ? settings.interceptRules : [];
            const exists = rules.some(r => String(r).toLowerCase() === defaultRule.toLowerCase());
            if (!exists) {
                rules.push(defaultRule);
                settings.interceptRules = rules;
                saveSettings();
                renderRules();
                showNotification(`已插入默认规则: ${defaultRule}`, 'success');
            } else {
                showNotification(`默认规则已存在: ${defaultRule}`, 'info');
            }
        });
    }

    // 初始化函数
    function init() {
        // 保存原始fetch
        if (!originalFetch) {
            originalFetch = window.fetch;
        }

        // 加载设置
        loadSettings();

        // 替换fetch函数
        window.fetch = enhancedFetch;

        log('API空内容重试插件已初始化');
    }

    // 卸载函数
    function cleanup() {
        if (originalFetch) {
            window.fetch = originalFetch;
            log('已恢复原始fetch函数');
        }
    }

    // 初始化插件
    function initializePlugin() {
        // 如果已经初始化过，先清理
        if (window[`${EXTENSION_NAME}_initialized`]) {
            cleanup();
        }

        // 初始化插件
        init();

        // 标记已初始化
        window[`${EXTENSION_NAME}_initialized`] = true;

        // 监听页面卸载，清理资源
        window.addEventListener('beforeunload', cleanup);
    }

    // 创建设置UI的函数
    function setupUI() {
        const settingsUI = createSettingsUI();

        function tryAppend(attempt = 0) {
            if (document.getElementById(`${EXTENSION_NAME}-settings`)) {
                // 已经插入过，避免重复
                return;
            }

            const container = document.querySelector('#extensions_settings');
            if (container) {
                container.insertAdjacentHTML('beforeend', settingsUI);

                bindSettingsEvents();
                log('设置UI已加载');
            } else if (attempt < 50) {
                // 容器未准备好，稍后重试
                setTimeout(() => tryAppend(attempt + 1), 200);
            } else {
                log('扩展设置容器未找到，放弃添加UI', true);
            }
        }

        tryAppend();
    }

    // 插件入口点
    jQuery(async () => {
        try {
            // 直接导入核心模块以获得权威的设置对象与保存函数
            const [extensionsModule, scriptModule] = await Promise.all([
                import('/scripts/extensions.js'),
                import('/script.js'),
            ]);

            extension_settings = extensionsModule.extension_settings || window.extension_settings || {};
            saveSettingsDebounced = scriptModule.saveSettingsDebounced || window.saveSettingsDebounced || (() => {});
            toastr = window.toastr;

            // 弹窗和分词器
            try {
                const popupModule = await import('/scripts/popup.js');
                callGenericPopup = popupModule.callGenericPopup;
                POPUP_TYPE = popupModule.POPUP_TYPE;
            } catch (e) {
                log('无法导入内置弹窗模块，退回到toastr错误提示', true);
            }

            try {
                const tokenizersModule = await import('/scripts/tokenizers.js');
                getTokenCountAsyncFn = tokenizersModule.getTokenCountAsync;
            } catch (e) {
                log('无法导入分词器模块，将使用近似估算', true);
            }
        } catch (e) {
            // 极端情况下的兜底
            log('导入核心模块失败，启用兜底方案', true);
            extension_settings = window.extension_settings || {};
            saveSettingsDebounced = function() {
                try { localStorage.setItem('sillytavern_extension_settings', JSON.stringify(extension_settings)); } catch {}
            };
            toastr = window.toastr || {
                info: (msg) => console.log('[INFO]', msg),
                success: (msg) => console.log('[SUCCESS]', msg),
                error: (msg) => console.error('[ERROR]', msg)
            };
        }

        // 初始化插件与UI
        initializePlugin();
        setupUI();
    });

})();
