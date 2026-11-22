/**
 * Capacity Trace Chart (Time-Series)
 * Inline SVG time-series chart keeping the last 60s of samples.
 */

(function () {
    'use strict';

    const WINDOW_MS = 60000;
    const VIEW_WIDTH = 600;
    const VIEW_HEIGHT = 140;
    const PAD = { top: 12, right: 12, bottom: 20, left: 12 };
    const PLOT_W = VIEW_WIDTH - PAD.left - PAD.right;
    const PLOT_H = VIEW_HEIGHT - PAD.top - PAD.bottom;
    const BASELINE_Y = VIEW_HEIGHT - 10;

    // Data structures
    let samples = [];       // { time: number, remaining: number, limit: number }
    let requests = [];      // { time: number, allowed: boolean, status: number }
    let currentLimit = null;
    let currentRemaining = null;

    // DOM references
    let svgEl = null;
    let remainingEl = null;
    let limitEl = null;

    function initDOM() {
        svgEl = document.getElementById('traceSvg');
        remainingEl = document.getElementById('traceRemaining');
        limitEl = document.getElementById('traceLimit');

        const rateLimitInput = document.getElementById('rateLimit');
        if (rateLimitInput && rateLimitInput.value) {
            const lim = parseInt(rateLimitInput.value, 10);
            if (!isNaN(lim)) currentLimit = lim;
        }

        const clearBtn = document.getElementById('clearLog');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                samples = [];
                requests = [];
                currentRemaining = null;
                render();
            });
        }
    }

    function pruneOld() {
        const now = Date.now();
        const cutoff = now - WINDOW_MS;

        let lastBeforeIdx = -1;
        for (let i = samples.length - 1; i >= 0; i--) {
            if (samples[i].time < cutoff) {
                lastBeforeIdx = i;
                break;
            }
        }

        if (lastBeforeIdx > 0) {
            samples = samples.slice(lastBeforeIdx);
        } else if (lastBeforeIdx === 0 && samples.length === 1 && samples[0].time < cutoff - WINDOW_MS) {
            samples = [];
        }

        requests = requests.filter(r => r.time >= cutoff);
    }

    function recordResponse(url, status, headers, data) {
        const now = Date.now();
        let remaining = null;
        let limit = null;

        if (headers) {
            const getH = (key) => {
                if (typeof headers.get === 'function') {
                    return headers.get(key) || headers.get(key.toLowerCase());
                }
                return headers[key] || headers[key.toLowerCase()];
            };
            const remH = getH('X-RateLimit-Remaining');
            const limH = getH('X-RateLimit-Limit');
            if (remH !== null && remH !== undefined) remaining = parseInt(remH, 10);
            if (limH !== null && limH !== undefined) limit = parseInt(limH, 10);
        }

        if (data) {
            if (remaining === null && data.remaining !== undefined) {
                remaining = parseInt(data.remaining, 10);
            }
            if (limit === null && data.limit !== undefined) {
                limit = parseInt(data.limit, 10);
            }
        }

        if (limit !== null && !isNaN(limit)) {
            currentLimit = limit;
        }

        const isLimited = typeof url === 'string' && url.includes('/limited');

        if (isLimited) {
            requests.push({
                time: now,
                allowed: status === 200,
                status: status,
            });
        }

        if (remaining !== null && !isNaN(remaining)) {
            currentRemaining = remaining;
            samples.push({
                time: now,
                remaining: remaining,
                limit: currentLimit || 10,
            });
        }

        pruneOld();
        render();
    }

    function render() {
        if (!svgEl) initDOM();
        if (!svgEl) return;

        const now = Date.now();
        const tStart = now - WINDOW_MS;

        // Has active traffic in the last 60 seconds
        const hasTraffic = requests.some(r => r.time >= tStart) ||
                           samples.some(s => s.time >= tStart);

        // Header update
        if (remainingEl) {
            remainingEl.textContent = (hasTraffic && currentRemaining !== null) ? currentRemaining : (currentLimit !== null ? currentLimit : 10);
        }
        if (limitEl) {
            limitEl.textContent = currentLimit !== null ? currentLimit : 10;
        }

        // Empty state: flat idle line with "No traffic yet"
        if (!hasTraffic) {
            const yMid = Math.round(VIEW_HEIGHT / 2);
            svgEl.innerHTML = `
                <line x1="${PAD.left}" y1="${yMid}" x2="${VIEW_WIDTH - PAD.right}" y2="${yMid}" class="trace-idle-line" />
                <text x="${VIEW_WIDTH / 2}" y="${yMid}" class="trace-empty-text" text-anchor="middle" dominant-baseline="central">No traffic yet</text>
            `;
            return;
        }

        // Determine yMax (limit or max remaining)
        const limitVal = currentLimit || 10;
        let yMax = limitVal;
        for (const s of samples) {
            if (s.remaining > yMax) yMax = s.remaining;
        }
        if (yMax <= 0) yMax = 1;

        // Limit dashed line
        const yLimit = PAD.top + (1 - limitVal / yMax) * PLOT_H;

        // Build step line path for remaining
        const visibleSamples = samples.filter(s => s.time >= tStart);
        let d = '';

        if (visibleSamples.length > 0) {
            let initialRem = visibleSamples[0].remaining;
            for (let i = samples.length - 1; i >= 0; i--) {
                if (samples[i].time < tStart) {
                    initialRem = samples[i].remaining;
                    break;
                }
            }

            const y0 = PAD.top + (1 - initialRem / yMax) * PLOT_H;
            d = `M ${PAD.left.toFixed(1)} ${y0.toFixed(1)}`;

            for (const s of visibleSamples) {
                const x = PAD.left + ((s.time - tStart) / WINDOW_MS) * PLOT_W;
                const y = PAD.top + (1 - s.remaining / yMax) * PLOT_H;
                d += ` H ${x.toFixed(1)} V ${y.toFixed(1)}`;
            }

            const xEnd = PAD.left + PLOT_W;
            d += ` H ${xEnd.toFixed(1)}`;
        }

        // Request ticks on baseline
        const visibleRequests = requests.filter(r => r.time >= tStart);
        let ticksSvg = '';
        for (const r of visibleRequests) {
            const x = PAD.left + ((r.time - tStart) / WINDOW_MS) * PLOT_W;
            const cls = r.allowed ? 'tick-allowed' : 'tick-throttled';
            ticksSvg += `<line x1="${x.toFixed(1)}" y1="${BASELINE_Y - 8}" x2="${x.toFixed(1)}" y2="${BASELINE_Y + 2}" class="trace-tick ${cls}" />`;
        }

        svgEl.innerHTML = `
            <line x1="${PAD.left}" y1="${yLimit.toFixed(1)}" x2="${(PAD.left + PLOT_W).toFixed(1)}" y2="${yLimit.toFixed(1)}" class="trace-limit-line" />
            <line x1="${PAD.left}" y1="${BASELINE_Y}" x2="${(PAD.left + PLOT_W).toFixed(1)}" y2="${BASELINE_Y}" class="trace-baseline" />
            ${d ? `<path d="${d}" class="trace-step-line" />` : ''}
            ${ticksSvg}
        `;
    }

    // Intercept fetch API to observe responses
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const url = args[0] instanceof Request ? args[0].url : String(args[0]);
            const status = response.status;
            const headers = response.headers;

            if (url.includes('/limited')) {
                response.clone().json().then(data => {
                    recordResponse(url, status, headers, data);
                }).catch(() => {
                    recordResponse(url, status, headers, null);
                });
            } else if (url.includes('/status/')) {
                if (args[1] && args[1].method === 'DELETE') {
                    samples = [];
                    requests = [];
                    currentRemaining = null;
                    render();
                }
            } else if (url.includes('/config')) {
                response.clone().json().then(data => {
                    if (data && data.max_requests) {
                        currentLimit = data.max_requests;
                        render();
                    }
                }).catch(() => {});
            }
        } catch (e) {
            // Keep transparent
        }
        return response;
    };

    // Public API
    window.TraceChart = {
        record: recordResponse,
        render: render,
        reset: function () {
            samples = [];
            requests = [];
            currentRemaining = null;
            render();
        },
        getData: function () {
            return { samples: [...samples], requests: [...requests], currentLimit, currentRemaining };
        }
    };

    // Initialize ticker & DOM
    document.addEventListener('DOMContentLoaded', () => {
        initDOM();
        render();
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initDOM();
        render();
    }

    // 100ms update loop
    setInterval(() => {
        pruneOld();
        render();
    }, 100);

})();
