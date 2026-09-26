/* LayaStudio 前端逻辑 — 与 UI 业务解耦，仅通过 REST 调用后端 */
'use strict';

/* ================= 工具 ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(path, opts = {}) {
  const init = { headers: {}, ...opts };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = data && data.detail;
    const msg = typeof detail === 'string' ? detail
      : detail ? JSON.stringify(detail) : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, type = '') {
  const wrap = $('#toast-wrap');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = msg;
  wrap.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => node.remove(), 3000);
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch (_) { return iso; }
}

function pretty(v) {
  return JSON.stringify(v, null, 2);
}

/* ================= 全局状态 ================= */
const S = {
  view: 'playground',
  status: null,
  presets: [],
  history: { offset: 0, limit: 30, total: 0, selected: new Set(), detailId: null },
  evalSelected: null,
  runDetail: null,
};

/* 观测台运行状态 */
const MON = {
  timer: null,
  seenEvents: new Set(),
  kpiValues: {},
  firstEventLoad: true,
};

const ROUTE_COLORS = {
  english: '#4F8CFF',
  multilingual: '#3FB950',
  mock: '#D29922',
  'typed-decisions': '#A371F7',
  auto: '#8B949E',
};
const ROUTE_FALLBACK = ['#58A6FF', '#3FB950', '#D29922', '#A371F7', '#F85149', '#8B949E'];

const DEFAULT_QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this request?',
    criteria: {
      billing: 'invoices, payments, refunds',
      technical: 'bugs, outages, system errors',
      sales: 'pricing, new contracts',
      other: 'everything else',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this request?',
    criteria: ['not urgent', 'soon', 'critical deadline or blocking issue'],
  },
  churn_risk: {
    type: 'noul',
    instructions: 'Does the user threaten to cancel or leave?',
  },
};

const DEFAULT_STATE = 'Hi, we were billed twice for March. Please refund the duplicate ' +
  'charge today or we will cancel our plan.';

const EVAL_SAMPLE = [
  {
    state: 'Please refund the duplicate charge on invoice 4411 ASAP.',
    questions: {
      dept: {
        type: 'choice',
        instructions: 'Which department?',
        criteria: { billing: 'invoices, payments, refunds', technical: 'bugs, outages' },
      },
    },
    expected: { dept: 'billing' },
  },
  {
    state: 'The checkout service returns HTTP 500 on every request since 09:00.',
    questions: {
      dept: {
        type: 'choice',
        instructions: 'Which department?',
        criteria: { billing: 'invoices, payments, refunds', technical: 'bugs, outages' },
      },
    },
    expected: { dept: 'technical' },
  },
  {
    state: 'We are considering canceling the subscription unless the outage is fixed today.',
    questions: {
      churn: { type: 'noul', instructions: 'Does the user threaten to cancel?' },
    },
    expected: { churn: true },
  },
].map(r => JSON.stringify(r)).join('\n');

/* ================= 路由 ================= */
const VIEWS = ['playground', 'monitor', 'models', 'history', 'eval', 'settings'];

