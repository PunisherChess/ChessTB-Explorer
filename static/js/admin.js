/**
 * admin.js — ChessTB Admin Dashboard
 *
 * Client-side logic for templates/admin.html: polls the cache-stats
 * endpoint, renders the two cache cards and the thread-pool card, and
 * wires the refresh/clear buttons. Kept as an external file — with clicks
 * bound via addEventListener rather than inline onclick="" — because the
 * app's Content-Security-Policy (`script-src 'self'`, set by app.py's
 * after_request hook) blocks both inline <script> bodies and inline event
 * handler attributes.
 */

function renderCache(elId, barId, data) {
  const pct = (data.hit_rate * 100).toFixed(1);
  document.getElementById(barId).style.width = pct + '%';
  document.getElementById(elId).innerHTML = [
    ['Hit rate',   pct + '%'],
    ['Hits',       data.hits.toLocaleString()],
    ['Misses',     data.misses.toLocaleString()],
    ['Used',       data.currsize.toLocaleString() + ' / ' + data.maxsize.toLocaleString()],
    ['Fill',       ((data.currsize / data.maxsize) * 100).toFixed(1) + '%'],
  ].map(([l,v]) =>
    `<div class="stat"><span class="label">${l}</span><span class="value">${v}</span></div>`
  ).join('');
}

function renderPool(data) {
  const rows = [
    ['Max workers',        data.thread_pool.max_workers],
    ['Parallel threshold', data.thread_pool.parallel_threshold + ' child positions'],
    ['Probe timeout',      data.thread_pool.probe_timeout_secs + ' s'],
    ['Eval cache size',    data.config.evaluate_cache_size.toLocaleString()],
    ['Probe cache size',   data.config.probe_cache_size.toLocaleString()],
    ['Block cache size',   (data.config.block_cache_bytes / (1024 * 1024)).toLocaleString() + ' MB'],
  ];
  document.getElementById('stats-pool').innerHTML = rows.map(([l,v]) =>
    `<div class="stat"><span class="label">${l}</span><span class="value">${v}</span></div>`
  ).join('');
}

function setStatus(msg, cls) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status ' + (cls || '');
}

async function loadStats() {
  const headers = {'Content-Type': 'application/json'};
  try {
    const r = await fetch('/admin/cache/stats', { headers });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setStatus('Error ' + r.status + ': ' + (j.error || r.statusText), 'err');
      return;
    }
    const data = await r.json();
    renderCache('stats-eval',       'bar-eval',       data.evaluate_fen_cache);
    renderCache('stats-probe',      'bar-probe',      data.probe_fen_cache);
    renderPool(data);
    document.getElementById('last-updated').textContent =
      'Last updated: ' + new Date().toLocaleTimeString();
    setStatus('', '');
  } catch (e) {
    setStatus('Cannot reach backend.', 'err');
  }
}

async function clearCaches() {
  if (!confirm('Clear all caches? This will slow down the next few probes.')) return;
  const headers = {'Content-Type': 'application/json'};
  try {
    const r = await fetch('/admin/cache/clear', { method: 'POST', headers });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setStatus('Caches cleared successfully.', 'ok');
      loadStats();
    } else {
      setStatus('Error: ' + (j.error || r.statusText), 'err');
    }
  } catch (e) {
    setStatus('Cannot reach backend.', 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-btn')?.addEventListener('click', loadStats);
  document.getElementById('clear-btn')?.addEventListener('click', clearCaches);

  loadStats();
  let countdown = 5;
  setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = 5;
      loadStats();
    }
    document.getElementById('next-refresh').textContent =
      'Auto-refreshes in ' + countdown + ' s';
  }, 1000);
});
