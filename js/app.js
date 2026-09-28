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
  logTimer: null,
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

/* 内置示例：客服工单案例（一键填充） */
const EXAMPLE_TEMPLATE = {
  state: '用户来信：这个月被重复扣款了两次，请今天把多收的钱退回来，不然我们就不续费了。工单编号 TK-2048。',
  questions: {
    department: {
      type: 'choice',
      instructions: '这个工单应该由哪个部门处理？',
      criteria: {
        billing: '发票、支付、退款',
        technical: '故障、宕机、报错',
        sales: '报价、合同、升级',
        other: '其他一切',
      },
    },
    urgency: {
      type: 'score',
      instructions: '这个请求有多紧急？',
      criteria: ['不紧急', '尽快处理', '紧急阻断'],
    },
    churn_risk: {
      type: 'noul',
      instructions: '用户是否威胁取消或不再续费？',
    },
  },
};

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
const VIEWS = ['playground', 'monitor', 'models', 'history', 'eval', 'logs', 'settings'];

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
  if (MON.logTimer) { clearInterval(MON.logTimer); MON.logTimer = null; }
  if (view === 'monitor') {
    loadMonitor();
    MON.timer = setInterval(loadMonitor, 3000);
  }
  if (view === 'logs') {
    loadLogs();
    MON.logTimer = setInterval(() => { if (S.view === 'logs') loadLogs(); }, 3000);
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
    const devPill = $('#pill-device');
    devPill.textContent = `device: ${st.device_resolved || st.device}`;
    if (st.device_fallback) {
      devPill.classList.add('warn');
      devPill.title = `设置为 ${st.device}，实际执行设备 ${st.device_resolved || '未知'}`;
    } else {
      devPill.classList.remove('warn');
      devPill.removeAttribute('title');
    }
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

/* ================= 调试台（简易表单 → 拼装 Laya 输入） ================= */
/* UI 只负责收集到 S.form；拼装统一走 buildPayload()，与 core 解耦 */

const TEMPLATE_KEY = 'layastudio.form-template.v1';
const ONBOARD_KEY = 'layastudio.onboarded.v1';
const THRESH_KEY = 'layastudio.threshold';
let uidSeq = 1;
const nextUid = () => uidSeq++;

function defaultSingle() {
  return { key: 'intent', instructions: '', options: '', levels: '' };
}

function defaultForm() {
  return {
    stateMode: 'text',
    stateText: '',
    mode: 'choice',
    single: defaultSingle(),
    batch: [],
    model: '',
  };
}

S.form = defaultForm();

function blankTask(type) {
  return { uid: nextUid(), type: type || 'choice', key: '', instructions: '', options: '', levels: '' };
}

/* ---- 行文本解析 ---- */
function parseOptionLines(text) {
  const out = [];
  (text || '').split('\n').forEach(line => {
    const s = line.trim();
    if (!s) return;
    const m = s.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (m) out.push({ key: m[1].trim(), desc: m[2].trim() });
    else out.push({ key: s, desc: '' });
  });
  return out;
}

function parseLevelLines(text) {
  return (text || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function linesFromCriteria(crit) {
  if (Array.isArray(crit)) return crit.join('\n');
  if (crit && typeof crit === 'object') {
    return Object.entries(crit).map(([k, v]) => `${k}: ${v ?? ''}`).join('\n');
  }
  return '';
}

function questionsToBatch(qs) {
  return Object.entries(qs || {}).map(([key, q]) => ({
    uid: nextUid(),
    type: ['choice', 'score', 'noul'].includes(q.type) ? q.type : 'choice',
    key,
    instructions: q.instructions || '',
    options: q.type === 'choice' ? linesFromCriteria(q.criteria) : '',
    levels: q.type === 'score' ? linesFromCriteria(q.criteria) : '',
  }));
}

/* ---- 状态 → 表单（预设 / 示例 / 历史回填 共用） ---- */
function applyPayloadToForm(state, questions) {
  const f = S.form;
  if (typeof state === 'string') {
    f.stateMode = 'text';
    f.stateText = state;
  } else {
    f.stateMode = 'json';
    f.stateText = pretty(state);
  }
  const batch = questionsToBatch(questions);
  if (batch.length === 1) {
    const t = batch[0];
    f.mode = t.type;
    f.single = { key: t.key, instructions: t.instructions, options: t.options, levels: t.levels };
    f.batch = [];
  } else {
    f.mode = 'batch';
    f.batch = batch;
  }
  renderAll();
  syncAdvanced();
}

/* ---- 渲染：单任务表单（标签在上、控件在下） ---- */
function renderTaskForm() {
  const f = S.form;
  const singleWrap = $('#single-task-form');
  const batchWrap = $('#batch-tasks');
  const title = $('#task-form-title');
  const sub = $('#task-form-sub');

  if (f.mode === 'batch') {
    singleWrap.hidden = true;
    batchWrap.hidden = false;
    title.textContent = '批量多任务';
    sub.textContent = `已添加 ${f.batch.length} 个任务 · 任务 Key 不可重复`;
    renderBatch();
    return;
  }

  singleWrap.hidden = false;
  batchWrap.hidden = true;
  const titles = { choice: 'Choice 分类决策', score: 'Score 等级打分', noul: 'Noul 是非判断' };
  title.textContent = titles[f.mode] || '任务表单';
  sub.textContent = '一题只判断一件事；复杂情况拆成多题，结果在代码里组合 — 无需编写 JSON';

  const t = f.single;
  let extra = '';
  if (f.mode === 'choice') {
    extra = `
      <div class="field">
        <label class="field-label" for="f-options">候选选项（一行一条，格式 key:描述）</label>
        <textarea id="f-options" class="input-area mono" rows="6" spellcheck="false"
          placeholder="billing: 发票、支付、退款&#10;technical: 故障、宕机、报错&#10;other: 其他一切">${esc(t.options)}</textarea>
        <p class="field-hint" id="f-options-count"></p>
        <p class="field-error" id="err-options" hidden></p>
      </div>`;
  } else if (f.mode === 'score') {
    extra = `
      <div class="field">
        <label class="field-label" for="f-levels">等级列表（一行一个等级，由低到高）</label>
        <textarea id="f-levels" class="input-area" rows="4" spellcheck="false"
          placeholder="不紧急&#10;尽快处理&#10;紧急阻断">${esc(t.levels)}</textarea>
        <p class="field-hint" id="f-levels-count"></p>
        <p class="field-error" id="err-levels" hidden></p>
      </div>`;
  }
  singleWrap.innerHTML = `
    <div class="field">
      <label class="field-label" for="f-key">任务标识 Key（英文，如 intent）</label>
      <input id="f-key" class="input" spellcheck="false" placeholder="如 intent" value="${esc(t.key)}">
      <p class="field-error" id="err-key" hidden></p>
    </div>
    <div class="field">
      <label class="field-label" for="f-instr">判断指令 instructions</label>
      <textarea id="f-instr" class="input-area" rows="2"
        placeholder="用一句话告诉模型如何判断…">${esc(t.instructions)}</textarea>
      <p class="field-error" id="err-instr" hidden></p>
    </div>
    ${extra}`;
  updateCounts();
}

/* ---- 渲染：批量任务卡片 ---- */
function batchCardHtml(t, index) {
  const isB = t.type === 'choice';
  const isS = t.type === 'score';
  let extra = '';
  if (isB) {
    extra = `
      <div class="field">
        <label class="field-label" for="bo-${t.uid}">候选选项（一行一条，格式 key:描述）</label>
        <textarea id="bo-${t.uid}" class="input-area mono" rows="5" spellcheck="false"
          data-field="options" data-uid="${t.uid}"
          placeholder="billing: 发票、支付、退款&#10;technical: 故障、宕机、报错">${esc(t.options)}</textarea>
        <p class="field-error" id="err-options-${t.uid}" hidden></p>
      </div>`;
  } else if (isS) {
    extra = `
      <div class="field">
        <label class="field-label" for="bl-${t.uid}">等级列表（一行一个等级，由低到高）</label>
        <textarea id="bl-${t.uid}" class="input-area" rows="4" spellcheck="false"
          data-field="levels" data-uid="${t.uid}"
          placeholder="不紧急&#10;尽快处理&#10;紧急阻断">${esc(t.levels)}</textarea>
        <p class="field-error" id="err-levels-${t.uid}" hidden></p>
      </div>`;
  }
  return `
    <div class="batch-card" data-uid="${t.uid}">
      <div class="batch-head">
        <span class="batch-index">任务 ${index + 1}</span>
        <select class="select" data-field="type" data-uid="${t.uid}" aria-label="任务 ${index + 1} 类型">
          <option value="choice" ${t.type === 'choice' ? 'selected' : ''}>Choice 分类</option>
          <option value="score" ${t.type === 'score' ? 'selected' : ''}>Score 打分</option>
          <option value="noul" ${t.type === 'noul' ? 'selected' : ''}>Noul 判断</option>
        </select>
        <button type="button" class="batch-remove" data-remove="${t.uid}"
          title="删除该任务" aria-label="删除任务 ${index + 1}">✕</button>
      </div>
      <div class="field">
        <label class="field-label" for="bk-${t.uid}">任务标识 Key（英文）</label>
        <input id="bk-${t.uid}" class="input" spellcheck="false" placeholder="如 intent"
          data-field="key" data-uid="${t.uid}" value="${esc(t.key)}">
        <p class="field-error" id="err-key-${t.uid}" hidden></p>
      </div>
      <div class="field">
        <label class="field-label" for="bi-${t.uid}">判断指令 instructions</label>
        <textarea id="bi-${t.uid}" class="input-area" rows="2" data-field="instructions" data-uid="${t.uid}"
          placeholder="用一句话告诉模型如何判断…">${esc(t.instructions)}</textarea>
        <p class="field-error" id="err-instr-${t.uid}" hidden></p>
      </div>
      ${extra}
    </div>`;
}

function renderBatch() {
  const wrap = $('#batch-tasks');
  wrap.innerHTML = S.form.batch.map((t, i) => batchCardHtml(t, i)).join('') +
    `<button type="button" class="batch-add" id="batch-add">＋ 添加一个任务</button>`;
}

/* ---- DOM → S.form ---- */
function syncFromDom() {
  const f = S.form;
  const state = $('#f-state');
  if (state) f.stateText = state.value;
  const sm = document.querySelector('input[name="state-mode"]:checked');
  if (sm) f.stateMode = sm.value;
  const tm = document.querySelector('input[name="task-mode"]:checked');
  if (tm) f.mode = tm.value;
  const ms = $('#model-select');
  if (ms) f.model = ms.value;

  if (f.mode === 'batch') {
    f.batch.forEach(t => {
      const card = document.querySelector(`.batch-card[data-uid="${t.uid}"]`);
      if (!card) return;
      const g = name => {
        const el = card.querySelector(`[data-field="${name}"]`);
        return el ? el.value : undefined;
      };
      const type = g('type'); if (type !== undefined) t.type = type;
      const key = g('key'); if (key !== undefined) t.key = key;
      const instr = g('instructions'); if (instr !== undefined) t.instructions = instr;
      const opts = g('options'); if (opts !== undefined) t.options = opts;
      const lv = g('levels'); if (lv !== undefined) t.levels = lv;
    });
  } else {
    const key = $('#f-key'); if (key) f.single.key = key.value;
    const instr = $('#f-instr'); if (instr) f.single.instructions = instr.value;
    const opts = $('#f-options'); if (opts) f.single.options = opts.value;
    const lv = $('#f-levels'); if (lv) f.single.levels = lv.value;
  }
}

function updateStateMeta() {
  const el = $('#f-state');
  const meta = $('#f-state-meta');
  if (el && meta) meta.textContent = `${el.value.length} 字符`;
}

function updateCounts() {
  const f = S.form;
  const threshold = (S.status && S.status.option_warn_threshold) || 20;
  const optHint = $('#f-options-count');
  if (optHint) {
    const n = parseOptionLines(f.single.options).length;
    optHint.textContent = n > threshold
      ? `共 ${n} 条 · 超过建议上限 ${threshold} 条：高选项场景准确率明显下降，建议分层拆分任务（先粗分类、再细分类）`
      : `共 ${n} 条 · 建议 ≤ ${threshold} 条`;
    optHint.classList.toggle('warn', n > threshold);
  }
  const lvHint = $('#f-levels-count');
  if (lvHint) lvHint.textContent = `共 ${parseLevelLines(f.single.levels).length} 级`;
}

/* ---- 校验 + 拼装：S.form → {state, questions}（核心解耦函数） ---- */
function buildPayload() {
  syncFromDom();
  const f = S.form;
  const errors = [];   // {el, errId, msg}

  // ---- state ----
  let state = '';
  const rawState = f.stateText;
  if (!rawState.trim()) {
    errors.push({ el: 'f-state', errId: 'f-state-err',
      msg: 'State 内容不能为空：请粘贴工单、邮件或消息原文' });
  } else if (f.stateMode === 'json') {
    try {
      state = JSON.parse(rawState);
    } catch (e) {
      errors.push({ el: 'f-state', errId: 'f-state-err', msg: 'JSON 格式错误：' + e.message });
      state = rawState;
    }
  } else {
    state = rawState;
  }

  // ---- questions ----
  const isBatch = f.mode === 'batch';
  const tasks = isBatch
    ? f.batch.map((t, i) => ({ ...t, label: `任务 ${i + 1}` }))
    : [{ ...f.single, uid: 0, type: f.mode, label: '' }];
  if (isBatch && f.batch.length === 0) {
    errors.push({ el: 'batch-add', errId: null, msg: '至少需要 1 个任务卡片，请点击「添加一个任务」' });
  }

  const questions = {};
  const seen = new Set();
  tasks.forEach(t => {
    const pre = t.label ? `${t.label}：` : '';
    const errKey = isBatch ? `err-key-${t.uid}` : 'err-key';
    const errInstr = isBatch ? `err-instr-${t.uid}` : 'err-instr';
    const elKey = isBatch ? `bk-${t.uid}` : 'f-key';
    const elInstr = isBatch ? `bi-${t.uid}` : 'f-instr';

    const key = (t.key || '').trim();
    if (!key) {
      errors.push({ el: elKey, errId: errKey, msg: `${pre}任务标识 Key 不能为空` });
    } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      errors.push({ el: elKey, errId: errKey,
        msg: `${pre}Key 需以英文字母开头，只能含字母/数字/下划线，如 intent` });
    } else if (seen.has(key)) {
      errors.push({ el: elKey, errId: errKey, msg: `${pre}Key "${key}" 与其他任务重复，请更换` });
    } else {
      seen.add(key);
    }

    const instr = (t.instructions || '').trim();
    if (!instr) {
      errors.push({ el: elInstr, errId: errInstr, msg: `${pre}判断指令 instructions 不能为空` });
    }

    const question = { type: t.type, instructions: instr };
    if (t.type === 'choice') {
      const opts = parseOptionLines(t.options);
      const dup = opts.map(o => o.key).find((k, i, arr) => arr.indexOf(k) !== i);
      const errId = isBatch ? `err-options-${t.uid}` : 'err-options';
      const elId = isBatch ? `bo-${t.uid}` : 'f-options';
      if (opts.length < 2) {
        errors.push({ el: elId, errId, msg: `${pre}候选选项至少 2 条（一行一条，格式 key:描述）` });
      } else if (dup) {
        errors.push({ el: elId, errId, msg: `${pre}候选选项存在重复 key：「${dup}」` });
      }
      if (opts.length) question.criteria = Object.fromEntries(opts.map(o => [o.key, o.desc]));
    } else if (t.type === 'score') {
      const levels = parseLevelLines(t.levels);
      const errId = isBatch ? `err-levels-${t.uid}` : 'err-levels';
      const elId = isBatch ? `bl-${t.uid}` : 'f-levels';
      if (levels.length < 2) {
        errors.push({ el: elId, errId, msg: `${pre}等级列表至少 2 个等级（一行一个）` });
      }
      if (levels.length) question.criteria = levels;
    }

    // 预览尽力拼装：非法字段用占位，运行前 errors 必须清零
    questions[key || `untitled_${t.uid || 1}`] = question;
  });

  return {
    payload: { state, questions },
    errors,
    warnings: computeWarnings({ state, questions }),
  };
}

/* ---- 护栏 warnings：警告不阻断（R1） ---- */
function hasCJK(s) {
  return /[一-鿿぀-ヿ가-힯]/.test(String(s || ''));
}

function pushWarning(list, code, msg) {
  if (!list.some(w => w.code === code)) list.push({ code, msg });
}

/* 从拼好的 payload 推导三条已知坑警示（表单路径与 JSON 路径共用） */
function computeWarnings(payload) {
  const ws = [];
  const stateStr = typeof payload.state === 'string'
    ? payload.state : JSON.stringify(payload.state || '');
  const cjk = hasCJK(stateStr);
  const modelSel = ($('#model-select') || {}).value || '';
  // 通用中文场景预警（硬性项，state 级、全任务类型覆盖，置顶保证可见）
  if (cjk) {
    pushWarning(ws, 'cjk-general',
      '中文业务提醒：Laya 原生英文效果最佳——请先用真实业务样本在「评估」页批量评估，达标后再投入正式使用');
  }
  Object.entries(payload.questions || {}).forEach(([qid, q]) => {
    if (!q || typeof q !== 'object') return;
    if (q.type === 'choice' && q.criteria) {
      const labels = Object.keys(q.criteria).map(s => String(s).toLowerCase());
      const boolish = ['true', 'false', 'yes', 'no'];
      if (labels.length >= 2 && labels.length <= 4
          && labels.every(l => boolish.includes(l))) {
        pushWarning(ws, 'bool-label',
          `「${qid}」候选是布尔式标签（true/false…）——上游已知会带偏判断（laya #156），建议改用语义标签或 A/B`);
      }
    }
    if (q.type === 'score' && (modelSel === 'multilingual' || cjk)) {
      pushWarning(ws, 'score-bias',
        'score 在多语言 checkpoint 上存在首档位置偏差（上游 #131 未修复）：建议先小样本验证，或改用 choice/noul 表达等级');
    }
    if (q.type === 'noul' && cjk) {
      pushWarning(ws, 'noul-cjk',
        '中文 noul 上游未做校准（实测偏弱）：置信度仅供参考，重要决策请先用小样本评估');
    }
    // 结构建议（P1-3）：指令疑似含多个独立因素 → 官方原子问题方法论
    const instr = String(q.instructions || '');
    if (instr.length >= 8
        && (/(以及|并且|同时|还有)/.test(instr)
          || /\bor\b/i.test(instr) || /\band\b/i.test(instr)
          || (instr.includes('和') && instr.length >= 10))) {
      pushWarning(ws, 'split-hint',
        `「${qid}」的判断指令疑似包含多个因素——建议拆成多个单题，结果在代码里组合（原子问题原则）`);
    }
  });
  return ws;
}

function renderWarnings(warnings) {
  const box = $('#warn-banner');
  if (!box) return;
  if (!warnings || !warnings.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  // 每次最多展示 3 条（保持界面克制；通用中文提醒已置顶不会被截）
  const shown = warnings.slice(0, 3);
  const extra = warnings.length - shown.length;
  box.innerHTML = shown.map(w =>
    `<div class="warn-line"><span class="wl-ico">⚠</span><span>${esc(w.msg)}</span></div>`
  ).join('') + (extra > 0
    ? `<div class="warn-line"><span class="wl-ico">…</span><span>另有 ${extra} 条提醒未展开（修完当前问题后会减少）</span></div>`
    : '');
  box.hidden = false;
}

/* ---- 置信度三态门控（P0-3）：可自动 / 转人工 / 弃答 ---- */
function getThreshold() {
  try {
    const saved = Number(localStorage.getItem(THRESH_KEY));
    if (saved >= 0.5 && saved <= 0.99) return saved;
  } catch (_) { /* ignore */ }
  return 0.85;
}

function setThreshold(v) {
  const t = Math.min(0.99, Math.max(0.5, Number(v) || 0.85));
  try { localStorage.setItem(THRESH_KEY, String(t)); } catch (_) { /* ignore */ }
  const el = $('#gate-threshold');
  if (el) el.value = String(t);
  const lbl = $('#gate-val');
  if (lbl) lbl.textContent = t.toFixed(2);
  return t;
}

/* 三态判定：conf ≥ T → 可自动；choice 首位概率 < 0.5 → 弃答；其余 → 转人工 */
function gateVerdict(ans) {
  const T = getThreshold();
  if (!ans || typeof ans !== 'object') return { k: 'esc', label: '转人工' };
  const conf = Number(ans.confidence ?? ans.answer_confidence ?? 0);
  if (ans.type === 'noul') {
    const p = Number(ans.noul ?? 0);
    if (p >= T || (1 - p) >= T) return { k: 'auto', label: '可自动' };
    return { k: 'esc', label: '转人工' };
  }
  if (ans.type === 'choice') {
    const vals = Object.values(ans.probabilities || {}).map(Number);
    const ptop = vals.length ? Math.max(...vals) : 0;
    if (ptop < 0.5) return { k: 'abs', label: '弃答' };
    return conf >= T ? { k: 'auto', label: '可自动' } : { k: 'esc', label: '转人工' };
  }
  // score
  return conf >= T ? { k: 'auto', label: '可自动' } : { k: 'esc', label: '转人工' };
}

/* ---- 首次使用引导（P0-2） ---- */
let obStep = 1;

function renderOnboard() {
  $$('.ob-step').forEach(el =>
    el.classList.toggle('hidden', Number(el.dataset.step) !== obStep));
  const bar = $('#ob-bar');
  if (bar) bar.style.width = `${(obStep / 3) * 100}%`;
  const next = $('#ob-next');
  if (next) next.textContent = obStep === 3 ? '开始使用' : '下一步';
}

function showOnboard(step) {
  obStep = step || 1;
  renderOnboard();
  $('#onboard').classList.remove('hidden');
}

function hideOnboard(markDone) {
  $('#onboard').classList.add('hidden');
  if (markDone) {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (_) { /* ignore */ }
  }
}

/* ---- 校验错误展示（友好中文，不抛异常） ---- */
function clearErrors() {
  $$('.field-error').forEach(el => { el.hidden = true; el.textContent = ''; });
  $$('.field.invalid').forEach(el => el.classList.remove('invalid'));
}

function showErrors(errors) {
  clearErrors();
  errors.forEach(e => {
    const errEl = e.errId ? document.getElementById(e.errId) : null;
    if (errEl) {
      errEl.textContent = e.msg;
      errEl.hidden = false;
      const field = errEl.closest('.field');
      if (field) field.classList.add('invalid');
    }
  });
  const first = errors[0];
  if (first) {
    const el = document.getElementById(first.el);
    if (el) {
      try { el.focus({ preventScroll: false }); } catch (_) { el.scrollIntoView({ block: 'center' }); }
    }
  }
}

function clearErrorFor(el) {
  const field = el && el.closest ? el.closest('.field') : null;
  if (!field) return;
  const err = field.querySelector('.field-error');
  if (err) { err.hidden = true; err.textContent = ''; }
  field.classList.remove('invalid');
}

/* ---- 高级面板：JSON 预览 / curl（随输入实时更新） ---- */
function curlFor(payload) {
  const compact = JSON.stringify(payload);
  const escaped = compact.replace(/'/g, `'\\''`);
  return [
    `curl -X POST ${location.origin}/v1/systemone \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${escaped}'`,
  ].join('\n');
}

let advTimer = null;
function syncAdvanced() {
  clearTimeout(advTimer);
  advTimer = setTimeout(() => {
    try {
      const { payload } = buildPayload();
      const pv = $('#payload-preview');
      const cc = $('#curl-code');
      if (pv) pv.textContent = pretty(payload);
      if (cc) cc.textContent = curlFor(payload);
    } catch (_) { /* 预览失败不打断输入 */ }
  }, 180);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板', 'ok'); }
    catch (__) { toast('复制失败，请手动选择文本', 'error'); }
    ta.remove();
  }
}

/* ---- 预设 / 示例 ---- */
function loadPresetChips() {
  const wrap = $('#preset-chips');
  wrap.innerHTML = S.presets.map(p =>
    `<button class="chip" data-id="${esc(p.id)}" title="${esc(p.desc)}" type="button">${esc(p.title)}</button>`
  ).join('');
}

function loadExample() {
  applyPayloadToForm(EXAMPLE_TEMPLATE.state, EXAMPLE_TEMPLATE.questions);
  toast('已载入客服工单示例模板', 'ok');
}

/* ---- P1-3 问题写作助手：基于 State 起草（预设匹配优先，兜底通用骨架） ---- */
function tokensOf(s) {
  const out = new Set();
  const lower = String(s || '').toLowerCase();
  (lower.match(/[a-z0-9]+/g) || []).forEach(t => out.add(t));
  const cjk = String(s || '').match(/[一-鿿]/g) || [];
  cjk.forEach(ch => out.add(ch));
  for (let i = 0; i < cjk.length - 1; i += 1) out.add(cjk[i] + cjk[i + 1]);
  return out;
}

function suggestDraft() {
  syncFromDom();
  const stateStr = (S.form.stateText || '').trim();
  if (!stateStr) {
    toast('先写一点 State 内容，再点「帮我起草」', 'error');
    $('#f-state').focus();
    return;
  }
  const stateToks = tokensOf(stateStr);
  let best = null;
  let bestScore = 0;
  (S.presets || []).forEach(p => {
    const pToks = tokensOf(`${p.state} ${Object.keys(p.questions).join(' ')}`);
    let inter = 0;
    pToks.forEach(t => { if (stateToks.has(t)) inter += 1; });
    const score = inter / Math.sqrt(Math.max(pToks.size, 1));
    if (score > bestScore) { bestScore = score; best = p; }
  });
  if (best && bestScore >= 0.3) {
    applyPayloadToForm(best.state === stateStr ? stateStr : stateStr, best.questions);
    // 保留用户自己的 State，只换问题草稿
    S.form.stateText = stateStr;
    renderAll();
    syncAdvanced();
    toast(`已按预设「${best.title}」起草问题（匹配度 ${(bestScore * 100).toFixed(0)}%），请按业务改写`, 'ok');
    return;
  }
  // 兜底：通用骨架（分类 + 是否紧急）
  applyPayloadToForm(stateStr, {
    intent: {
      type: 'choice',
      instructions: '把这段内容归入最合适的处理类别',
      criteria: {
        billing: '发票、支付、退款等财务问题',
        technical: '故障、报错、无法使用等技术问题',
        request: '咨询、申请、办理等业务请求',
        other: '其他一切',
      },
    },
    urgent: {
      type: 'noul',
      instructions: '这件事是否紧急或有时限要求？',
    },
  });
  S.form.stateText = stateStr;
  renderAll();
  syncAdvanced();
  toast('没有匹配的预设，已按通用骨架起草——请修改类别与指令', 'ok');
}

function currentFormSnapshot() {
  syncFromDom();
  const f = S.form;
  return {
    stateMode: f.stateMode, stateText: f.stateText, mode: f.mode,
    single: f.single, batch: f.batch, model: f.model,
    threshold: getThreshold(),
  };
}

async function saveTemplate() {
  const name = ($('#tpl-name').value || '').trim()
    || prompt('模板名称', `模板 ${new Date().toLocaleString('zh-CN')}`);
  if (!name) return;
  const category = ($('#tpl-cat').value || '').trim() || '默认';
  try {
    const snapshot = currentFormSnapshot();
    await api('/api/templates', {
      method: 'POST',
      body: { name, category, form: snapshot },
    });
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(snapshot)); } catch (_) {}
    $('#template-panel').classList.remove('hidden');
    loadTemplates();
    toast(`模板「${name}」已保存`, 'ok');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

function applyTemplateForm(form) {
  S.form = { ...defaultForm(), ...(form || {}) };
  S.form.single = { ...defaultSingle(), ...((form && form.single) || {}) };
  S.form.batch = Array.isArray(form && form.batch) ? form.batch : [];
  S.form.batch.forEach(t => {
    uidSeq = Math.max(uidSeq, (Number(t.uid) || 0) + 1);
  });
  if (form && form.threshold) setThreshold(form.threshold);
  renderAll();
  syncAdvanced();
}

async function loadTemplates() {
  try {
    const list = await api('/api/templates');
    S.templates = list;
    const wrap = $('#tpl-list');
    if (!wrap) return;
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state slim">暂无模板，先在上方保存一个</div>';
      return;
    }
    wrap.innerHTML = list.map(t => `
      <div class="job">
        <div class="job-top">
          <span class="job-name">${esc(t.name)}</span>
          <span class="muted small">${esc(t.category)}</span>
        </div>
        <div class="job-meta">${esc(fmtTime(t.created_at))}</div>
        <div class="m-actions" style="margin-top:8px">
          <button class="btn sm" type="button" data-tpl-load="${t.id}">载入</button>
          <button class="btn sm ghost danger" type="button" data-tpl-del="${t.id}">删除</button>
        </div>
      </div>`).join('');
  } catch (e) {
    toast('模板列表加载失败：' + e.message, 'error');
  }
}

function restoreTemplate() {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY);
    if (!raw) { S.form = defaultForm(); return; }
    const saved = JSON.parse(raw);
    S.form = { ...defaultForm(), ...saved };
    S.form.single = { ...defaultSingle(), ...(saved.single || {}) };
    S.form.batch = Array.isArray(saved.batch) ? saved.batch : [];
    S.form.batch.forEach(t => { uidSeq = Math.max(uidSeq, (Number(t.uid) || 0) + 1); });
    if (saved.threshold) setThreshold(saved.threshold);
    toast('已恢复上次保存的表单模板');
  } catch (_) {
    S.form = defaultForm();
  }
}