function route() {
  const v = (location.hash || '#playground').slice(1);
  const view = VIEWS.includes(v) ? v : 'playground';
  S.view = view;
  VIEWS.forEach(name => {
    $(`#view-${name}`).classList.toggle('hidden', name !== view);
  });
  $$('.nav-item').forEach(a => {
    const active = a.dataset.view === view;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (MON.timer) { clearInterval(MON.timer); MON.timer = null; }
  if (view === 'monitor') {
    loadMonitor();
    MON.timer = setInterval(loadMonitor, 3000);
  }
  if (view === 'models') loadModels();
  if (view === 'history') loadHistory(true);
  if (view === 'eval') { loadEvalJobs(); }
  if (view === 'settings') loadSettings();
}

/* ================= 状态栏 ================= */
async function refreshStatus() {
  try {
    const st = await api('/api/status');
    S.status = st;
    $('#health-dot').className = 'health-dot ok';
    $('#health-text').textContent = '在线';

    const isMock = st.backend === 'mock';
    const backendPill = $('#pill-backend');
    backendPill.textContent = `backend: ${st.backend}`;
    backendPill.className = `pill ${isMock ? 'warn' : 'success'}`;
    $('#pill-device').textContent = `device: ${st.device}`;
    const loaded = (st.loaded || []).join(', ');
    $('#pill-loaded').textContent = loaded ? `loaded: ${loaded}` : 'loaded: —';
    $('#status-extra').textContent =
      `并发 ${st.in_flight}/${st.max_concurrent} · v${st.version}`;
    $('#status-extra').classList.toggle('busy', (st.in_flight || 0) > 0);

    $('#mock-banner').classList.toggle('hidden', !isMock);
    $('#models-hint').textContent = isMock
      ? 'Mock 后端运行中 — 模型卡片仅展示元数据，安装与加载需切换到 laya 后端。'
      : '三个 Laya checkpoint：下载到本地 HF 缓存，按需加载进显存。';
  } catch (_) {
    $('#health-dot').className = 'health-dot err';
    $('#health-text').textContent = '离线';
  }
}

/* ================= 调试台 ================= */

function loadPresetChips() {
  const wrap = $('#preset-chips');
  wrap.innerHTML = S.presets.map(p =>
    `<button class="chip" data-id="${esc(p.id)}" title="${esc(p.desc)}">${esc(p.title)}</button>`
  ).join('');
  $$('.chip', wrap).forEach(chip => {
    chip.addEventListener('click', () => {
      const p = S.presets.find(x => x.id === chip.dataset.id);
      if (!p) return;
      $('#state-input').value = p.state;
      $('#questions-input').value = pretty(p.questions);
      $$('.chip', wrap).forEach(c => c.classList.toggle('active', c === chip));
      updateStateMeta();
      checkOptionWarn();
      toast(`已载入预设「${p.title}」`);
    });
  });
}

function parseStateInput() {
  const raw = $('#state-input').value;
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('State 不能为空');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (_) { return raw; }
  }
  return raw;
}

function parseQuestionsInput() {
  const raw = $('#questions-input').value.trim();
  if (!raw) throw new Error('Questions 不能为空');
  let qs;
  try { qs = JSON.parse(raw); } catch (e) { throw new Error('Questions 不是合法 JSON：' + e.message); }
  if (!qs || typeof qs !== 'object' || Array.isArray(qs)) throw new Error('Questions 必须是对象');
  return qs;
}

function updateStateMeta() {
  const n = $('#state-input').value.length;
  $('#state-meta').textContent = `${n} 字符`;
}

function checkOptionWarn() {
  const pill = $('#option-warn');
  try {
    const qs = parseQuestionsInput();
    const threshold = (S.status && S.status.option_warn_threshold) || 20;
    let total = 0;
    for (const q of Object.values(qs)) {
      if (q && q.type === 'choice' && q.criteria) total += Object.keys(q.criteria).length;
    }
    if (total > threshold) {
      pill.textContent = `choice 选项共 ${total} > ${threshold}，精度可能下降`;
      pill.classList.remove('hidden');
    } else {
      pill.classList.add('hidden');
    }
  } catch (_) {
    pill.classList.add('hidden');
  }
}

async function runDecision() {
  const btn = $('#btn-run');
  let payload;
  try {
    payload = { state: parseStateInput(), questions: parseQuestionsInput() };
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const model = $('#model-select').value;
  if (model) payload.model = model;

  btn.disabled = true;
  btn.textContent = '推理中…';
  $('#results').innerHTML = '<div class="empty-state"><div class="empty-ico">◌</div><p>推理中…</p></div>';
  try {
    const t0 = performance.now();
    const data = await api('/api/predict', { method: 'POST', body: payload });
    const localMs = (performance.now() - t0).toFixed(0);
    renderResults(data.result, data.latency_ms, localMs);
  } catch (e) {
    $('#meta-badges').innerHTML = '';
    $('#results').innerHTML =
      `<div class="error-card"><span class="code">HTTP ${e.status || 'ERR'}</span>
       <p>${esc(e.message)}</p></div>`;
    $('#raw-wrap').hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = '运行决策';
  }
}

function renderResults(result, serverMs, localMs) {
  const answers = result.answers || {};
  const routing = result.routing || {};
  const usage = result.usage || {};

  $('#meta-badges').innerHTML = [
    `<span class="meta-badge hl">↳ ${esc(routing.model || 'auto')}</span>`,
    `<span class="meta-badge ok">${esc(serverMs)} ms</span>`,
    usage.input_tokens != null ? `<span class="meta-badge">${usage.input_tokens} tok</span>` : '',
    localMs ? `<span class="meta-badge">往返 ${localMs} ms</span>` : '',
  ].join('');

  const order = Object.keys(answers);
  if (!order.length) {
    $('#results').innerHTML = '<div class="empty-state">响应中没有 answers</div>';
  } else {
    $('#results').innerHTML = order.map((qid, i) => renderAnswer(qid, answers[qid], routing, i)).join('');
  }
  $('#raw-json').textContent = pretty(result);
  $('#raw-wrap').hidden = false;
}

function renderAnswer(qid, ans, routing, idx) {
  const type = ans.type || 'choice';
  const delay = `animation-delay:${idx * 45}ms`;
  let body = '';

  if (type === 'choice') {
    const probs = ans.probabilities || {};
    const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    const bars = entries.map(([label, p], i) => `
      <div class="bar-row ${label === ans.choice ? 'top' : ''}">
        <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(p * 100).toFixed(1)}%"></div></div>
        <span class="bar-val">${(p * 100).toFixed(1)}%</span>
      </div>`).join('');
    body = `
      <div class="answer-lead">
        <span class="answer-value">${esc(ans.choice ?? '—')}</span>
        <span class="conf">confidence <b class="${confClass(ans.confidence)}">${fmtPct(ans.confidence)}</b></span>
      </div>
      <div class="bars">${bars}</div>`;
  } else if (type === 'score') {
    // 真实 laya 的 legend 是 {0:..,1:..} 字典，mock 是数组；概率键也可能带层级
    const legendRaw = ans.legend;
    const levels = Array.isArray(legendRaw) ? legendRaw
      : (legendRaw && typeof legendRaw === 'object') ? Object.values(legendRaw)
      : Object.keys(ans.probabilities || {});
    const n = Math.max(levels.length - 1, 1);
    const score = Number(ans.score ?? 0);
    const pct = Math.max(0, Math.min(100, (score / n) * 100));
    body = `
      <div class="answer-lead">
        <span class="answer-value mono">${score.toFixed(2)}<span class="conf"> / ${n}.0</span></span>
        <span class="conf">confidence <b class="${confClass(ans.confidence)}">${fmtPct(ans.confidence)}</b></span>
      </div>
      <div class="scale-wrap">
        <div class="scale-track"><div class="scale-dot" style="left:${pct}%"></div></div>
        <div class="scale-legend">
          <span>${esc(levels[0] || '')}</span>
          <span class="max">${esc(levels[levels.length - 1] || '')}</span>
        </div>
      </div>`;
  } else { // noul
    const p = Number(ans.noul ?? 0);
    body = `
      <div class="noul-wrap">
        <div class="ring" style="--p:${(p * 100).toFixed(1)}"><b>${(p * 100).toFixed(1)}%</b></div>
        <div class="noul-text">
          <span class="answer-value">P(true) = ${p.toFixed(3)}</span>
          <p class="conf">confidence <b class="${confClass(ans.confidence)}">${fmtPct(ans.confidence)}</b>
          ${routing.reason ? ' · ' + esc(routing.reason) : ''}</p>
        </div>
      </div>`;
  }

  return `
    <div class="q-result" style="${delay}">
      <div class="q-head">
        <span class="q-id">${esc(qid)}</span>
        <span class="q-type ${esc(type)}">${esc(type)}</span>
      </div>
      ${body}
    </div>`;
}

function fmtPct(v) {
  if (v == null) return '—';
  return (Number(v) * 100).toFixed(1) + '%';
}

/* confidence 语义分级：≥80 绿、<50 琥珀，其余默认 */
function confClass(v) {
  if (v == null) return '';
  const n = Number(v);
  return n >= 0.8 ? 'hi' : (n < 0.5 ? 'lo' : '');
}

/* ================= 模型 ================= */

async function loadModels() {
  try {
    const models = await api('/api/models');
    $('#model-grid').innerHTML = models.map(m => {
      const dl = m.download || { status: 'idle' };
      let badge = '<span class="badge off">未安装</span>';
      if (dl.status === 'downloading') badge = '<span class="badge downloading">下载中…</span>';
      else if (dl.status === 'error') badge = '<span class="badge error">下载失败</span>';
      else if (m.loaded) badge = '<span class="badge loaded">已加载</span>';
      else if (m.installed) badge = '<span class="badge installed">已安装</span>';

      const actions = [];
      if (!m.installed && dl.status !== 'downloading') {
        actions.push(`<button class="btn sm" data-act="download" data-key="${m.key}">下载</button>`);
      }
      if (dl.status === 'downloading') {
        actions.push('<button class="btn sm" disabled>下载中…</button>');
      }
      if (m.loaded) {
        actions.push(`<button class="btn sm" data-act="unload" data-key="${m.key}">卸载</button>`);
      } else {
        actions.push(`<button class="btn sm primary" data-act="load" data-key="${m.key}">加载</button>`);
      }
      return `
        <div class="model-card">
          <div class="m-top">
            <div>
              <h3>${esc(m.label)}</h3>
              <div class="repo">${esc(m.repo)}</div>
            </div>
            ${badge}
          </div>
          <div class="m-specs">
            <div class="m-spec"><span class="k">Encoder</span><span class="v">${esc(m.encoder)}</span></div>
            <div class="m-spec"><span class="k">Params</span><span class="v">${esc(m.params)}</span></div>
            <div class="m-spec"><span class="k">Context</span><span class="v">${esc(m.context)}</span></div>
            <div class="m-spec"><span class="k">Key</span><span class="v">${esc(m.key)}</span></div>
          </div>
          <div class="m-use">${esc(m.use_for)}${m.installed_at ? ' · 安装于 ' + esc(m.installed_at) : ''}</div>
          <div class="m-actions">${actions.join('')}</div>
          ${dl.status === 'error' ? `<div class="m-error">${esc(dl.error || '未知错误')}</div>` : ''}
        </div>`;
    }).join('');

    $$('#model-grid [data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { act, key } = btn.dataset;
        btn.disabled = true;
        try {
          await api(`/api/models/${key}/${act}`, { method: 'POST' });
          if (act === 'download') toast(`${key} 开始下载（走 HF 镜像），完成后出现安装徽章`, 'ok');
          else toast(`${key} ${act === 'load' ? '加载' : '卸载'}完成`, 'ok');
          loadModels();
          refreshStatus();
          if (act === 'download') setTimeout(loadModels, 1500);
        } catch (e) {
          toast(`${act} 失败：${e.message}`, 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    $('#model-grid').innerHTML = `<div class="empty-state">加载失败：${esc(e.message)}</div>`;
  }
}

/* ================= 历史 ================= */

async function loadHistory(reset) {
  if (reset) { S.history.offset = 0; S.history.selected.clear(); }
  const params = new URLSearchParams({
    limit: S.history.limit,
    offset: S.history.offset,
  });
  const q = $('#history-q').value.trim();
  const status = $('#history-status').value;
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  try {
    const data = await api(`/api/history?${params}`);
    S.history.total = data.total;
    renderHistory(data.runs, reset);
  } catch (e) {
    toast('历史加载失败：' + e.message, 'error');
  }
}

function renderHistory(runs, reset) {
  const body = $('#history-body');
  if (reset) body.innerHTML = '';
  if (!runs.length && reset) {
    body.innerHTML = '<tr><td colspan="9"><div class="empty-state slim">还没有推理记录</div></td></tr>';
  } else {
    body.innerHTML += runs.map(r => `
      <tr data-id="${r.id}">
        <td class="col-chk"><input type="checkbox" class="row-chk" data-id="${r.id}"
            ${S.history.selected.has(r.id) ? 'checked' : ''}></td>
        <td class="mono">${r.id}</td>
        <td class="muted">${esc(fmtTime(r.created_at))}</td>
        <td>${esc(r.source)}</td>
        <td class="mono">${esc(r.model_routed || '—')}</td>
        <td class="lat">${r.latency_ms != null ? Number(r.latency_ms).toFixed(1) + ' ms' : '—'}</td>
        <td class="status-${r.status === 'ok' ? 'ok' : 'error'}">${esc(r.status)}</td>
        <td class="summary-cell">${esc(r.state_preview || '')}</td>
        <td><button class="btn sm ghost" data-open="${r.id}">查看</button></td>
      </tr>`).join('');
  }
  const shown = body.querySelectorAll('tr[data-id]').length;
  $('#history-count').textContent = `共 ${S.history.total} 条 · 已显示 ${shown}`;
  $('#btn-more').classList.toggle('hidden', shown >= S.history.total);

  $$('#history-body tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      openRunDetail(Number(tr.dataset.id));
    });
  });
  $$('.row-chk', body).forEach(chk => {
    chk.addEventListener('change', () => {
      const id = Number(chk.dataset.id);
      chk.checked ? S.history.selected.add(id) : S.history.selected.delete(id);
      chk.closest('tr').classList.toggle('selected', chk.checked);
    });
  });
}

async function openRunDetail(id) {
  try {
    const run = await api(`/api/history/${id}`);
    S.runDetail = run;
    $('#hd-id').textContent = `#${run.id}`;
    const blocks = [
      ['State', typeof run.state === 'string' ? run.state : pretty(run.state)],
      ['Questions', pretty(run.questions)],
      ['Answers', pretty(run.answers)],
      ['Routing / Usage', pretty({ routing: run.routing, usage: run.usage })],
    ];
    if (run.error) blocks.push(['Error', run.error]);
    $('#hd-body').innerHTML = blocks.map(([title, content]) => `
      <div class="detail-block"><h3>${esc(title)}</h3><pre>${esc(content)}</pre></div>`).join('');
    $('#history-detail').classList.remove('hidden');
    $('#history-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function exportSelected() {
  const ids = [...S.history.selected];
  try {
    const payload = ids.length ? { run_ids: ids } : {};
    const out = await api('/api/dataset/export', { method: 'POST', body: payload });
    toast(`已导出 ${out.rows} 条 → ${out.filename}`, 'ok');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

/* ================= 评估 ================= */

async function loadEvalJobs() {
  try {
    const jobs = await api('/api/eval');
    const wrap = $('#eval-list');
    if (!jobs.length) {
      wrap.innerHTML = '<div class="empty-state slim">还没有评估任务</div>';
    } else {
      wrap.innerHTML = jobs.map(j => {
        const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
        const acc = j.metrics && j.metrics.overall_accuracy != null
          ? ` · acc ${(j.metrics.overall_accuracy * 100).toFixed(1)}%` : '';
        return `
          <div class="job ${S.evalSelected === j.id ? 'active' : ''}" data-id="${j.id}">
            <div class="job-top">
              <span class="job-name">${esc(j.name)}</span>
              <span class="job-status ${esc(j.status)}">${esc(j.status)}</span>
            </div>
            <div class="job-meta">#${j.id} · ${j.done}/${j.total} · ${esc(j.backend || '')} ${acc}</div>
            <div class="progress"><i style="width:${j.status === 'done' ? 100 : pct}%"></i></div>
          </div>`;
      }).join('');
      $$('.job', wrap).forEach(node => {
        node.addEventListener('click', () => openEvalDetail(Number(node.dataset.id)));
      });
      if (jobs.some(j => j.status === 'running')) {
        setTimeout(() => { if (S.view === 'eval') loadEvalJobs(); }, 1200);
      }
    }
    if (S.evalSelected && jobs.some(j => j.id === S.evalSelected && j.status === 'running')) {
      openEvalDetail(S.evalSelected);
    }
  } catch (e) {
    toast('任务列表加载失败：' + e.message, 'error');
  }
}

async function openEvalDetail(id) {
  S.evalSelected = id;
  try {
    const job = await api(`/api/eval/${id}?items=100`);
    const m = job.metrics || {};
    const metrics = Object.entries(m).map(([k, v]) => `
      <div class="metric"><span class="k">${esc(k)}</span>
      <span class="v">${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : esc(v)}</span></div>`).join('');
    const rows = (job.items || []).map(it => `
      <tr>
        <td>${it.idx}</td>
        <td class="summary-cell">${esc(typeof it.state === 'string' ? it.state.slice(0, 80) : JSON.stringify(it.state).slice(0, 80))}</td>
        <td class="mono">${esc(JSON.stringify(it.expected || {}))}</td>
        <td class="mono">${esc(JSON.stringify(summarizeAnswers(it.predicted)))}</td>
        <td>${it.error ? '<span class="status-error">err</span>'
          : it.correct ? '<span class="status-ok">✓</span>' : '<span class="status-error">✗</span>'}</td>
      </tr>`).join('');
    $('#eval-detail').classList.remove('hidden');
    $('#eval-detail').innerHTML = `
      <div class="card-head">
        <h2>任务 #${job.id} · ${esc(job.name)}
          <span class="sub">${esc(job.status)} · ${job.done}/${job.total}</span></h2>
        <div class="head-tools">
          ${job.status === 'running' ? `<button class="btn sm" id="ev-cancel">取消</button>` : ''}
          <button class="btn sm ghost danger" id="ev-delete">删除</button>
        </div>
      </div>
      <div class="metrics">${metrics || '<span class="muted small">尚无指标</span>'}</div>
      <div class="table-wrap" style="margin-top:14px">
        <table class="table">
          <thead><tr><th>#</th><th>State</th><th>Expected</th><th>Predicted</th><th>判定</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    $('#ev-delete').addEventListener('click', async () => {
      if (!confirm(`删除评估任务 #${job.id}？其逐条结果会一并删除。`)) return;
      await api(`/api/eval/${job.id}`, { method: 'DELETE' });
      S.evalSelected = null;
      $('#eval-detail').classList.add('hidden');
      loadEvalJobs();
      toast('任务已删除');
    });
    const cancelBtn = $('#ev-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        await api(`/api/eval/${job.id}/cancel`, { method: 'POST' });
        loadEvalJobs();
      });
    }
    $('#eval-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function summarizeAnswers(answers) {
  if (!answers) return {};
  const out = {};
  for (const [qid, a] of Object.entries(answers)) {
    if (a.type === 'choice') out[qid] = a.choice;
    else if (a.type === 'score') out[qid] = a.score;
    else out[qid] = a.noul;
  }
  return out;
}

async function startEval() {
  const dataset = $('#eval-dataset').value;
  const name = $('#eval-name').value.trim();
  const model = $('#eval-model').value;
  try {
    const body = { dataset };
    if (name) body.name = name;
    if (model) body.model = model;
    const out = await api('/api/eval', { method: 'POST', body });
    toast(`评估任务 #${out.id} 已启动`, 'ok');
    $('#eval-dataset').value = '';
    loadEvalJobs();
  } catch (e) {
    toast('启动失败：' + e.message, 'error');
  }
}

/* ================= 设置 ================= */

const SETTING_FIELDS = [
  'backend', 'device', 'max_concurrent', 'hf_endpoint',
  'api_key', 'record_history', 'option_warn_threshold', 'port',
];

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    SETTING_FIELDS.forEach(k => {
      const node = $(`#set-${k}`);
      if (node) node.value = s[k] ?? '';
    });
    if (S.status) $('#settings-path').textContent = `数据目录：${S.status.data_dir}`;
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function saveSettings() {
  const payload = {};
  SETTING_FIELDS.forEach(k => {
    const node = $(`#set-${k}`);
    if (node) payload[k] = node.value;
  });
  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    toast('设置已保存', 'ok');
    refreshStatus();
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

/* ================= 观测台 ================= */

async function loadMonitor() {
  try {
    renderMonitor(await api('/api/stats'));
  } catch (_) {
    /* 轮询失败静默，状态栏会显示离线 */
  }
}

function renderMonitor(s) {
  renderKpis(s);
  renderLatency(s.latency || {});
  renderRing(s.routing || {});
  renderScripts(s.scripts || {});
  renderIntents(s.intents || {});
  renderHourly(s.hourly || []);
  renderEvents(s.recent || []);
}

function flashCard(id) {
  const card = document.getElementById(id)?.closest('.card');
  if (!card) return;
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

function animateNumber(id, to, { decimals = 0, suffix = '' } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (to == null || Number.isNaN(Number(to))) {
    MON.kpiValues[id] = null;
    el.textContent = '—';
    return;
  }
  const target = Number(to);
  const from = MON.kpiValues[id];
  MON.kpiValues[id] = target;
  const paint = v => {
    el.innerHTML = v.toFixed(decimals) +
      (suffix ? `<span class="unit">${esc(suffix)}</span>` : '');
  };
  if (from == null || from === target) { paint(target); return; }
  flashCard(id);
  const t0 = performance.now();
  const dur = 480;
  const step = t => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    paint(from + (target - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderKpis(s) {
  const t = s.totals || {};
  const lat = s.latency || {};
  const live = s.live || {};
  animateNumber('kpi-runs', t.runs ?? 0);
  $('#kpi-runs-sub').textContent = `今日 ${t.today ?? 0} · 错误 ${t.error ?? 0}`;
  const avg = msUnit(lat.avg);
  animateNumber('kpi-avg', avg.val, { decimals: avg.dec, suffix: avg.suffix });
  $('#kpi-avg-sub').textContent = `p50 ${fmtMsText(lat.p50)}`;
  const p95 = msUnit(lat.p95);
  animateNumber('kpi-p95', p95.val, { decimals: p95.dec, suffix: p95.suffix });
  $('#kpi-p95-sub').textContent = `max ${fmtMsText(lat.max)}`;
  const total = (t.ok ?? 0) + (t.error ?? 0);
  const rate = total ? ((t.ok / total) * 100) : null;
  animateNumber('kpi-rate', rate, { decimals: 1, suffix: '%' });
  $('#kpi-rate-sub').textContent = `扫描窗口 ${total} 条`;
  animateNumber('kpi-inflight', live.in_flight ?? 0);
  $('#kpi-inflight-sub').textContent = `上限 ${live.max_concurrent ?? '—'} · ${live.backend || ''}`;
}

/* 延迟 ≥10s 显示为秒，避免 14067 ms 这种大数 */
function msUnit(v) {
  if (v == null || Number.isNaN(Number(v))) return { val: null, dec: 0, suffix: 'ms' };
  if (Number(v) >= 10000) return { val: Number(v) / 1000, dec: 1, suffix: 's' };
  return { val: Number(v), dec: Number(v) < 100 ? 1 : 0, suffix: 'ms' };
}

function fmtMsText(v) {
  if (v == null) return '—';
  const n = Number(v);
  return n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${v} ms`;
}

function renderLatency(lat) {
  const svg = document.getElementById('lat-svg');
  if (!svg) return;
  const data = (lat.recent || []).slice(-60);
  const nowBadge = document.getElementById('lat-now');
  const legend = document.getElementById('lat-legend');
  if (!data.length) {
    svg.innerHTML = '<text x="320" y="94" text-anchor="middle" fill="#6E7681" font-size="13">暂无推理数据</text>';
    nowBadge.textContent = '— ms';
    legend.innerHTML = '';
    return;
  }
  const W = 640, H = 180, padL = 40, padR = 10, padT = 14, padB = 22;
  const max = Math.max(...data) * 1.15 || 10;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = i => padL + (data.length === 1 ? innerW / 2 : (i * innerW) / (data.length - 1));
  const y = v => padT + innerH - (v / max) * innerH;
  let line = '';
  data.forEach((v, i) => { line += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const area = `${line}L${x(data.length - 1).toFixed(1)},${padT + innerH}L${x(0).toFixed(1)},${padT + innerH}Z`;
  const gridVals = [max * 0.25, max * 0.5, max * 0.75];
  const fmtAxis = v => (v >= 10000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v)));
  const grid = gridVals.map(v =>
    `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}"
           stroke="#262C33" stroke-width="1"/>
     <text x="${padL - 6}" y="${y(v).toFixed(1)}" text-anchor="end" dy="3.5"
           font-size="10" fill="#6E7681" font-family="monospace">${fmtAxis(v)}</text>`).join('');
  const lx = x(data.length - 1), ly = y(data[data.length - 1]);
  svg.innerHTML = `
    <defs>
      <linearGradient id="latGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4F8CFF" stop-opacity="0.34"/>
        <stop offset="100%" stop-color="#4F8CFF" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="latStroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#3D7CFF" stop-opacity="0.5"/>
        <stop offset="100%" stop-color="#6BA1FF" stop-opacity="1"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${area}" fill="url(#latGrad)"/>
    <path d="${line}" fill="none" stroke="url(#latStroke)" stroke-width="1.6"
          stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="#4F8CFF" opacity="0.22">
      <animate attributeName="r" values="5;10;5" dur="1.6s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.30;0.05;0.30" dur="1.6s" repeatCount="indefinite"/>
    </circle>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.4" fill="#4F8CFF"
            stroke="#0D1117" stroke-width="1.5"/>`;
  const last = data[data.length - 1];
  nowBadge.textContent = `${last < 10 ? last.toFixed(1) : Math.round(last)} ms`;
  legend.innerHTML =
    `<span>min <b>${fmtMsText(lat.min)}</b></span>` +
    `<span>avg <b>${fmtMsText(lat.avg)}</b></span>` +
    `<span>p95 <b>${fmtMsText(lat.p95)}</b></span>` +
    `<span>max <b>${fmtMsText(lat.max)}</b></span>` +
    `<span>点数 <b>${data.length}</b></span>`;
}

function renderRing(routing) {
  const svg = document.getElementById('route-ring');
  const legend = document.getElementById('route-legend');
  if (!svg) return;
  const entries = Object.entries(routing);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) {
    svg.innerHTML = '<text x="60" y="64" text-anchor="middle" font-size="11" fill="#6E7681">暂无</text>';
    legend.innerHTML = '<span class="muted small">等待数据</span>';
    return;
  }
  const R = 44, C = 2 * Math.PI * R;
  let acc = 0;
  const segs = entries.map(([name, n], i) => {
    const frac = n / total;
    const color = ROUTE_COLORS[name] || ROUTE_FALLBACK[i % ROUTE_FALLBACK.length];
    const seg = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${color}" stroke-width="13"
        stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"
        stroke-dashoffset="${(-acc * C).toFixed(2)}"
        transform="rotate(-90 60 60)"><title>${esc(name)}: ${n}</title></circle>`;
    acc += frac;
    return seg;
  }).join('');
  svg.innerHTML = `
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="#21262D" stroke-width="13"/>
    ${segs}
    <text class="ring-center" x="60" y="58" text-anchor="middle">${total}</text>
    <text class="ring-center-sub" x="60" y="74" text-anchor="middle">ROUTES</text>`;
  legend.innerHTML = entries.map(([name, n], i) => {
    const color = ROUTE_COLORS[name] || ROUTE_FALLBACK[i % ROUTE_FALLBACK.length];
    return `<div class="ring-leg-row">
      <span class="dot" style="background:${color}"></span>
      <span class="name">${esc(name)}</span>
      <span class="num">${n} · ${((n / total) * 100).toFixed(0)}%</span>
    </div>`;
  }).join('');
}

function renderScripts(scripts) {
  const wrap = document.getElementById('script-chips');
  const entries = Object.entries(scripts);
  wrap.innerHTML = entries.length
    ? entries.map(([name, n]) =>
        `<span class="stat-chip">${esc(name)} <b>${n}</b></span>`).join('')
    : '<span class="muted small">暂无检测记录（mock 后端不含 detection）</span>';
}

function renderIntents(intents) {
  const wrap = document.getElementById('intent-bars');
  const entries = Object.entries(intents).slice(0, 8);
  if (!entries.length) {
    wrap.innerHTML = '<div class="empty-state slim">暂无 choice 决策</div>';
    return;
  }
  const max = Math.max(...entries.map(([, n]) => n));
  wrap.innerHTML = entries.map(([label, n], i) => `
    <div class="bar-row ${i === 0 ? 'top' : ''}">
      <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${((n / max) * 100).toFixed(1)}%"></div></div>
      <span class="bar-val">${n}</span>
    </div>`).join('');
}

function renderHourly(hourly) {
  const svg = document.getElementById('hourly-svg');
  if (!svg) return;
  if (!hourly.length) { svg.innerHTML = ''; return; }
  const W = 300, H = 170, padL = 26, padR = 6, padT = 12, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...hourly.map(h => h.count), 1);
  const slot = innerW / hourly.length;
  const bw = slot * 0.58;
  const bars = hourly.map((h, i) => {
    const bh = (h.count / max) * innerH;
    const bx = padL + i * slot + (slot - bw) / 2;
    const by = padT + innerH - bh;
    const label = i % 3 === 0
      ? `<text x="${(bx + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle"
               font-size="9" fill="#6E7681" font-family="monospace">${esc(h.hour)}</text>` : '';
    return `${h.count ? `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${Math.max(bh, 1.5).toFixed(1)}" rx="2.5" fill="#4F8CFF" opacity="0.85">
        <title>${esc(h.hour)} · ${h.count}</title></rect>` : ''}
      ${label}`;
  }).join('');
  const baseline = padT + innerH;
  svg.innerHTML = `
    <line x1="${padL}" y1="${baseline}" x2="${W - padR}" y2="${baseline}" stroke="#30363D" stroke-width="1"/>
    <text x="${padL - 5}" y="${padT + 4}" text-anchor="end" font-size="9" fill="#6E7681"
          font-family="monospace">${max}</text>
    ${bars}`;
}

function renderEvents(events) {
  const wrap = document.getElementById('event-stream');
  if (!events.length) {
    wrap.innerHTML = '<div class="empty-state slim">等待第一次推理…</div>';
    return;
  }
  wrap.innerHTML = events.map(ev => {
    const fresh = !MON.firstEventLoad && !MON.seenEvents.has(ev.id);
    MON.seenEvents.add(ev.id);
    const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    return `
      <div class="event ${fresh ? 'fresh' : ''}">
        <span class="ev-dot ${ev.status === 'ok' ? '' : 'error'}"></span>
        <div class="ev-body">
          <div class="ev-top">
            <span class="ev-id">#${ev.id}</span>
            <span class="ev-route">${esc(ev.model_routed || 'auto')}</span>
            <span class="ev-lat">${ev.latency_ms != null ? Number(ev.latency_ms).toFixed(1) + ' ms' : '—'}</span>
          </div>
          <div class="ev-prev" title="${esc(ev.preview)}">${esc(ev.preview)}</div>
          <div class="ev-time">${esc(time)} · ${esc(ev.source || '')}</div>
        </div>
      </div>`;
  }).join('');
  MON.firstEventLoad = false;
}

/* ================= 初始化 ================= */

function bindEvents() {
  window.addEventListener('hashchange', route);

  // 跳过链接：直接聚焦主区，不改动 hash（否则会被路由当成未知视图）
  $('.skip-link')?.addEventListener('click', e => {
    e.preventDefault();
    const root = $('#view-root');
    root.setAttribute('tabindex', '-1');
    root.focus({ preventScroll: false });
  });

  $('#btn-run').addEventListener('click', runDecision);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.view === 'playground') {
      e.preventDefault();
      runDecision();
    }
  });
  $('#state-input').addEventListener('input', updateStateMeta);
  $('#questions-input').addEventListener('input', checkOptionWarn);
  $('#btn-format').addEventListener('click', () => {
    try {
      $('#questions-input').value = pretty(parseQuestionsInput());
      checkOptionWarn();
      toast('已格式化');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  $('#history-q').addEventListener('input', debounce(() => loadHistory(true), 350));
  $('#history-status').addEventListener('change', () => loadHistory(true));
  $('#btn-more').addEventListener('click', () => {
    S.history.offset += S.history.limit;
    loadHistory(false);
  });
  $('#chk-all').addEventListener('change', e => {
    $$('.row-chk').forEach(chk => {
      chk.checked = e.target.checked;
      const id = Number(chk.dataset.id);
      e.target.checked ? S.history.selected.add(id) : S.history.selected.delete(id);
      chk.closest('tr').classList.toggle('selected', chk.checked);
    });
  });
  $('#btn-export').addEventListener('click', exportSelected);
  $('#btn-clear-history').addEventListener('click', async () => {
    if (!confirm('确定清空全部推理历史？')) return;
    try {
      const out = await api('/api/history/clear', { method: 'POST' });
      toast(`已删除 ${out.deleted} 条`, 'ok');
      loadHistory(true);
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#hd-close').addEventListener('click', () => $('#history-detail').classList.add('hidden'));
  $('#hd-delete').addEventListener('click', async () => {
    if (!S.runDetail) return;
    if (!confirm(`删除推理记录 #${S.runDetail.id}？此操作不可恢复。`)) return;
    try {
      await api(`/api/history/${S.runDetail.id}`, { method: 'DELETE' });
      $('#history-detail').classList.add('hidden');
      S.runDetail = null;
      loadHistory(true);
      toast('已删除');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#hd-reuse').addEventListener('click', () => {
    const run = S.runDetail;
    if (!run) return;
    $('#state-input').value = typeof run.state === 'string' ? run.state : pretty(run.state);
    $('#questions-input').value = pretty(run.questions);
    updateStateMeta();
    checkOptionWarn();
    location.hash = '#playground';
    toast('已载入调试台');
  });

  $('#btn-eval-run').addEventListener('click', startEval);
  $('#btn-eval-refresh').addEventListener('click', loadEvalJobs);
  $('#eval-sample').addEventListener('click', e => {
    e.preventDefault();
    $('#eval-dataset').value = EVAL_SAMPLE;
    toast('示例数据集已填入');
  });

  $('#btn-settings-save').addEventListener('click', saveSettings);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function init() {
  bindEvents();
  $('#state-input').value = DEFAULT_STATE;
  $('#questions-input').value = pretty(DEFAULT_QUESTIONS);
  updateStateMeta();
  route();
  try {
    S.presets = await api('/api/presets');
    loadPresetChips();
  } catch (_) { /* 预设失败不阻塞 */ }
  await refreshStatus();
  checkOptionWarn();
  setInterval(refreshStatus, 5000);
}

document.addEventListener('DOMContentLoaded', init);
