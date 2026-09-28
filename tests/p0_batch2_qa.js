/* P0 第二批 QA：首次引导 + 置信度三态门控 + 评估覆盖率
   运行：NODE_PATH=%TEMP%\ls-qa\node_modules node tests/p0_batch2_qa.js */
const { chromium } = require('playwright');

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' | ' + extra : ''}`);
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => d.accept('QA模板B2'));

  // ---------- G1 首次引导 ----------
  await p.goto('http://127.0.0.1:9527/#playground', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('#onboard:not(.hidden)', { timeout: 8000 });
  check('G1a 首次进入弹出引导', true);
  const s1 = await p.$eval('.ob-step[data-step="1"]', el => !el.classList.contains('hidden'));
  check('G1b 第1步可见', s1);
  await p.click('#ob-next');
  await p.click('#ob-next');
  const s3 = await p.$eval('.ob-step[data-step="3"]', el => !el.classList.contains('hidden'));
  const btnTxt = await p.$eval('#ob-next', el => el.textContent);
  check('G1c 走到第3步', s3 && btnTxt.includes('开始使用'), btnTxt);
  await p.click('#ob-next');
  check('G1d 完成后关闭', await p.$eval('#onboard', el => el.classList.contains('hidden')));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  check('G1e 标记持久化（刷新不再弹）',
    await p.$eval('#onboard', el => el.classList.contains('hidden')));
  await p.click('#ob-reopen');
  check('G1f 可重看引导', await p.$eval('#onboard', el => !el.classList.contains('hidden')));
  await p.click('#ob-skip');
  check('G1g 跳过关闭', await p.$eval('#onboard', el => el.classList.contains('hidden')));

  // ---------- G2 门控徽章（语义 choice 一次真实推理） ----------
  await p.fill('#f-state', 'Please refund the duplicate charge on invoice 4411 ASAP.');
  await p.fill('#f-key', 'dept');
  await p.fill('#f-instr', 'Which department?');
  await p.fill('#f-options', 'billing: refunds\ntechnical: bugs');
  await p.click('#f-run');
  await p.waitForSelector('#verdict-row:not([hidden])', { timeout: 30000 });
  check('G2a 门控条显示', await p.$eval('#gate-bar', el => !el.hidden));
  const badge085 = await p.$eval('.q-result .gate-badge',
    el => ({ cls: el.className, txt: el.textContent }));
  check('G2b 三态徽章存在',
    ['auto', 'esc', 'abs'].some(k => badge085.cls.includes(k))
      && ['可自动', '转人工', '弃答'].includes(badge085.txt),
    `cls=${badge085.cls.replace('gate-badge ', '')} txt=${badge085.txt}`);
  const t085 = await p.$eval('#gate-val', el => el.textContent);
  check('G2c 默认阈值 0.85', t085 === '0.85', t085);

  // ---------- G3 阈值实时响应（不重新推理） ----------
  await p.evaluate(() => {
    const s = document.querySelector('#gate-threshold');
    s.value = '0.99';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(450);
  const badge99 = await p.$eval('.q-result .gate-badge', el => el.textContent);
  check('G3a 阈值0.99 → 转人工', badge99 === '转人工', badge99);
  const persisted99 = await p.evaluate(() => localStorage.getItem('layastudio.threshold'));
  check('G3b 阈值持久化', persisted99 === '0.99', String(persisted99));
  await p.evaluate(() => {
    const s = document.querySelector('#gate-threshold');
    s.value = '0.5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(450);
  const badge50 = await p.$eval('.q-result .gate-badge', el => el.textContent);
  check('G3c 阈值0.5 → 可自动', badge50 === '可自动', badge50);

  // ---------- G4 阈值随模板保存 + 会话恢复 ----------
  await p.evaluate(() => {
    const s = document.querySelector('#gate-threshold');
    s.value = '0.7';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(350);
  await p.click('#f-save');            // dialog 已注册 → 自动填名保存
  await p.waitForTimeout(600);
  // 严格验证：抹掉独立的 THRESH_KEY，只剩 TEMPLATE_KEY 里的 threshold
  await p.evaluate(() => localStorage.removeItem('layastudio.threshold'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  const restoredT = await p.$eval('#gate-val', el => el.textContent);
  check('G4 阈值随模板会话恢复', restoredT === '0.70', restoredT);

  // ---------- G5 评估覆盖率卡片 ----------
  await p.click('a[data-view="eval"]');
  await p.waitForSelector('.job', { timeout: 8000 });
  await p.click('.job:has(.job-status.done)');
  await p.waitForSelector('#eval-detail:not(.hidden)', { timeout: 8000 });
  await p.waitForTimeout(500);
  const detailTxt = await p.$eval('#eval-detail', el => el.innerText);
  check('G5 acc@50/80 覆盖率卡片',
    detailTxt.includes('acc@50%覆盖') && detailTxt.includes('acc@80%覆盖'),
    detailTxt.includes('acc@50%') ? '' : '未找到覆盖率卡');

  check('G6 零JS报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  const fails = results.filter(r => !r.ok);
  console.log(`SUMMARY ${results.length - fails.length}/${results.length} passed`);
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
