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

        // Config controls
        algorithm:       $('#algorithm'),
        rateLimit:       $('#rateLimit'),
        windowSize:      $('#windowSize'),
        refillRate:      $('#refillRate'),
        refillGroup:     $('#refillGroup'),
        rateLimitGroup:  $('#rateLimitGroup'),
        windowGroup:     $('#windowGroup'),
        applyConfig:     $('#applyConfig'),
        refreshConfig:   $('#refreshConfig'),

        // Test controls
        clientId:        $('#clientId'),
        sendRequest:     $('#sendRequest'),
        checkStatus:     $('#checkStatus'),
        burstCount:      $('#burstCount'),
        burstConcurrency:$('#burstConcurrency'),
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
        logHeader:       $('#logHeader'),
        logScroll:       $('#logScroll'),
        logEmpty:        $('#logEmpty'),
        logCount:        $('#logCount'),
        toastContainer:  $('#toastContainer'),

        // MongoDB Document Panel
        docPanel:           $('#docPanel'),
        effectiveTokensRow: $('#effectiveTokensRow'),
        effectiveTokensVal: $('#effectiveTokensVal'),
        docCode:            $('#docCode'),
    };

    // ── Algorithm Descriptions ─────────────────────────────────────────
    const ALGO_DESCRIPTIONS = {
        token_bucket: 'Replenishes tokens dynamically at a steady rate; allows bursts up to capacity.',
        sliding_window: 'Tracks exact request timestamps in a rolling window for precision.',
        fixed_window: 'Counts requests in discrete time intervals with atomic counter resets.',
    };

    // ── State ──────────────────────────────────────────────────────────
    let stats = { total: 0, allowed: 0, blocked: 0, remaining: null, limit: null };
    let logEntries = [];
    let isBursting = false;
    let previousDoc = null;
    let previousDocClientId = null;
    let confirmedConfig = {
        algorithm: null,
        max_requests: null,
        window_seconds: null,
        refill_rate: null,
    };

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
        const span = document.createElement('span');
        span.textContent = message;
        el.appendChild(span);
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

    // ── Algorithm Control Visibility & Policy Dirty Tracking ───────────

    function checkPolicyDirty() {
        if (!dom.applyConfig || confirmedConfig.algorithm === null) return;

        const currentAlgo = dom.algorithm ? dom.algorithm.value : 'token_bucket';
        let isDirty = false;

        if (currentAlgo !== confirmedConfig.algorithm) {
            isDirty = true;
        }

        const maxReq = parseFloat(dom.rateLimit.value);
        if (!isNaN(maxReq) && maxReq !== confirmedConfig.max_requests) {
            isDirty = true;
        }

        if (currentAlgo === 'token_bucket') {
            const refill = parseFloat(dom.refillRate.value);
            if (!isNaN(refill) && refill !== confirmedConfig.refill_rate) {
                isDirty = true;
            }
        } else {
            const win = parseInt(dom.windowSize.value, 10);
            if (!isNaN(win) && win !== confirmedConfig.window_seconds) {
                isDirty = true;
            }
        }

        dom.applyConfig.disabled = !isDirty;
    }

    function updateControlVisibility() {
        const algo = dom.algorithm ? dom.algorithm.value : 'token_bucket';
        if (algo === 'token_bucket') {
            if (dom.refillGroup) dom.refillGroup.style.display = 'block';
            if (dom.windowGroup) dom.windowGroup.style.display = 'none';
        } else {
            if (dom.refillGroup) dom.refillGroup.style.display = 'none';
            if (dom.windowGroup) dom.windowGroup.style.display = 'block';
        }

        const descEl = document.getElementById('algoDescription');
        if (descEl && ALGO_DESCRIPTIONS[algo]) {
            descEl.textContent = ALGO_DESCRIPTIONS[algo];
        }

        const radio = document.querySelector(`input[name="algorithm_choice"][value="${algo}"]`);
        if (radio && !radio.checked) {
            radio.checked = true;
        }

        checkPolicyDirty();
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
            dom.statRemaining.textContent = (stats.limit !== null) ? stats.limit : (dom.rateLimit ? dom.rateLimit.value : '10');
            dom.meterPercent.textContent = '100%';
            dom.meterFill.style.width = '100%';
        }
    }

    // ── Telemetry Stream Log ───────────────────────────────────────────

    function addLogEntry(entry) {
        logEntries.unshift(entry);
        if (logEntries.length > 200) logEntries.pop();
        renderLastLogEntry(entry);
        const rows = dom.logScroll.querySelectorAll('.log-row');
        for (let i = 200; i < rows.length; i++) {
            rows[i].remove();
        }
        dom.logCount.textContent = logEntries.length + (logEntries.length === 1 ? ' event' : ' events');
        if (dom.logEmpty) dom.logEmpty.style.display = 'none';
    }

    function renderLastLogEntry(entry) {
        const row = document.createElement('div');
        row.className = 'log-row';

        let badgeClass = 'status-badge--error';
        let badgeText = 'ERR';

        if (entry.status === 200 || entry.outcome === 'allowed') {
            badgeClass = 'status-badge--allowed';
            badgeText = '200';
        } else if (entry.status === 429 || entry.outcome === 'throttled') {
            badgeClass = 'status-badge--blocked';
            badgeText = '429';
        } else {
            badgeClass = 'status-badge--error';
            badgeText = entry.status ? String(entry.status) : 'ERR';
        }

        const badge = `<span class="status-badge ${badgeClass}">${badgeText}</span>`;
        const remVal = (entry.remaining !== null && entry.remaining !== undefined) ? entry.remaining : '—';
        const retryVal = (entry.retryAfter !== null && entry.retryAfter !== undefined) ? `${entry.retryAfter}s` : '—';
        const clientVal = entry.clientId || '127.0.0.1';

        row.innerHTML = `
            <span class="log-col log-time">${fmtTime(entry.time)}</span>
            <span class="log-col log-client" title="${clientVal}">${clientVal}</span>
            <span class="log-col log-status">${badge}</span>
            <span class="log-col log-remaining">${remVal}</span>
            <span class="log-col log-retry">${retryVal}</span>
            <span class="log-col log-latency">${entry.responseTime}ms</span>
        `;

        const header = dom.logHeader || dom.logScroll.querySelector('.log-table-header');
        if (header) {
            header.insertAdjacentElement('afterend', row);
        } else if (dom.logScroll.firstChild && dom.logScroll.firstChild !== dom.logEmpty) {
            dom.logScroll.insertBefore(row, dom.logScroll.firstChild);
        } else {
            dom.logScroll.appendChild(row);
        }
    }

    function clearLogUI() {
        logEntries = [];
        dom.logScroll.querySelectorAll('.log-row').forEach(r => r.remove());
        if (dom.logEmpty) {
            dom.logEmpty.style.display = 'block';
            dom.logEmpty.textContent = 'No requests logged yet.';
        }
        dom.logCount.textContent = '0 events';
        toast('Telemetry log buffer cleared');
    }

    // ── Dispatch Single Request ────────────────────────────────────────

    async function sendSingleRequest() {
        const start = performance.now();
        const time = new Date();
        const clientId = (dom.clientId.value || '127.0.0.1').trim();
        let allowed = false;
        let remaining = null;
        let retryAfter = null;
        let status = 0;
        let outcome = 'error';

        try {
            const res = await api('/limited', {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Client-ID': clientId,
                },
            });
            status = res.status;
            if (status === 200) {
                allowed = true;
                outcome = 'allowed';
            } else if (status === 429) {
                allowed = false;
                outcome = 'throttled';
            } else {
                allowed = false;
                outcome = 'error';
            }

            // Parse RFC standard rate-limit headers
            const remHeader = res.headers.get('X-RateLimit-Remaining');
            const limHeader = res.headers.get('X-RateLimit-Limit');
            const retryHeader = res.headers.get('Retry-After');

            if (remHeader !== null) remaining = parseInt(remHeader, 10);
            if (limHeader !== null) stats.limit = parseInt(limHeader, 10);
            if (retryHeader !== null) {
                const parsedRetry = parseInt(retryHeader, 10);
                retryAfter = isNaN(parsedRetry) ? retryHeader : parsedRetry;
            }

        } catch (err) {
            allowed = false;
            status = 0;
            outcome = 'error';
        }

        const elapsed = Math.round(performance.now() - start);

        stats.total++;
        if (outcome === 'allowed') {
            stats.allowed++;
        } else if (outcome === 'throttled') {
            stats.blocked++;
        }
        if (remaining !== null) stats.remaining = remaining;

        updateStatsUI();

        addLogEntry({
            time,
            clientId,
            status,
            outcome,
            allowed,
            endpoint: '/limited',
            remaining,
            retryAfter,
            responseTime: elapsed,
        });

        if (!isBursting) {
            await fetchStatus(true);
        }

        return { allowed, outcome, status, remaining, retryAfter, elapsed };
    }

    // ── MongoDB Document Panel ─────────────────────────────────────────

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatJSONValue(val, indentLevel = 1) {
        if (val === null) return '<span class="json-null">null</span>';
        if (typeof val === 'number') return `<span class="json-num">${val}</span>`;
        if (typeof val === 'boolean') return `<span class="json-bool">${val}</span>`;
        if (typeof val === 'string') return `<span class="json-str">"${escapeHtml(val)}"</span>`;
        if (Array.isArray(val)) {
            if (val.length === 0) return '[]';
            const indent = '  '.repeat(indentLevel);
            const innerIndent = '  '.repeat(indentLevel + 1);
            const items = val.map(item => `${innerIndent}${formatJSONValue(item, indentLevel + 1)}`).join(',\n');
            return `[\n${items}\n${indent}]`;
        }
        if (typeof val === 'object') {
            const keys = Object.keys(val);
            if (keys.length === 0) return '{}';
            const indent = '  '.repeat(indentLevel);
            const innerIndent = '  '.repeat(indentLevel + 1);
            const items = keys.map((k, idx) => {
                const comma = idx < keys.length - 1 ? ',' : '';
                return `${innerIndent}<span class="json-key">"${escapeHtml(k)}"</span>: ${formatJSONValue(val[k], indentLevel + 1)}${comma}`;
            }).join('\n');
            return `{\n${items}\n${indent}}`;
        }
        return escapeHtml(String(val));
    }

    function renderDocumentJSON(doc, changedKeys) {
        const keys = Object.keys(doc);
        if (keys.length === 0) {
            return '<code>{}</code>';
        }

        const lines = [];
        lines.push('<code>{');

        keys.forEach((key, index) => {
            const isLast = index === keys.length - 1;
            const comma = isLast ? '' : ',';
            const isChanged = changedKeys.has(key);
            const highlightClass = isChanged ? ' field-highlight' : '';
            const valFormatted = formatJSONValue(doc[key], 1);
            lines.push(`  <span class="doc-field${highlightClass}" data-key="${escapeHtml(key)}"><span class="json-key">"${escapeHtml(key)}"</span>: ${valFormatted}${comma}</span>`);
        });

        lines.push('}</code>');
        return lines.join('\n');
    }

    function renderDocPanel(data) {
        if (!dom.docCode) return;

        // Effective tokens line for Token Bucket
        if (data.algorithm === 'token_bucket' && data.state && data.state.tokens !== undefined) {
            if (dom.effectiveTokensRow) dom.effectiveTokensRow.style.display = 'block';
            if (dom.effectiveTokensVal) dom.effectiveTokensVal.textContent = data.state.tokens;
        } else {
            if (dom.effectiveTokensRow) dom.effectiveTokensRow.style.display = 'none';
        }

        const currentClientId = data.client_id;
        const doc = data.document;

        if (doc === null || doc === undefined) {
            dom.docCode.innerHTML = '<code><span class="json-null">null</span></code>';
            previousDoc = null;
            previousDocClientId = currentClientId;
            return;
        }

        // Detect changed fields since previous render
        const changedKeys = new Set();
        if (previousDoc && typeof previousDoc === 'object' && previousDocClientId === currentClientId) {
            const allKeys = new Set([...Object.keys(doc), ...Object.keys(previousDoc)]);
            for (const k of allKeys) {
                if (JSON.stringify(doc[k]) !== JSON.stringify(previousDoc[k])) {
                    changedKeys.add(k);
                }
            }
        }

        dom.docCode.innerHTML = renderDocumentJSON(doc, changedKeys);
        previousDoc = JSON.parse(JSON.stringify(doc));
        previousDocClientId = currentClientId;
    }

    // ── Query State ────────────────────────────────────────────────────

    async function fetchStatus(silent = false) {
        const clientId = (dom.clientId.value || '127.0.0.1').trim();
        try {
            const res = await api(`/status/${encodeURIComponent(clientId)}?raw=true`);
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

                // Render MongoDB document panel
                renderDocPanel(data);

                if (!silent) {
                    toast(`Client ${clientId} state queried: ${data.remaining} remaining of ${data.limit}`);
                }
            } else {
                if (!silent) toast('Failed to fetch client state', 'error');
            }
        } catch (err) {
            if (!silent) toast('Cannot connect to API server', 'error');
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
                }
                if (cfg.max_requests !== undefined) dom.rateLimit.value = cfg.max_requests;
                if (cfg.window_seconds !== undefined) dom.windowSize.value = cfg.window_seconds;
                if (cfg.refill_rate !== undefined) dom.refillRate.value = cfg.refill_rate;
                if (cfg.max_requests !== undefined) stats.limit = cfg.max_requests;

                confirmedConfig = {
                    algorithm: cfg.algorithm || dom.algorithm.value,
                    max_requests: cfg.max_requests !== undefined ? cfg.max_requests : parseFloat(dom.rateLimit.value),
                    window_seconds: cfg.window_seconds !== undefined ? cfg.window_seconds : parseInt(dom.windowSize.value, 10),
                    refill_rate: cfg.refill_rate !== undefined ? cfg.refill_rate : parseFloat(dom.refillRate.value),
                };

                updateControlVisibility();
                checkPolicyDirty();
                setConnected(true);
                return true;
            }
        } catch (err) {
            // Server offline
        }
        setConnected(false);
        return false;
    }

    // ── Input Validation & Clamping ───────────────────────────────────

    function parseAndClampInput(inputEl, label, isFloat = false) {
        const raw = (inputEl.value ?? '').toString().trim();
        if (raw === '') {
            toast(`${label} cannot be empty`, 'error');
            return null;
        }
        const val = isFloat ? parseFloat(raw) : parseInt(raw, 10);
        if (isNaN(val)) {
            toast(`${label} must be a valid number`, 'error');
            return null;
        }
        const min = inputEl.min !== '' ? (isFloat ? parseFloat(inputEl.min) : parseInt(inputEl.min, 10)) : -Infinity;
        const max = inputEl.max !== '' ? (isFloat ? parseFloat(inputEl.max) : parseInt(inputEl.max, 10)) : Infinity;
        const clamped = Math.min(Math.max(val, min), max);
        inputEl.value = clamped;
        return clamped;
    }

    async function applyConfig() {
        const currentAlgo = dom.algorithm.value;
        const maxRequests = parseAndClampInput(dom.rateLimit, 'Max Requests');
        if (maxRequests === null) return;

        const body = {
            algorithm: currentAlgo,
            max_requests: maxRequests,
        };

        if (currentAlgo === 'token_bucket') {
            const refillRate = parseAndClampInput(dom.refillRate, 'Refill Rate', true);
            if (refillRate === null) return;
            body.refill_rate = refillRate;
        } else {
            const windowSeconds = parseAndClampInput(dom.windowSize, 'Window (sec)');
            if (windowSeconds === null) return;
            body.window_seconds = windowSeconds;
        }

        try {
            const res = await api('/config', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (res.ok) {
                const data = await res.json();
                const cfg = data.new_config || body;

                if (cfg.algorithm) {
                    dom.algorithm.value = cfg.algorithm;
                }
                if (cfg.max_requests !== undefined) {
                    dom.rateLimit.value = cfg.max_requests;
                    stats.limit = cfg.max_requests;
                }
                if (cfg.window_seconds !== undefined) {
                    dom.windowSize.value = cfg.window_seconds;
                }
                if (cfg.refill_rate !== undefined) {
                    dom.refillRate.value = cfg.refill_rate;
                }

                confirmedConfig = {
                    algorithm: cfg.algorithm || currentAlgo,
                    max_requests: cfg.max_requests !== undefined ? cfg.max_requests : maxRequests,
                    window_seconds: cfg.window_seconds !== undefined ? cfg.window_seconds : (body.window_seconds ?? confirmedConfig.window_seconds),
                    refill_rate: cfg.refill_rate !== undefined ? cfg.refill_rate : (body.refill_rate ?? confirmedConfig.refill_rate),
                };

                updateControlVisibility();
                checkPolicyDirty();
                toast(`Policy updated: ${formatAlgoName(cfg.algorithm || currentAlgo)} applied`);

                await fetchStatus();
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

        const count = parseAndClampInput(dom.burstCount, 'Burst Count');
        if (count === null) return;

        const concurrency = parseAndClampInput(dom.burstConcurrency, 'Concurrency');
        if (concurrency === null) return;

        const delay = parseAndClampInput(dom.burstDelay, 'Interval (ms)');
        if (delay === null) return;

        isBursting = true;

        dom.burstTest.disabled = true;
        dom.burstTest.classList.add('btn-triggering');
        dom.burstTest.textContent = `0/${count}`;

        let allowed = 0;
        let throttled = 0;
        let errors = 0;
        let completed = 0;

        if (concurrency === 1) {
            for (let i = 0; i < count; i++) {
                const result = await sendSingleRequest();
                if (result.outcome === 'allowed') allowed++;
                else if (result.outcome === 'throttled') throttled++;
                else errors++;

                completed++;
                dom.burstTest.textContent = `${completed}/${count}`;

                if (delay > 0 && i < count - 1) {
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        } else {
            for (let i = 0; i < count; i += concurrency) {
                const batchSize = Math.min(concurrency, count - i);
                const batchPromises = Array.from({ length: batchSize }, () =>
                    sendSingleRequest().then(result => {
                        if (result.outcome === 'allowed') allowed++;
                        else if (result.outcome === 'throttled') throttled++;
                        else errors++;

                        completed++;
                        dom.burstTest.textContent = `${completed}/${count}`;
                        return result;
                    })
                );

                await Promise.all(batchPromises);

                if (delay > 0 && i + batchSize < count) {
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        dom.burstTest.textContent = 'Run burst';
        dom.burstTest.disabled = false;
        dom.burstTest.classList.remove('btn-triggering');
        isBursting = false;

        await fetchStatus(true);

        toast(`Burst complete: ${allowed} allowed, ${throttled} throttled, ${errors} errors`);
    }

    // ── Health & Connection Heartbeat ──────────────────────────────────

    function setConnected(connected) {
        dom.statusDot.classList.toggle('connected', connected);
        dom.statusText.textContent = connected ? 'Online' : 'Offline';
    }

    async function healthCheck() {
        try {
            const res = await fetch(`${API_BASE}/health`);
            setConnected(res.ok);
        } catch {
            setConnected(false);
        }
    }

    // ── Event Listeners ────────────────────────────────────────────────

    dom.sendRequest.addEventListener('click', sendSingleRequest);
    dom.checkStatus.addEventListener('click', () => fetchStatus(false));
    if (dom.resetClientQuota) dom.resetClientQuota.addEventListener('click', resetClientQuota);
    dom.burstTest.addEventListener('click', runBurstTest);
    dom.applyConfig.addEventListener('click', applyConfig);
    dom.refreshConfig.addEventListener('click', () => {
        fetchConfig().then(ok => {
            if (ok) toast('Server configuration synchronized');
        });
    });
    dom.clearLog.addEventListener('click', clearLogUI);

    // Segmented control radio listeners
    document.querySelectorAll('input[name="algorithm_choice"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                dom.algorithm.value = e.target.value;
                updateControlVisibility();
            }
        });
    });

    // Policy input dirty check listeners
    [dom.rateLimit, dom.windowSize, dom.refillRate].forEach(input => {
        if (input) {
            input.addEventListener('input', checkPolicyDirty);
            input.addEventListener('change', checkPolicyDirty);
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (e.key === 'r' || e.key === 'R') sendSingleRequest();
        if (e.key === 'b' || e.key === 'B') runBurstTest();
        if (e.key === 's' || e.key === 'S') fetchStatus(false);
    });

    // ── Initialization ─────────────────────────────────────────────────

    // Mobile menu toggle: on small screens the left-rail uses display:contents
    // and sections appear in flow. The hamburger button scrolls to #sectionPolicy.
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', function () {
            const target = document.getElementById('sectionPolicy');
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    (async function init() {
        updateControlVisibility();
        await fetchConfig();
        await fetchStatus(true);
        setInterval(healthCheck, 4000);
    })();

})();
