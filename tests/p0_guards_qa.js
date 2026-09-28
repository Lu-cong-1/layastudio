/* P0 第一批 QA：护栏 T1-T4 / 结果教育 T5 / 预算条 T6（流程表 D1）
   运行：NODE_PATH=%TEMP%\ls-qa\node_modules node tests/p0_guards_qa.js */
const { chromium } = require('playwright');

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);
};
const warnText = async p =>
  (await p.$eval('#warn-banner', el => el.hidden ? '' : el.innerText)).replace(/\s+/g, ' ');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  await p.goto('http://127.0.0.1:9527/#playground', { waitUntil: 'networkidle' });
  await p.evaluate(() => { try { localStorage.setItem('layastudio.onboarded.v1','1'); } catch(e){} const ob = document.querySelector('#onboard'); if (ob) ob.classList.add('hidden'); });
  await p.waitForSelector('#f-run');

  // ---------- 基线：语义标签英文 choice → 应无警告 ----------
  await p.fill('#f-state', 'Please refund the duplicate charge on invoice 4411.');
  await p.fill('#f-key', 'dept');
  await p.fill('#f-instr', 'Which department?');
  await p.fill('#f-options', 'billing: refunds\ntechnical: bugs');
  await p.click('#f-run');
  await p.waitForSelector('#verdict-row:not([hidden])', { timeout: 30000 });
  const cleanWarn = await warnText(p);
  check('T0 基线无警告', cleanWarn === '', `warn="${cleanWarn.slice(0, 40)}"`);

  // ---------- T5 结果教育（基线运行后即可验） ----------
  const confTitles = await p.$$eval('.conf b[title]', els => els.map(e => e.title));
  check('T5a conf 悬浮解释', confTitles.length >= 1 && confTitles[0].includes('熵'),
    `n=${confTitles.length}`);
  const helpExists = await p.$('#conf-help summary');
  check('T5b 官方告谕 ⓘ', !!helpExists, '');
  await p.click('#conf-help summary');
  await p.waitForTimeout(200);
  const helpText = await p.$eval('#conf-help', el => el.innerText);
  check('T5c 告谕内容', helpText.includes('probabilities') && helpText.includes('confidence'),
    '');
  const subText = await p.$eval('#task-form-sub', el => el.textContent);
  check('T5d 原子问题提示', subText.includes('一题只判断'), subText.slice(0, 30));

  // ---------- T6 预算条 ----------
  const budget = await p.$eval('#budget-bar', el => el.hidden ? '' : el.innerText).catch(() => '');
  const tokMatch = (budget.match(/([\d,]+)\s*\/\s*64,000/) || [])[1];
  const tokVal = tokMatch ? Number(tokMatch.replace(/,/g, '')) : 0;
  check('T6 预算条', tokVal > 0 && budget.includes('64,000'), `tokens=${tokVal}`);

  // ---------- T1 布尔标签警告 ----------
  await p.fill('#f-options', 'true: yes this applies\nfalse: no it does not');
  await p.click('#f-run');
  await p.waitForFunction(() => {
    const w = document.querySelector('#warn-banner');
    return w && !w.hidden && w.innerText.includes('#156');
  }, { timeout: 30000 });
  const t1w = await warnText(p);
  check('T1 布尔标签警告', t1w.includes('#156'), t1w.slice(0, 60));

  // ---------- T4 警告不阻断（等推理完成，黄条先于结果渲染是预期行为） ----------
  await p.waitForSelector('#verdict-row:not([hidden])', { timeout: 30000 });
  const verdictVisible = await p.$eval('#verdict-row', el => !el.hidden);
  const resultCards = await p.$$eval('#results .q-result', els => els.length);
  check('T4 警告不阻断执行', verdictVisible && resultCards >= 1, `cards=${resultCards}`);

  // ---------- T2 多语言 score 首档偏差 ----------
  await p.selectOption('#model-select', 'multilingual');
  await p.click('input[name="task-mode"][value="score"]');
  await p.waitForSelector('#f-levels');
  await p.fill('#f-key', 'urgency');
  await p.fill('#f-instr', 'How urgent?');
  await p.fill('#f-levels', 'not urgent\nsoon\nurgent');
  await p.click('#f-run');
  await p.waitForFunction(() => {
    const w = document.querySelector('#warn-banner');
    return w && !w.hidden && (w.innerText.includes('#131') || w.innerText.includes('首档'));
  }, { timeout: 30000 });
  const t2w = await warnText(p);
  check('T2 多语言score偏差警告', t2w.includes('#131') || t2w.includes('首档'), t2w.slice(0, 60));

  // ---------- T3 中文 noul 提示 ----------
  await p.selectOption('#model-select', '');
  await p.click('input[name="task-mode"][value="noul"]');
  await p.waitForSelector('#f-key');
  await p.fill('#f-key', 'is_angry');
  await p.fill('#f-instr', '用户是否在生气？');
  await p.fill('#f-state', '再不处理我们就投诉到消协，你们这服务太差了！');
  await p.click('#f-run');
  await p.waitForFunction(() => {
    const w = document.querySelector('#warn-banner');
    return w && !w.hidden && (w.innerText.includes('小样本') || w.innerText.includes('未校准'));
  }, { timeout: 30000 });
  const t3w = await warnText(p);
  check('T3 中文noul提示', t3w.includes('小样本') || t3w.includes('未校准'), t3w.slice(0, 60));
  await p.waitForSelector('#verdict-row:not([hidden])', { timeout: 30000 });
  const v3 = await p.$eval('#verdict-row', el => !el.hidden);
  check('T3b 中文提示同样不阻断', v3, '');

  // ---------- T8 超20条提示含分层拆分建议 ----------
  await p.click('input[name="task-mode"][value="choice"]');
  await p.waitForSelector('#f-options');
  const manyOpts = Array.from({ length: 22 },
    (_, i) => `opt${i}: option number ${i} description`).join('\n');
  await p.fill('#f-options', manyOpts);
  await p.waitForTimeout(300);
  const optHint = await p.$eval('#f-options-count', el => el.textContent);
  check('T8 超20条分层拆分提示',
    optHint.includes('分层') && optHint.includes('22'), optHint.slice(0, 70));
  // 还原选项（避免影响后续）
  await p.fill('#f-options', 'billing: refunds\ntechnical: bugs');

  // ---------- T9 通用中文场景预警（choice 也覆盖） ----------
  await p.fill('#f-state', '这是一段普通的中文业务文本，用于触发通用提醒。');
  await p.fill('#f-instr', 'Which department?');
  await p.click('#f-run');
  await p.waitForFunction(() => {
    const w = document.querySelector('#warn-banner');
    return w && !w.hidden && w.innerText.includes('批量评估');
  }, { timeout: 30000 });
  const cjkWarn = await warnText(p);
  check('T9 通用中文预警(Choice)', cjkWarn.includes('批量评估') && cjkWarn.includes('英文效果最佳'),
    cjkWarn.slice(0, 70));

  check('T7 零JS报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  const fails = results.filter(r => !r.ok);
  console.log(`SUMMARY ${results.length - fails.length}/${results.length} passed`);
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });

