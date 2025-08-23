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

    // 默认设置
    const DEFAULT_SETTINGS = {
        enabled: true,
        maxRetries: 3,
        baseDelay: 1000,        // 基础延迟(毫秒)
        enableLogging: true,    // 启用日志
        minContentLength: 5,    // 最小内容长度
        checkWhitespace: true   // 检查空白字符
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

    // 延迟函数
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 计算重试延迟 (指数退避)
    function calculateDelay(attempt) {
        return settings.baseDelay * Math.pow(2, attempt);
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

    // 增强的fetch函数
    async function enhancedFetch(url, options = {}) {
        if (!settings.enabled) {
            return originalFetch(url, options);
        }
        
        let lastError = null;
        
        for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
            try {
                log(`尝试请求 ${url} (第${attempt + 1}次)`);
                
                const response = await originalFetch(url, options);
                
                // 检查响应状态
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
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
                
                // 检查是否为空内容
                if (isEmptyContent(text)) {
                    if (attempt < settings.maxRetries) {
                        const delayMs = calculateDelay(attempt);
                        log(`检测到空内容，${delayMs}ms后重试`, true);
                        await delay(delayMs);
                        continue;
                    } else {
                        log(`达到最大重试次数，返回空响应`, true);
                        showNotification(`API请求${settings.maxRetries + 1}次均返回空内容`, 'error');
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
                
                if (attempt < settings.maxRetries) {
                    const delayMs = calculateDelay(attempt);
                    log(`${delayMs}ms后重试`);
                    await delay(delayMs);
                }
            }
        }
        
        // 所有重试都失败了
        log(`所有重试尝试失败，抛出最后一个错误`, true);
        throw lastError || new Error('重试次数已达上限');
    }

    // 加载设置
    function loadSettings() {
        if (!extension_settings[EXTENSION_NAME]) {
            extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
        }
        settings = { ...DEFAULT_SETTINGS, ...extension_settings[EXTENSION_NAME] };
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
            <div id="${EXTENSION_NAME}-settings">
                <div class="inline-drawer">
                    <div class="inline-drawer-header">
                        <b>API空内容重试设置</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
                    </div>
                    <div class="inline-drawer-content" style="display: block;">
                        <div class="flex-container flexFlowColumn">
                            <label class="checkbox_label">
                                <input id="retry-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                                <span>启用空内容重试</span>
                            </label>
                            
                            <div class="range-block">
                                <div class="range-block-title">最大重试次数: <span id="retry-count-value">${settings.maxRetries}</span></div>
                                <input id="retry-count" type="range" min="1" max="10" step="1" value="${settings.maxRetries}">
                            </div>
                            
                            <div class="range-block">
                                <div class="range-block-title">基础延迟(毫秒): <span id="base-delay-value">${settings.baseDelay}</span></div>
                                <input id="base-delay" type="range" min="500" max="5000" step="100" value="${settings.baseDelay}">
                            </div>
                            
                            <div class="range-block">
                                <div class="range-block-title">最小内容长度: <span id="min-length-value">${settings.minContentLength}</span></div>
                                <input id="min-length" type="range" min="1" max="50" step="1" value="${settings.minContentLength}">
                            </div>
                            
                            <label class="checkbox_label">
                                <input id="check-whitespace" type="checkbox" ${settings.checkWhitespace ? 'checked' : ''}>
                                <span>检查纯空白字符内容</span>
                            </label>
                            
                            <label class="checkbox_label">
                                <input id="enable-logging" type="checkbox" ${settings.enableLogging ? 'checked' : ''}>
                                <span>启用控制台日志</span>
                            </label>
                            
                            <div class="flex-container">
                                <button id="retry-test" class="menu_button">测试重试功能</button>
                                <button id="retry-reset" class="menu_button">重置为默认</button>
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
        
        $('#min-length').on('input', function() {
            settings.minContentLength = parseInt(this.value);
            $('#min-length-value').text(this.value);
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
        
        // 测试按钮
        $('#retry-test').on('click', function() {
            showNotification('重试功能测试：模拟一次空内容响应的重试', 'info');
            log('用户触发了重试功能测试');
        });
        
        // 重置按钮
        $('#retry-reset').on('click', function() {
            if (confirm('确定要重置所有设置为默认值吗？')) {
                settings = { ...DEFAULT_SETTINGS };
                saveSettings();
                location.reload();
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

                // 点击标题切换折叠
                const header = container.querySelector(`#${EXTENSION_NAME}-settings .inline-drawer-header`);
                const content = container.querySelector(`#${EXTENSION_NAME}-settings .inline-drawer-content`);
                const icon = container.querySelector(`#${EXTENSION_NAME}-settings .inline-drawer-icon`);
                if (header && content) {
                    header.addEventListener('click', () => {
                        const isHidden = content.style.display === 'none';
                        content.style.display = isHidden ? 'block' : 'none';
                        if (icon) icon.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
                    });
                }

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
        // 等待SillyTavern基础API加载
        let attempts = 0;
        const maxAttempts = 100;
        
        while (attempts < maxAttempts) {
            try {
                // 尝试获取必要的SillyTavern对象
                if (typeof window.extension_settings !== 'undefined' && 
                    typeof window.saveSettingsDebounced !== 'undefined') {
                    
                    extension_settings = window.extension_settings;
                    saveSettingsDebounced = window.saveSettingsDebounced;
                    toastr = window.toastr;
                    break;
                }
            } catch (e) {
                log(`等待SillyTavern API中... (尝试 ${attempts + 1}/${maxAttempts})`);
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (attempts >= maxAttempts) {
            // 如果无法获取SillyTavern API，使用兜底方案
            log('无法获取SillyTavern API，使用兜底存储方案', true);
            extension_settings = window.extension_settings || {};
            saveSettingsDebounced = function() {
                localStorage.setItem('sillytavern_extension_settings', JSON.stringify(extension_settings));
            };
            toastr = window.toastr || {
                info: (msg) => console.log('[INFO]', msg),
                success: (msg) => console.log('[SUCCESS]', msg),
                error: (msg) => console.error('[ERROR]', msg)
            };
        }
        
        // 初始化插件
        initializePlugin();
        
        // 设置UI
        setupUI();
    });

})();
