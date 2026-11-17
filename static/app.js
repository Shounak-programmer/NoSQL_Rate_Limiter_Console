/**
 * Rate Limiter Console — Application Logic
 * Talks to FastAPI backend at http://localhost:8000
 */

(function () {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────
    const API_BASE = window.location.origin || 'http://localhost:8000';

    // ── DOM References ─────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const dom = {
        // Header
        statusDot:       $('#statusDot'),
        statusText:      $('#statusText'),
        currentAlgo:     $('#currentAlgo'),

        // Config controls
        algorithm:       $('#algorithm'),
        rateLimit:       $('#rateLimit'),
        windowSize:      $('#windowSize'),
        refillRate:      $('#refillRate'),
        refillGroup:     $('#refillGroup'),
        applyConfig:     $('#applyConfig'),
        refreshConfig:   $('#refreshConfig'),

        // Test controls
        clientId:        $('#clientId'),
        sendRequest:     $('#sendRequest'),
        checkStatus:     $('#checkStatus'),
        burstCount:      $('#burstCount'),
        burstDelay:      $('#burstDelay'),
        burstTest:       $('#burstTest'),
        clearLog:        $('#clearLog'),
        resetClientQuota:$('#resetClientQuota'),

        // Metrics
        statTotal:       $('#statTotal'),
        statAllowed:     $('#statAllowed'),
        statBlocked:     $('#statBlocked'),
        statRemaining:   $('#statRemaining'),

        // Barometer
        meterPercent:    $('#meterPercent'),
        meterFill:       $('#meterFill'),
        meterMax:        $('#meterMax'),

        // Telemetry Stream
        logScroll:       $('#logScroll'),
        logEmpty:        $('#logEmpty'),
        logCount:        $('#logCount'),
        toastContainer:  $('#toastContainer'),
    };

    // ── State ──────────────────────────────────────────────────────────
    let stats = { total: 0, allowed: 0, blocked: 0, remaining: null, limit: null };
    let logEntries = [];
    let isBursting = false;

    // ── Helpers ────────────────────────────────────────────────────────

    /** Format a Date to HH:MM:SS.mmm */
    function fmtTime(date) {
        return date.toTimeString().slice(0, 8) + '.' +
               String(date.getMilliseconds()).padStart(3, '0');
    }

    /** Display notification toast */
    function toast(message, type = 'success') {
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.innerHTML = `<span>${message}</span>`;
        dom.toastContainer.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(6px)';
            el.style.transition = '0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
            setTimeout(() => el.remove(), 200);
        }, 3200);
    }

    /** Standard fetch wrapper */
    async function api(path, options = {}) {
        const res = await fetch(`${API_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        return res;
    }

    // ── Algorithm Control Visibility ───────────────────────────────────

    function updateControlVisibility() {
        const algo = dom.algorithm.value;
        if (algo === 'token_bucket') {
            dom.refillGroup.style.display = 'block';
        } else {
            dom.refillGroup.style.display = 'none';
        }
    }

    dom.algorithm.addEventListener('change', updateControlVisibility);

    // ── Metrics & Barometer UI ─────────────────────────────────────────

    function updateStatsUI() {
        dom.statTotal.textContent = stats.total;
        dom.statAllowed.textContent = stats.allowed;
        dom.statBlocked.textContent = stats.blocked;

        if (stats.remaining !== null && stats.limit !== null) {
            dom.statRemaining.textContent = stats.remaining;
            const pct = Math.max(0, Math.min(100,
                Math.round((stats.remaining / stats.limit) * 100)));
            dom.meterPercent.textContent = pct + '%';
            dom.meterFill.style.width = pct + '%';
            dom.meterMax.textContent = stats.limit + ' max';

            // Barometer color transition
            dom.meterFill.className = 'barometer-fill ' +
                (pct > 50 ? 'high' : pct > 20 ? 'medium' : 'low');
        } else {
            dom.statRemaining.textContent = '—';
            dom.meterPercent.textContent = '—%';
            dom.meterFill.style.width = '100%';
        }
    }

    // ── Telemetry Stream Log ───────────────────────────────────────────

    function addLogEntry(entry) {
        logEntries.unshift(entry);
        if (logEntries.length > 500) logEntries.pop();
        renderLastLogEntry(entry);
        dom.logCount.textContent = logEntries.length + (logEntries.length === 1 ? ' event' : ' events');
        if (dom.logEmpty) dom.logEmpty.style.display = 'none';
    }

    function renderLastLogEntry(entry) {
        const row = document.createElement('div');
        row.className = 'log-row';

        const badge = entry.allowed
            ? '<span class="status-badge status-badge--allowed">200 ALLOWED</span>'
            : '<span class="status-badge status-badge--blocked">429 THROTTLED</span>';

        row.innerHTML = `
            <span class="log-time">${fmtTime(entry.time)}</span>
            <span class="log-status">${badge}</span>
            <span class="log-endpoint" title="${entry.endpoint}">${entry.endpoint}</span>
            <span class="log-quota">rem: <span class="val">${entry.remaining ?? '—'}</span></span>
            <span class="log-latency">${entry.responseTime}ms</span>
        `;

        // Insert at top of scroll
        if (dom.logScroll.firstChild && dom.logScroll.firstChild !== dom.logEmpty) {
            dom.logScroll.insertBefore(row, dom.logScroll.firstChild);
        } else {
            dom.logScroll.appendChild(row);
        }
    }

    function clearLogUI() {
        logEntries = [];
        dom.logScroll.innerHTML =
            '<div class="log-empty" id="logEmpty">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<line x1="12" y1="8" x2="12" y2="12"></line>' +
            '<line x1="12" y1="16" x2="12.01" y2="16"></line>' +
            '</svg>' +
            '<div>Telemetry buffer cleared.</div>' +
            '</div>';
        dom.logCount.textContent = '0 events';
        toast('Telemetry log buffer cleared');
    }

    // ── Dispatch Single Request ────────────────────────────────────────

    async function sendSingleRequest() {
        const start = performance.now();
        const time = new Date();
        let allowed = false;
        let remaining = null;
        let status = 0;

        try {
            const clientId = (dom.clientId.value || '127.0.0.1').trim();
            const res = await api('/limited', {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Client-ID': clientId,
                },
            });
            status = res.status;
            allowed = (status === 200);

            // Parse RFC standard rate-limit headers
            const remHeader = res.headers.get('X-RateLimit-Remaining');
            const limHeader = res.headers.get('X-RateLimit-Limit');
            if (remHeader !== null) remaining = parseInt(remHeader, 10);
            if (limHeader !== null) stats.limit = parseInt(limHeader, 10);

        } catch (err) {
            allowed = false;
        }

        const elapsed = Math.round(performance.now() - start);

        stats.total++;
        if (allowed) {
            stats.allowed++;
        } else {
            stats.blocked++;
        }
        if (remaining !== null) stats.remaining = remaining;

        updateStatsUI();

        addLogEntry({
            time,
            allowed,
            endpoint: '/limited',
            remaining,
            responseTime: elapsed,
        });

        return { allowed, remaining, elapsed };
    }

    // ── Query State ────────────────────────────────────────────────────

    async function fetchStatus() {
        const clientId = (dom.clientId.value || '127.0.0.1').trim();
        try {
            const res = await api(`/status/${encodeURIComponent(clientId)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.remaining !== undefined && data.remaining !== null) {
                    stats.remaining = typeof data.remaining === 'number'
                        ? data.remaining
                        : parseInt(data.remaining, 10);
                }
                if (data.limit !== undefined && data.limit !== null) {
                    stats.limit = typeof data.limit === 'number'
                        ? data.limit
                        : parseInt(data.limit, 10);
                }
                updateStatsUI();
                toast(`Client ${clientId} state queried: ${data.remaining} remaining of ${data.limit}`);
            } else {
                toast('Failed to fetch client state', 'error');
            }
        } catch (err) {
            toast('Cannot connect to API server', 'error');
        }
    }

    // ── Reset Client Quota ─────────────────────────────────────────────

    async function resetClientQuota() {
        const clientId = (dom.clientId.value || '127.0.0.1').trim();
        try {
            const res = await api(`/status/${encodeURIComponent(clientId)}`, {
                method: 'DELETE',
            });
            if (res.ok) {
                const data = await res.json();
                toast(`MongoDB state cleared for client ${clientId} (${data.documents_deleted} docs purged)`);
                await fetchStatus();
            } else {
                toast('Error purging client state', 'error');
            }
        } catch (err) {
            toast('Failed to reach backend', 'error');
        }
    }

    // ── Configuration Synchronization ──────────────────────────────────

    async function fetchConfig() {
        try {
            const res = await api('/config');
            if (res.ok) {
                const cfg = await res.json();
                if (cfg.algorithm) {
                    dom.algorithm.value = cfg.algorithm;
                    dom.currentAlgo.textContent = formatAlgoName(cfg.algorithm);
                }
                if (cfg.max_requests !== undefined) dom.rateLimit.value = cfg.max_requests;
                if (cfg.window_seconds !== undefined) dom.windowSize.value = cfg.window_seconds;
                if (cfg.refill_rate !== undefined) dom.refillRate.value = cfg.refill_rate;
                if (cfg.max_requests !== undefined) stats.limit = cfg.max_requests;

                updateControlVisibility();
                setConnected(true);
                return true;
            }
        } catch (err) {
            // Server offline
        }
        setConnected(false);
        return false;
    }

    async function applyConfig() {
        const body = {
            algorithm: dom.algorithm.value,
            max_requests: parseInt(dom.rateLimit.value, 10),
            window_seconds: parseInt(dom.windowSize.value, 10),
        };
        if (dom.algorithm.value === 'token_bucket') {
            body.refill_rate = parseFloat(dom.refillRate.value);
        }

        try {
            const res = await api('/config', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (res.ok) {
                toast(`Policy updated: ${formatAlgoName(body.algorithm)} applied`);
                dom.currentAlgo.textContent = formatAlgoName(body.algorithm);
                stats.limit = body.max_requests;
                stats.remaining = body.max_requests;
                updateStatsUI();
            } else {
                const text = await res.text();
                toast('Update failed: ' + text, 'error');
            }
        } catch (err) {
            toast('Cannot connect to backend server', 'error');
        }
    }

    function formatAlgoName(algo) {
        const names = {
            token_bucket: 'Token Bucket',
            sliding_window: 'Sliding Window',
            fixed_window: 'Fixed Window',
        };
        return names[algo] || algo;
    }

    // ── Burst Stress Engine ────────────────────────────────────────────

    async function runBurstTest() {
        if (isBursting) return;
        isBursting = true;

        const count = parseInt(dom.burstCount.value, 10) || 15;
        const delay = parseInt(dom.burstDelay.value, 10) || 0;

        dom.burstTest.textContent = '⏳ Executing Sequence...';
        dom.burstTest.disabled = true;
        dom.burstTest.classList.add('btn-triggering');

        let allowed = 0;
        let blocked = 0;

        for (let i = 0; i < count; i++) {
            const result = await sendSingleRequest();
            if (result.allowed) allowed++; else blocked++;

            if (delay > 0 && i < count - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        }

        dom.burstTest.textContent = 'Execute Burst Sequence';
        dom.burstTest.disabled = false;
        dom.burstTest.classList.remove('btn-triggering');
        isBursting = false;

        toast(`Burst sequence complete: ${allowed} allowed, ${blocked} throttled`);
    }

    // ── Health & Connection Heartbeat ──────────────────────────────────

    function setConnected(connected) {
        dom.statusDot.classList.toggle('connected', connected);
        dom.statusText.textContent = connected ? 'Online' : 'Offline';
    }

    async function healthCheck() {
        try {
            const res = await fetch(`${API_BASE}/`);
            setConnected(res.ok);
        } catch {
            setConnected(false);
        }
    }

    // ── Event Listeners ────────────────────────────────────────────────

    dom.sendRequest.addEventListener('click', sendSingleRequest);
    dom.checkStatus.addEventListener('click', fetchStatus);
    if (dom.resetClientQuota) dom.resetClientQuota.addEventListener('click', resetClientQuota);
    dom.burstTest.addEventListener('click', runBurstTest);
    dom.applyConfig.addEventListener('click', applyConfig);
    dom.refreshConfig.addEventListener('click', () => {
        fetchConfig().then(ok => {
            if (ok) toast('Server configuration synchronized');
        });
    });
    dom.clearLog.addEventListener('click', clearLogUI);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'r' || e.key === 'R') sendSingleRequest();
        if (e.key === 'b' || e.key === 'B') runBurstTest();
        if (e.key === 's' || e.key === 'S') fetchStatus();
    });

    // ── Initialization ─────────────────────────────────────────────────

    (async function init() {
        updateControlVisibility();
        await fetchConfig();
        setInterval(healthCheck, 4000);
    })();

})();