/* ---- 全量渲染 ---- */
function renderAll() {
  const f = S.form;
  const stateEl = $('#f-state');
  if (stateEl) stateEl.value = f.stateText;
  updateStateMeta();
  const sm = document.querySelector(`input[name="state-mode"][value="${f.stateMode}"]`);
  if (sm) sm.checked = true;
  const tm = document.querySelector(`input[name="task-mode"][value="${f.mode}"]`);
  if (tm) tm.checked = true;
  const ms = $('#model-select');
  if (ms) ms.value = f.model || '';
  renderTaskForm();
}

/* ---- 执行推理（表单路径与 JSON 路径共用） ---- */
async function runDecision() {
  const { payload, errors, warnings } = buildPayload();
  syncAdvanced();
  renderWarnings(warnings);
  if (errors.length) {
    showErrors(errors);
    toast(`请先修正表单中的 ${errors.length} 处问题`, 'error');
    return;
  }
  clearErrors();
  if (S.form.model) payload.model = S.form.model;
  await executePayload(payload);
}

async function executePayload(payload) {
  const btn = $('#f-run');
  btn.disabled = true;
  btn.textContent = '推理中…';
  $('#verdict-row').hidden = true;
  $('#results').innerHTML = '<div class="empty-state"><div class="empty-ico">◌</div><p>推理中…</p></div>';
  try {
    const t0 = performance.now();
    const data = await api('/api/predict', { method: 'POST', body: payload });
    const localMs = (performance.now() - t0).toFixed(0);
    renderResults(data.result, data.latency_ms, localMs);
  } catch (e) {
    $('#meta-badges').innerHTML = '';
    $('#verdict-row').hidden = true;
    S.lastResult = null;
    const gb = $('#gate-bar');
    if (gb) gb.hidden = true;
    $('#raw-json').textContent = '—';
    $('#results').innerHTML =
      `<div class="error-card"><span class="code">HTTP ${e.status || 'ERR'}</span>
       <p>${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ 执行推理';
  }
}

/* ---- 原始 JSON 输入（高级面板）：与表单双向互通 ---- */
function clearJsonError() {
  const err = $('#err-json-input');
  if (err) { err.hidden = true; err.textContent = ''; }
  const field = err && err.closest ? err.closest('.field') : null;
  if (field) field.classList.remove('invalid');
}

function showJsonError(msg) {
  const err = $('#err-json-input');
  if (!err) return;
  err.textContent = msg;
  err.hidden = false;
  const field = err.closest('.field');
  if (field) field.classList.add('invalid');
  const input = $('#json-input');
  if (input) { try { input.focus(); } catch (_) { /* ignore */ } }
}

function parseJsonEditor() {
  const raw = (($('#json-input') || {}).value || '').trim();
  if (!raw) {
    return { error: 'JSON 输入为空：可点「从表单填入」生成，或直接粘贴标准 Laya 输入' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: 'JSON 格式错误：' + e.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '顶层必须是 JSON 对象：{"state": ..., "questions": {...}}' };
  }
  if (parsed.state === null || parsed.state === undefined || !('state' in parsed)) {
    return { error: '缺少 state 字段：请提供模型读取的原始业务内容' };
  }
  if (!('questions' in parsed)) {
    return { error: '缺少 questions 字段：结构为 {"任务key": {"type": ...}}' };
  }
  if (!parsed.questions || typeof parsed.questions !== 'object' || Array.isArray(parsed.questions)) {
    return { error: 'questions 必须是对象，键为任务 key' };
  }
  return { payload: { state: parsed.state, questions: parsed.questions } };
}

function fillJsonEditor() {
  const { payload } = buildPayload();
  const editor = $('#json-input');
  if (editor) editor.value = pretty(payload);
  clearJsonError();
  toast('已将表单拼装结果填入 JSON 编辑器', 'ok');
}

function applyJsonToForm() {
  const r = parseJsonEditor();
  if (r.error) { showJsonError(r.error); toast(r.error, 'error'); return; }
  clearJsonError();
  applyPayloadToForm(r.payload.state, r.payload.questions);
  toast('JSON 已应用到上方表单', 'ok');
}

async function runJsonEditor() {
  const r = parseJsonEditor();
  if (r.error) { showJsonError(r.error); toast(r.error, 'error'); return; }
  clearJsonError();
  const payload = { ...r.payload };
  renderWarnings(computeWarnings(payload));
  const model = ($('#model-select') || {}).value;
  if (model) payload.model = model;
  await executePayload(payload);
}

function renderResults(result, serverMs, localMs) {
  S.lastResult = { result, serverMs, localMs };
  const answers = result.answers || {};
  const routing = result.routing || {};
  const usage = result.usage || {};
  const gateBar = $('#gate-bar');
  if (gateBar) gateBar.hidden = false;

  $('#meta-badges').innerHTML = [
    `<span class="meta-badge hl">↳ ${esc(routing.model || 'auto')}</span>`,
    usage.input_tokens != null ? `<span class="meta-badge">${usage.input_tokens} tok</span>` : '',
    localMs ? `<span class="meta-badge">往返 ${localMs} ms</span>` : '',
  ].join('');

  // Token 预算条（官方口径：64k/请求，32k = state + 最长单题）
  const bb = $('#budget-bar');
  const tok = usage.input_tokens;
  if (bb) {
    if (tok != null && tok > 0) {
      const pct = Math.min(100, (tok / 64000) * 100);
      const cls = pct >= 95 ? 'danger' : (pct >= 80 ? 'warn' : '');
      const over = tok > 64000;
      bb.innerHTML = `
        <div class="budget-row">
          <span class="budget-label">Token 预算</span>
          <div class="budget-track ${cls}"><div class="budget-fill" style="width:${Math.max(pct, 0.5).toFixed(2)}%"></div></div>
          <span class="budget-val ${over ? 'over' : ''}">${tok.toLocaleString()} / 64,000${over ? ' · 已超' : ''}</span>
        </div>
        <div class="budget-note">官方口径 64k/请求 · 32k = state + 最长单题 · 超限上游返回 max_tokens_exceeded</div>`;
      bb.hidden = false;
    } else {
      bb.hidden = true;
      bb.innerHTML = '';
    }
  }

  // 摘要条：最佳决策 + 置信度 + 耗时
  const vrow = $('#verdict-row');
  const order = Object.keys(answers);
  if (order.length) {
    const chips = order.map(qid => {
      const a = answers[qid] || {};
      let val;
      if ((a.type || 'choice') === 'choice') val = a.choice ?? '—';
      else if (a.type === 'score') val = Number(a.score ?? 0).toFixed(2);
      else val = (Number(a.noul ?? 0) >= 0.5 ? '是' : '否') + ` (P=${Number(a.noul ?? 0).toFixed(2)})`;
      return `<span class="verdict-chip"><span class="vc-key">${esc(qid)}</span>
        <b>${esc(val)}</b><span class="vc-conf ${confClass(a.confidence)}">${fmtPct(a.confidence)}</span></span>`;
    }).join('');
    vrow.innerHTML = chips + `<span class="meta-badge ok" style="margin-left:auto">${esc(serverMs)} ms</span>`;
    vrow.hidden = false;
  } else {
    vrow.hidden = true;
  }

  if (!order.length) {
    $('#results').innerHTML = '<div class="empty-state">响应中没有 answers</div>';
  } else {
    $('#results').innerHTML = order.map((qid, i) => renderAnswer(qid, answers[qid], routing, i)).join('');
  }
  $('#raw-json').textContent = pretty(result);
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
        <span class="conf">confidence <b class="${confClass(ans.confidence)}" title="confidence = 1 − 归一化熵：分布越集中越高；度量模型对答案多确定，不直接等于正确概率">${fmtPct(ans.confidence)}</b></span>
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
        <span class="conf">confidence <b class="${confClass(ans.confidence)}" title="confidence = 1 − 归一化熵：分布越集中越高；度量模型对答案多确定，不直接等于正确概率">${fmtPct(ans.confidence)}</b></span>
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
          <p class="conf">confidence <b class="${confClass(ans.confidence)}" title="confidence = 1 − 归一化熵：分布越集中越高；度量模型对答案多确定，不直接等于正确概率">${fmtPct(ans.confidence)}</b>
          ${routing.reason ? ' · ' + esc(routing.reason) : ''}</p>
        </div>
      </div>`;
  }

  const gate = gateVerdict(ans);
  return `
    <div class="q-result" style="${delay}">
      <div class="q-head">
        <span class="q-id">${esc(qid)}</span>
        <span class="head-right">
          <span class="gate-badge ${gate.k}">${gate.label}</span>
          <span class="q-type ${esc(type)}">${esc(type)}</span>
        </span>
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

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function loadModels() {
  try {
    const [models, hw] = await Promise.all([
      api('/api/models'),
      api('/api/hw').catch(() => ({})),
    ]);
    const gpu = hw.gpu;
    $('#models-hw').innerHTML = [
      gpu ? `<span class="stat-chip">显存 <b>${gpu.used_mb} MB</b> / ${gpu.total_mb} MB（${gpu.percent}%）</span>`
          : '<span class="stat-chip">显存 <b>—</b></span>',
      hw.mem ? `<span class="stat-chip">内存 <b>${hw.mem.used_mb} MB</b> / ${hw.mem.total_mb} MB（${hw.mem.percent}%）</span>` : '',
    ].join('');
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
      const progress = dl.status === 'downloading' ? (() => {
        const pct = dl.total_bytes
          ? Math.min(100, Math.round(((dl.got_bytes || 0) / dl.total_bytes) * 100))
          : null;
        return `
          <div class="progress" style="margin-top:10px"><i style="width:${pct != null ? pct : 30}%"></i></div>
          <div class="muted small" style="margin-top:5px">
            ${fmtBytes(dl.got_bytes)} / ${dl.total_bytes ? fmtBytes(dl.total_bytes) : '计算中…'}
            ${pct != null ? ` · ${pct}%` : ''}
          </div>`;
      })() : '';
      const temp = m.temperature || { state: 'unavailable' };
      const tempLabel = {
        global: temp.value != null ? String(temp.value) : '—',
        bucket: '按选项数分桶',
        multi: '多处温度',
        none: '未校准',
        unknown: '未知',
        unavailable: '—',
      }[temp.state] || '—';
      const tempWarn = ['none', 'unknown'].includes(temp.state);
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
            <div class="m-spec" title="RLCD 温度校准状态：未校准的 checkpoint 概率可信度下降，建议先跑温度拟合">
              <span class="k">温度</span><span class="v ${tempWarn ? 'temp-warn' : ''}">${esc(tempLabel)}</span></div>
          </div>
          <div class="m-use">${esc(m.use_for)}${m.size_hint ? ' · ' + esc(m.size_hint) : ''}${m.revision ? ' · rev ' + esc(m.revision) + '（生产建议钉住版本）' : ''}${m.installed_at ? ' · 安装于 ' + esc(m.installed_at) : ''}</div>
          <div class="m-actions">${actions.join('')}</div>
          ${progress}
          ${dl.status === 'error' ? `<div class="m-error">${esc(dl.error || '未知错误')}</div>` : ''}
        </div>`;
    }).join('');

    $$('#model-grid [data-act]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { act, key } = btn.dataset;
        btn.disabled = true;
        try {
          const out = await api(`/api/models/${key}/${act}`, { method: 'POST' });
          if (act === 'download') toast(`${key} 开始下载（走 HF 镜像），完成后出现安装徽章`, 'ok');
          else if (act === 'unload' && out && out.freed_mb != null) {
            toast(`已卸载 ${key}，释放显存 ${out.freed_mb} MB`, 'ok');
          } else {
            toast(`${key} ${act === 'load' ? '加载' : '卸载'}完成`, 'ok');
          }
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
  const payload = ids.length ? { run_ids: ids } : {};
  const filters = {};
  const minRaw = ($('#export-min-conf') || {}).value;
  if (minRaw !== '' && minRaw != null && !Number.isNaN(Number(minRaw))) {
    filters.min_confidence = Number(minRaw);
  }
  const typeVal = ($('#export-type') || {}).value;
  if (typeVal) filters.has_type = typeVal;
  if (Object.keys(filters).length) payload.filters = filters;
  try {
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
    const m = { ...(job.metrics || {}) };
    const confusion = m.choice_confusion || null;
    delete m.choice_confusion;
    const metrics = Object.entries(m).map(([k, v]) => `
      <div class="metric"><span class="k">${esc(k)}</span>
      <span class="v">${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : esc(v)}</span></div>`).join('');

    // 置信度覆盖率（题级）：按置信度排序取 top 50% / 80% 子集重算准确率
    const covPairs = [];
    (job.items || []).forEach(it => {
      const pred = it.predicted || {};
      Object.keys(it.expected || {}).forEach(qid => {
        const v = (it.results || {})[qid];
        if (v === null || v === undefined) return;
        const a = pred[qid] || {};
        covPairs.push({
          conf: Number(a.answer_confidence ?? a.confidence ?? 0),
          ok: !!v,
        });
      });
    });
    const accAt = cov => {
      if (!covPairs.length) return null;
      const sorted = [...covPairs].sort((x, y) => y.conf - x.conf);
      const n = Math.max(1, Math.round(sorted.length * cov));
      const top = sorted.slice(0, n);
      return top.filter(x => x.ok).length / top.length;
    };
    const cov50 = accAt(0.5);
    const cov80 = accAt(0.8);
    const covCards = [
      cov50 != null ? `<div class="metric"><span class="k">acc@50%覆盖</span>
        <span class="v">${(cov50 * 100).toFixed(1)}<span style="font-size:12px">%</span></span></div>` : '',
      cov80 != null ? `<div class="metric"><span class="k">acc@80%覆盖</span>
        <span class="v">${(cov80 * 100).toFixed(1)}<span style="font-size:12px">%</span></span></div>` : '',
    ].join('');

    // Choice 混淆矩阵（行=期望 / 列=预测，对角线高亮）
    let matrixHtml = '';
    if (confusion && Object.keys(confusion).length) {
      const labels = [...new Set([
        ...Object.keys(confusion),
        ...Object.values(confusion).flatMap(r => Object.keys(r)),
      ])].sort();
      const head = labels.map(l => `<th>${esc(l)}</th>`).join('');
      const bodyRows = labels.map(t => {
        const cells = labels.map(p => {
          const n = (confusion[t] || {})[p] || 0;
          const cls = t === p ? 'cm-diag' : (n ? 'cm-off' : '');
          return `<td class="${cls}">${n || ''}</td>`;
        }).join('');
        return `<tr><th class="cm-row">${esc(t)}</th>${cells}</tr>`;
      }).join('');
      matrixHtml = `
        <div class="subhead">Choice 混淆矩阵（行=期望 / 列=预测）</div>
        <div class="table-wrap">
          <table class="table cm-table">
            <thead><tr><th>期望 \\ 预测</th>${head}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>`;
    }

    // 错误样本归因（错误预测 top）
    const wrongItems = (job.items || []).filter(it => !it.correct && !it.error);
    const misPred = {};
    wrongItems.forEach(it => {
      const pred = summarizeAnswers(it.predicted) || {};
      for (const [qid, verdict] of Object.entries(it.results || {})) {
        if (verdict === false) {
          const key = `${qid} → ${pred[qid]}`;
          misPred[key] = (misPred[key] || 0) + 1;
        }
      }
    });
    const misTop = Object.entries(misPred).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, n]) => `<span class="stat-chip">${esc(k)} <b>${n}</b></span>`).join('');
    const misHtml = wrongItems.length
      ? `<div class="subhead">错误样本归因（错误预测 top）</div>
         <div class="chip-row">${misTop || '<span class="muted small">—</span>'}</div>`
      : '';

    const rows = (job.items || []).map(it => `
      <tr class="${it.correct ? '' : 'eval-item-bad'}">
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
          <button class="btn sm" id="ev-export-ds" title="导出 state/questions/expected 标注，供官方微调 notebook 使用">导出微调集</button>
          <button class="btn sm" id="ev-report">导出报告</button>
          <button class="btn sm ghost danger" id="ev-delete">删除</button>
        </div>
      </div>
      <div class="metrics">${(metrics + covCards) || '<span class="muted small">尚无指标</span>'}</div>
      ${matrixHtml}
      ${misHtml}
      <div class="table-wrap" style="margin-top:14px">
        <table class="table">
          <thead><tr><th>#</th><th>State</th><th>Expected</th><th>Predicted</th><th>判定</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <details class="ft-guide">
        <summary>📐 微调四步走：把这个评估变成更好的模型</summary>
        <ol>
          <li><b>汇集标注</b>——点上方「导出微调集」得到 state/questions/expected 标注
            （或去历史页导出 answers 形状），本任务的错误样本正是最有价值的训练料</li>
          <li><b>跑官方 notebook</b>——laya 仓库
            <code>notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb</code>
            （Kaggle 免费 2×T4，训练 + 温度拟合一条龙）</li>
          <li><b>加载微调结果</b>——到「模型」页安装/加载你的 checkpoint</li>
          <li><b>复评对比</b>——回本页用同一数据集再跑一次，对比 accuracy 与
            acc@覆盖 前后变化</li>
        </ol>
      </details>`;
    $('#ev-delete').addEventListener('click', async () => {
      if (!confirm(`删除评估任务 #${job.id}？其逐条结果会一并删除。`)) return;
      await api(`/api/eval/${job.id}`, { method: 'DELETE' });
      S.evalSelected = null;
      $('#eval-detail').classList.add('hidden');
      loadEvalJobs();
      toast('任务已删除');
    });
    $('#ev-report').addEventListener('click', async () => {
      try {
        const out = await api(`/api/eval/${job.id}/report`, { method: 'POST' });
        toast(`报告已生成 → ${out.filename}`, 'ok');
      } catch (e) {
        toast('报告生成失败：' + e.message, 'error');
      }
    });
    $('#ev-export-ds').addEventListener('click', async () => {
      try {
        const out = await api(`/api/eval/${job.id}/export-dataset`, { method: 'POST' });
        toast(`微调集已导出 → ${out.filename}（${out.rows} 条标注）`, 'ok');
      } catch (e) {
        toast('导出失败：' + e.message, 'error');
      }
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
  'api_key', 'api_enabled', 'record_history', 'option_warn_threshold', 'port',
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
  const hw = s.hw || {};
  const gpu = hw.gpu;
  animateNumber('kpi-vram', gpu ? gpu.used_mb : null, { suffix: 'MB' });
  $('#kpi-vram-sub').textContent = gpu
    ? `${gpu.percent}% / ${gpu.total_mb} MB${hw.mem ? ` · 内存 ${hw.mem.percent}%` : ''}`
    : '显存信息不可用';
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

/* ================= 日志 ================= */

function currentLogLevel() {
  const el = document.querySelector('input[name="log-level"]:checked');
  return el ? el.value : 'INFO';
}

async function loadLogs() {
  try {
    const level = currentLogLevel();
    const data = await api(`/api/logs?level=${encodeURIComponent(level)}&limit=500`);
    const wrap = $('#log-list');
    const logs = data.logs || [];
    if (!logs.length) {
      wrap.innerHTML = `<div class="empty-state slim">该级别暂无日志</div>`;
      return;
    }
    wrap.innerHTML = logs.slice().reverse().map(e => `
      <div class="log-line ${esc(e.level)}">
        <span class="lv">${esc(e.level)}</span>
        <span class="ts">${esc(e.ts)}</span>
        <span class="msg">${esc(e.msg)}</span>
      </div>`).join('');
  } catch (_) { /* 轮询失败静默 */ }
}

/* ================= 初始化 ================= */

/* 表单活动：DOM → 状态 → 按需重渲染 → 刷新预览 */
function onFormActivity(e) {
  const t = e.target;
  syncFromDom();
  if (t.name === 'task-mode') renderTaskForm();
  if (t.dataset && t.dataset.field === 'type') renderBatch();
  if (t.id === 'f-state') updateStateMeta();
  updateCounts();
  clearErrorFor(t);
  syncAdvanced();
}

function bindEvents() {
  window.addEventListener('hashchange', route);

  // 跳过链接：直接聚焦主区，不改动 hash（否则会被路由当成未知视图）
  $('.skip-link')?.addEventListener('click', e => {
    e.preventDefault();
    const root = $('#view-root');
    root.setAttribute('tabindex', '-1');
    root.focus({ preventScroll: false });
  });

  // ---- 调试台：简易表单 ----
  $('#f-run').addEventListener('click', runDecision);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.view === 'playground') {
      e.preventDefault();
      // 光标在 JSON 编辑器里 → 走 JSON 执行路径；否则走表单路径
      if (document.activeElement === $('#json-input')) runJsonEditor();
      else runDecision();
    }
  });
  $('#f-example').addEventListener('click', loadExample);
  $('#f-draft').addEventListener('click', suggestDraft);
  $('#f-save').addEventListener('click', saveTemplate);

  // 首次引导
  $('#ob-next').addEventListener('click', () => {
    if (obStep < 3) { obStep += 1; renderOnboard(); }
    else { hideOnboard(true); toast('引导完成，随时点下方「? 使用引导」重看', 'ok'); }
  });
  $('#ob-skip').addEventListener('click', () => hideOnboard(true));
  $('#ob-reopen').addEventListener('click', () => showOnboard(1));

  // 门控阈值：变化即重渲染现有结果（不重新推理）
  $('#gate-threshold').addEventListener('input', debounce(() => {
    const v = Number($('#gate-threshold').value);
    $('#gate-val').textContent = v.toFixed(2);
    try { localStorage.setItem(THRESH_KEY, String(v)); } catch (_) { /* ignore */ }
    if (S.lastResult) {
      renderResults(S.lastResult.result, S.lastResult.serverMs, S.lastResult.localMs);
    }
  }, 120));
  $('#f-tpl-lib').addEventListener('click', () => {
    const panel = $('#template-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadTemplates();
  });
  $('#tpl-close').addEventListener('click', () =>
    $('#template-panel').classList.add('hidden'));
  $('#tpl-save').addEventListener('click', saveTemplate);
  $('#tpl-export').addEventListener('click', () => {
    window.location.href = '/api/templates/export';
    toast('模板导出已开始下载');
  });
  $('#tpl-import').addEventListener('click', () => $('#tpl-file').click());
  $('#tpl-file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : (data.templates || []);
      const out = await api('/api/templates/import', { method: 'POST', body: { items } });
      toast(`已导入 ${out.imported} 个模板`, 'ok');
      loadTemplates();
    } catch (err) {
      toast('导入失败：' + err.message, 'error');
    }
    e.target.value = '';
  });
  $('#tpl-list').addEventListener('click', async e => {
    const loadBtn = e.target.closest('[data-tpl-load]');
    if (loadBtn) {
      const t = (S.templates || []).find(x => String(x.id) === loadBtn.dataset.tplLoad);
      if (t) {
        applyTemplateForm(t.form);
        toast(`已载入模板「${t.name}」`, 'ok');
      }
      return;
    }
    const delBtn = e.target.closest('[data-tpl-del]');
    if (delBtn) {
      if (!confirm('删除该模板？')) return;
      try {
        await api(`/api/templates/${delBtn.dataset.tplDel}`, { method: 'DELETE' });
        loadTemplates();
        toast('模板已删除');
      } catch (err) { toast(err.message, 'error'); }
    }
  });
  $('#copy-payload').addEventListener('click', () => copyText($('#payload-preview').textContent));
  $('#copy-raw').addEventListener('click', () => copyText($('#raw-json').textContent));
  $('#copy-curl').addEventListener('click', () => copyText($('#curl-code').textContent));
  // 原始 JSON 输入（高级）：与表单双向互通
  $('#json-fill-form').addEventListener('click', fillJsonEditor);
  $('#json-apply-form').addEventListener('click', applyJsonToForm);
  $('#json-run').addEventListener('click', runJsonEditor);

  const pg = $('#view-playground');
  pg.addEventListener('input', onFormActivity);
  pg.addEventListener('change', onFormActivity);
  pg.addEventListener('click', e => {
    const chip = e.target.closest('#preset-chips .chip');
    if (chip) {
      const p = S.presets.find(x => x.id === chip.dataset.id);
      if (p) {
        $$('#preset-chips .chip').forEach(c => c.classList.toggle('active', c === chip));
        applyPayloadToForm(p.state, p.questions);
        toast(`已载入预设「${p.title}」`);
      }
      return;
    }
    if (e.target.closest('#batch-add')) {
      syncFromDom();
      S.form.batch.push(blankTask());
      renderBatch();
      syncAdvanced();
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      syncFromDom();
      const uid = Number(rm.dataset.remove);
      S.form.batch = S.form.batch.filter(t => t.uid !== uid);
      renderBatch();
      syncAdvanced();
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
    applyPayloadToForm(run.state, run.questions);
    location.hash = '#playground';
    toast('已载入调试台表单');
  });

  $('#btn-eval-run').addEventListener('click', startEval);
  $('#btn-eval-refresh').addEventListener('click', loadEvalJobs);
  $('#eval-sample').addEventListener('click', e => {
    e.preventDefault();
    $('#eval-dataset').value = EVAL_SAMPLE;
    toast('示例数据集已填入');
  });

  $('#btn-settings-save').addEventListener('click', saveSettings);

  // 日志视图
  $$('input[name="log-level"]').forEach(radio =>
    radio.addEventListener('change', loadLogs));
  $('#log-refresh').addEventListener('click', loadLogs);
  $('#log-export').addEventListener('click', () => {
    window.location.href = '/api/logs/export';
    toast('日志导出已开始下载');
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function init() {
  bindEvents();
  restoreTemplate();
  renderAll();
  route();
  try {
    S.presets = await api('/api/presets');
    loadPresetChips();
  } catch (_) { /* 预设失败不阻塞 */ }
  await refreshStatus();
  updateCounts();
  syncAdvanced();
  // JSON 编辑器初始内容：与当前表单保持一致（此后编辑器独立，不被表单联动覆盖）
  const jsonEditor = $('#json-input');
  if (jsonEditor && !jsonEditor.value) {
    try { jsonEditor.value = pretty(buildPayload().payload); } catch (_) { /* ignore */ }
  }
  // 门控阈值恢复 + 首次引导
  setThreshold(getThreshold());
  try {
    if (!localStorage.getItem(ONBOARD_KEY)) showOnboard(1);
  } catch (_) {
    showOnboard(1);
  }
  setInterval(refreshStatus, 5000);
}

document.addEventListener('DOMContentLoaded', init);
