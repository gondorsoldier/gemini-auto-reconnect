// ==UserScript==
// @name         Gemini Auto Reconnect v3.2-optimized
// @namespace    http://tampermonkey.net/
// @version      3.2.0
// @description  代理断线保持页面，恢复后重建推送通道
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 核心 API，失败才意味着真正断线
    const CORE_PATTERNS = [
        'batchexecute',
        'play.google.com/log',
    ];

    // 可以直接丢弃的非核心/追踪请求
    const DROP_PATTERNS = [
        'signaler-pa.clients6.google.com',
        'jserror',
        'cleardot.gif',
        'google-analytics.com',
        'googleadservices.com',
    ];

    const PROBE_URL = 'https://gemini.google.com/favicon.ico';
    const CHECK_INTERVAL = 3000;
    const MAX_PENDING = 30;

    let isOffline = !navigator.onLine; // 结合原生状态初始化
    let pendingFetches = [];
    
    // 监听原生网络状态变化加速恢复
    window.addEventListener('offline', () => setOfflineStatus(true));
    window.addEventListener('online', () => triggerProbe());

    function matchesAny(url, patterns) {
        return url ? patterns.some(p => url.includes(p)) : false;
    }

    function setOfflineStatus(status) {
        if (isOffline !== status) {
            isOffline = status;
            console.log(`[v3.2.0] 网络状态切换为: ${status ? '断开离线' : '恢复在线'}`);
            if (!status) flushAll();
        }
    }

    // ── 1. 拦截 XHR (简化为只丢弃不排队，防止内存泄漏) ────────────
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OrigXHR();
        let _url;

        xhr.open = function(method, url, ...rest) {
            _url = url;
            return OrigXHR.prototype.open.call(xhr, method, url, ...rest);
        };

        xhr.send = function(body) {
            xhr.addEventListener('error', () => {
                // 仅核心 API 报错才判定断线，防止去广告插件误伤
                if (!isOffline && matchesAny(_url, CORE_PATTERNS)) {
                    setOfflineStatus(true);
                }
            });

            if (isOffline && matchesAny(_url, [...CORE_PATTERNS, ...DROP_PATTERNS])) {
                console.log('[v3.2.0] 离线状态，拦截丢弃XHR:', (_url || '').slice(0, 70));
                setTimeout(() => {
                    try { xhr.dispatchEvent(new ProgressEvent('abort')); } catch(e) {}
                }, 10);
                return;
            }
            return OrigXHR.prototype.send.call(xhr, body);
        };
        return xhr;
    };
    window.XMLHttpRequest.prototype = OrigXHR.prototype;

    // ── 2. 拦截 fetch ─────────────────────────────────────────────
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input?.url || '');

        if (isOffline) {
            if (matchesAny(url, DROP_PATTERNS)) {
                return Promise.resolve(new Response('', {status: 200}));
            }
            if (matchesAny(url, CORE_PATTERNS)) {
                if (pendingFetches.length >= MAX_PENDING) {
                    console.log('[v3.2.0] 挂起队列已满，丢弃fetch:', url.slice(0, 60));
                    return Promise.reject(new Error('Queue full'));
                }
                console.log('[v3.2.0] 挂起fetch:', url.slice(0, 70));
                return new Promise((resolve, reject) => {
                    pendingFetches.push({input, init, resolve, reject});
                });
            }
        }

        return origFetch(input, init).catch(err => {
            if (!isOffline && matchesAny(url, CORE_PATTERNS)) {
                setOfflineStatus(true);
            }
            throw err;
        });
    };

    // ── 3. 定期探测恢复 ───────────────────────────────────────────
    let probeTimer = setInterval(() => {
        if (isOffline) triggerProbe();
    }, CHECK_INTERVAL);

    async function triggerProbe() {
        if (!isOffline) return;
        try {
            // 加入时间戳强制穿透代理层缓存
            await origFetch(`${PROBE_URL}?t=${Date.now()}`, {
                method: 'HEAD',
                cache: 'no-store',
                mode: 'no-cors'
            });
            setOfflineStatus(false);
        } catch(e) { /* 仍未恢复 */ }
    }

    // ── 4. 恢复处理与通道重建 ─────────────────────────────────────
    function flushAll() {
        const fetches = [...pendingFetches];
        pendingFetches = [];
        
        // 重发队列
        fetches.forEach(({input, init, resolve, reject}) => {
            console.log('[v3.2.0] 重发请求:', typeof input === 'string' ? input.slice(0, 60) : 'Request object');
            origFetch(input, init).then(resolve).catch(reject);
        });

        setTimeout(() => {
            console.log('[v3.2.0] 触发通道重建...');
            
            // 记录当前的真实状态
            const originalVisibility = document.visibilityState;
            
            // 伪装为隐藏
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'hidden', configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));

            setTimeout(() => {
                // 还原为真实的可见状态，而不是硬编码的 'visible'
                Object.defineProperty(document, 'visibilityState', {
                    get: () => originalVisibility, configurable: true
                });
                document.dispatchEvent(new Event('visibilitychange'));
                console.log('[v3.2.0] 通道重建完成');
            }, 500);
        }, 1000);
    }

    console.log('[v3.2.0] Gemini Auto Reconnect 已加载');
})();