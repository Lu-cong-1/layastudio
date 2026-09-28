/* P1 小节 QA：起草助手 / 拆分警示 / 微调旅程 / 温度状态
   运行：NODE_PATH=%TEMP%\ls-qa\node_modules node tests/p1_helpers_qa.js */
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
  p.on('dialog', d => d.accept('QA模板P1'));

  await p.goto('http://127.0.0.1:9527/#playground', { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    localStorage.setItem('layastudio.onboarded.v1', '1');
    const ob = document.querySelector('#onboard');
    if (ob) ob.classList.add('hidden');
  });

  // ---------- H1 起草助手 ----------
  await p.fill('#f-state', '');
  await p.click('#f-draft');
  await p.waitForTimeout(300);
  const emptyToast = await p.$$eval('.toast', els => els.map(e => e.textContent).join('|'));
  check('H1a 空State友好提示', emptyToast.includes('先写一点 State'), emptyToast.slice(0, 40));

  // 高匹配：直接用 triage 预设的 state → 应匹配并填充批量任务
  const presetState = 'Hi, we were billed twice for March. Please refund the duplicate today or we will cancel our plan.';
  await p.fill('#f-state', presetState);
  await p.click('#f-draft');
  await p.waitForTimeout(600);
  const draftToast = await p.$$eval('.toast', els => els.map(e => e.textContent).join('|'));
  const batchChecked = await p.$eval('input[name="task-mode"][value="batch"]', el => el.checked);
  const cards = await p.$$eval('.batch-card', els => els.length);
  check('H1b 预设匹配起草', batchChecked && cards >= 2 && draftToast.includes('起草'),
    `cards=${cards}`);
  const stateKept = await p.$eval('#f-state', el => el.value);
  check('H1c 起草保留原State', stateKept === presetState, '');

  // 无关文本 → 通用骨架
  await p.fill('#f-state', 'zz qq blue sky walking quietly');
  await p.click('#f-draft');
  await p.waitForTimeout(600);
  const skeletonCards = await p.$$eval('.batch-card', els => els.length);
  const skToast = await p.$$eval('.toast', els => els.map(e => e.textContent).join('|'));
  check('H1d 通用骨架兜底', skeletonCards === 2 && skToast.includes('通用骨架'),
    `cards=${skeletonCards}`);

  // ---------- H2 拆分建议警示 ----------
  await p.click('input[name="task-mode"][value="choice"]');
  await p.waitForSelector('#f-key');
  await p.fill('#f-state', 'Some unrelated input text for split hint test.');
  await p.fill('#f-key', 'dept');
  await p.fill('#f-instr', 'Which department and urgency level apply here?');
  await p.fill('#f-options', 'billing: refunds\ntechnical: bugs');
  await p.click('#f-run');
  await p.waitForFunction(() => {
    const w = document.querySelector('#warn-banner');
    return w && !w.hidden && w.innerText.includes('多个因素');
  }, { timeout: 30000 });
  const splitWarn = await warnText(p);
  check('H2 拆分建议警示', splitWarn.includes('原子问题') || splitWarn.includes('拆成多题'),
    splitWarn.slice(0, 70));

  // ---------- H3/H4 微调旅程 ----------
  await p.click('a[data-view="eval"]');
  await p.waitForSelector('.job:has(.job-status.done)');
  await p.click('.job:has(.job-status.done)');
  await p.waitForSelector('#eval-detail:not(.hidden)', { timeout: 8000 });
  await p.waitForTimeout(400);
  const detailTxt = await p.$eval('#eval-detail', el => el.innerText);
  check('H4a 微调四步指引在场', detailTxt.includes('微调四步走'), '');
  await p.click('#ev-export-ds');
  await p.waitForTimeout(700);
  const expToast = await p.$$eval('.toast', els => els.map(e => e.textContent).join('|'));
  check('H3a 导出微调集成功', expToast.includes('微调集已导出') && expToast.includes('finetune'),
    expToast.slice(-80));
  const exports = await p.evaluate(async () => (await fetch('/api/exports')).json());
  check('H3b 导出文件落盘',
    (exports || []).some(e => e.filename.includes('finetune')),
    (exports || [])[0] ? exports[0].filename : 'none');
  // 展开指引
  await p.click('#eval-detail .ft-guide summary');
  await p.waitForTimeout(250);
  check('H4b 指引可展开', await p.$eval('#eval-detail .ft-guide', el => el.open), '');

  // ---------- H5 温度状态 ----------
  const apiModels = await p.evaluate(async () => (await fetch('/api/models')).json());
  const tempOk = Array.isArray(apiModels)
    && apiModels.every(m => m.temperature
      && ['unavailable', 'none', 'global', 'bucket', 'multi', 'unknown'].includes(m.temperature.state));
  check('H5a API 温度字段', tempOk,
    apiModels.map(m => `${m.key}:${m.temperature.state}`).join(' '));
  await p.click('a[data-view="models"]');
  await p.waitForSelector('.model-card');
  const tempShown = await p.$$eval('.model-card .m-spec',
    els => els.some(e => e.innerText.includes('温度')));
  check('H5b 模型卡温度展示', tempShown, '');

  check('H6 零JS报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  const fails = results.filter(r => !r.ok);
  console.log(`SUMMARY ${results.length - fails.length}/${results.length} passed`);
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
