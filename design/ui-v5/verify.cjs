const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 });
  const report = {
    date: '2026-11-08',
    scope: 'Standalone offline UI prototype, Chrome headless, no backend or model claims',
    checks: [],
    errors: [],
    consoleErrors: [],
    externalRequests: [],
    overflow: [],
    screenshots: []
  };
  const checksDir = path.join(__dirname, 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  const shot = async (name, fullPage = false) => {
    const file = path.join(checksDir, name);
    await page.screenshot({ path: file, fullPage });
    report.screenshots.push(`checks/${name}`);
  };
  const check = (name, ok, detail = '') => report.checks.push({ name, ok: !!ok, detail });
  page.on('pageerror', (error) => report.errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', (request) => {
    if (!/^(file|data):/.test(request.url())) report.externalRequests.push(request.url());
  });

  const url = 'file:///C:/AI/vibecoding/storyweave/design/ui-v5/index.html';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(420);

  check('desktop initial view', await page.evaluate(() => document.querySelector('.view.is-active')?.dataset.view === 'desk'));
  check('rail navigation count', await page.evaluate(() => document.querySelectorAll('.rail-item').length === 6));
  check('desk chapter rows', await page.evaluate(() => document.querySelectorAll('#deskChapters .chapter-row').length === 4));
  check('desk notes', await page.evaluate(() => document.querySelectorAll('#deskNotes li').length === 4));
  check('continue progress exists', await page.evaluate(() => !!document.querySelector('#continueProgress .progress-track i')));
  await shot('verify-desk.png');

  // Notes and appearance
  await page.locator('#noteInput').fill('把雾写成一个人。');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(220);
  check('quick note adds', await page.evaluate(() => document.querySelectorAll('#deskNotes li').length === 5));
  await page.evaluate(() => document.querySelector('#settingsBtn')?.click());
  await page.waitForTimeout(220);
  check('appearance modal opens', await page.evaluate(() => !document.querySelector('#settingsModal').hidden));
  await page.evaluate(() => document.querySelector('#settingsModal [data-close-modal]')?.click());
  await page.waitForTimeout(180);
  check('appearance modal closes', await page.evaluate(() => document.querySelector('#settingsModal').hidden));

  // Palette
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(180);
  check('palette opens', await page.evaluate(() => !document.querySelector('#palette').hidden));
  await page.locator('#paletteInput').fill('星图');
  await page.waitForTimeout(120);
  await page.locator('.palette-item').first().click();
  await page.waitForTimeout(380);
  check('palette navigates to galaxy', await page.evaluate(() => document.querySelector('.view.is-active')?.dataset.view === 'galaxy'));

  // Galaxy
  check('galaxy nodes rendered', await page.evaluate(() => document.querySelectorAll('#galaxyNodes .g-node').length === 12));
  check('galaxy detail visible', await page.evaluate(() => document.querySelector('#galaxyDetail h2')?.textContent === '林遥'));
  await page.evaluate(() => document.querySelector('[data-galaxy-node="shenyan"]')?.click());
  await page.waitForTimeout(220);
  check('galaxy related node selects', await page.evaluate(() => document.querySelector('#galaxyDetail h2')?.textContent === '沈砚'));
  await page.evaluate(() => document.querySelector('[data-galaxy-type="place"]')?.click());
  await page.waitForTimeout(160);
  check('galaxy filter toggles', await page.evaluate(() => document.querySelector('[data-galaxy-type="place"]')?.classList.contains('is-off')));
  await page.evaluate(() => document.querySelector('[data-galaxy-type="place"]')?.click());
  await page.waitForTimeout(140);
  const zoomBefore = await page.evaluate(() => document.querySelector('#galaxyZoomLabel')?.textContent);
  await page.evaluate(() => document.querySelector('#zoomIn')?.click());
  await page.waitForTimeout(120);
  const zoomAfter = await page.evaluate(() => document.querySelector('#galaxyZoomLabel')?.textContent);
  check('galaxy zoom control', zoomBefore === '100%' && zoomAfter !== '100%');
  await page.evaluate(() => document.querySelector('#zoomReset')?.click());
  await shot('verify-galaxy.png');

  // Theme
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="desk"]')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#themeBtn')?.click());
  await page.waitForTimeout(320);
  check('dark theme applies', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  await shot('verify-desk-dark.png');
  await page.evaluate(() => document.querySelector('#themeBtn')?.click());
  await page.waitForTimeout(240);

  // Writing
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="write"]')?.click());
  await page.waitForTimeout(260);
  check('writing page active', await page.evaluate(() => document.querySelector('.view.is-active')?.dataset.view === 'write'));
  check('editor status visible', await page.evaluate(() => {
    const r = document.querySelector('.editor-status')?.getBoundingClientRect();
    return !!r && r.bottom <= window.innerHeight + 1 && r.top >= 0;
  }));
  await page.evaluate(() => document.querySelector('.chapter-item[data-chapter="3"]')?.click());
  await page.waitForTimeout(220);
  check('chapter switch', await page.evaluate(() => document.querySelector('#paperTitle')?.textContent === '潮汐之后'));
  check('margin beats stacked', await page.evaluate(() => {
    const items = [...document.querySelectorAll('#marginBeats li')];
    return items.length === 3 && items[0].getBoundingClientRect().width > 200;
  }));
  await page.evaluate(() => document.querySelector('.chapter-item[data-chapter="2"]')?.click());
  await page.waitForTimeout(220);
  await page.evaluate(() => document.querySelector('#marginPane [data-margin="suggest"]')?.click());
  await page.waitForTimeout(160);
  const beforeTone = await page.evaluate(() => document.querySelector('#prose')?.innerText.includes('她第一次意识到'));
  await page.evaluate(() => document.querySelector('[data-accept-suggestion]')?.click());
  await page.waitForTimeout(260);
  const afterTone = await page.evaluate(() => document.querySelector('#prose')?.innerText.includes('那句话，也许不是说给小孩听的'));
  check('inline suggestion accepted', beforeTone && afterTone);
  await page.evaluate(() => document.querySelector('#themeBtn')?.click());
  await page.waitForTimeout(220);
  await shot('verify-write-dark.png');
  await page.evaluate(() => document.querySelector('#themeBtn')?.click());
  await page.waitForTimeout(180);

  // Focus
  await page.evaluate(() => document.querySelector('#focusBtn')?.click());
  await page.waitForTimeout(260);
  check('focus mode enters', await page.evaluate(() => document.body.classList.contains('focus-mode')));
  await shot('verify-focus.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(220);
  check('focus mode exits', await page.evaluate(() => !document.body.classList.contains('focus-mode')));

  // Review accept
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="review"]')?.click());
  await page.waitForTimeout(240);
  const beforeCount = await page.evaluate(() => Number(document.querySelector('#openIssueCount')?.textContent));
  await page.evaluate(() => document.querySelector('[data-issue="timeline"]')?.click());
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelector('[data-issue-action="accept"]')?.click());
  await page.waitForTimeout(300);
  const afterCount = await page.evaluate(() => Number(document.querySelector('#openIssueCount')?.textContent));
  check('review accept reduces count', beforeCount === 3 && afterCount === 2);
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="write"]')?.click());
  await page.waitForTimeout(220);
  check('review edit reaches manuscript', await page.evaluate(() => document.querySelector('#prose')?.innerText.includes('七年没有当面听人提起')));
  await shot('verify-write-edited.png');

  // Outline
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="outline"]')?.click());
  await page.waitForTimeout(260);
  check('volume board cards', await page.evaluate(() => document.querySelectorAll('#volumeBoard .chapter-card').length === 7));
  await page.evaluate(() => document.querySelector('#volumeBoard .chapter-card')?.click());
  await page.waitForTimeout(180);
  check('outline drawer opens', await page.evaluate(() => !!document.querySelector('.detail-drawer')));
  await page.evaluate(() => document.querySelector('.detail-drawer [data-close-drawer]')?.click());
  await page.waitForTimeout(160);
  await page.evaluate(() => document.querySelector('[data-tabs="outline"] [data-tab="threads"]')?.click());
  await page.waitForTimeout(220);
  check('threads view', await page.evaluate(() => document.querySelector('[data-tab-panel="threads"]')?.classList.contains('is-active')));
  await page.evaluate(() => document.querySelector('[data-thread="truth"]')?.click());
  await page.waitForTimeout(160);
  check('thread drawer opens', await page.evaluate(() => document.querySelector('.detail-drawer h2')?.textContent === '灯塔真相'));
  await page.evaluate(() => document.querySelector('.detail-drawer [data-close-drawer]')?.click());
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelector('[data-tabs="outline"] [data-tab="beats"]')?.click());
  await page.waitForTimeout(220);
  check('beats view', await page.evaluate(() => document.querySelector('[data-tab-panel="beats"]')?.classList.contains('is-active')));
  check('tension chart points', await page.evaluate(() => document.querySelectorAll('#tensionChart [data-chart-chapter]').length === 7));
  await shot('verify-outline-beats.png');

  // Archive
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="archive"]')?.click());
  await page.waitForTimeout(240);
  check('archive people selected', await page.evaluate(() => document.querySelector('#archiveDetail h2')?.textContent === '林遥'));
  await page.evaluate(() => document.querySelector('#archiveTabs [data-tab="world"]')?.click());
  await page.waitForTimeout(220);
  check('archive world tab', await page.evaluate(() => document.querySelector('#archiveDetail h2')?.textContent === '雾港'));
  await page.evaluate(() => document.querySelector('#archiveTabs [data-tab="clues"]')?.click());
  await page.waitForTimeout(220);
  check('archive clue tab', await page.evaluate(() => document.querySelectorAll('#archiveTabs [data-tab="clues"] span')[0]?.textContent === '6'));
  const pendingBefore = await page.evaluate(() => document.querySelector('#pendingCount')?.textContent);
  await page.evaluate(() => document.querySelector('#confirmCandidate')?.click());
  await page.waitForTimeout(260);
  const pendingAfter = await page.evaluate(() => document.querySelector('#pendingCount')?.textContent);
  check('archive candidate confirms', pendingBefore === '2' && pendingAfter === '1');
  check('archive pending card visible', await page.evaluate(() => !document.querySelector('#pendingCard')?.hidden));
  await shot('verify-archive.png');

  // Desktop widths
  for (const width of [1440, 1280, 1024, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ['desk', 'write', 'outline', 'galaxy', 'archive', 'review']) {
      await page.evaluate((v) => {
        const btn = document.querySelector(`.rail-item[data-nav="${v}"]`) || document.querySelector(`.mobile-nav button[data-nav="${v}"]`);
        btn?.click();
      }, view);
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
      if (overflow > 1) report.overflow.push({ width, view, overflow });
    }
  }
  check('no horizontal overflow', report.overflow.length === 0, JSON.stringify(report.overflow));

  // Mobile screenshots and drawers
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector('.mobile-nav [data-nav="desk"]')?.click());
  await page.waitForTimeout(220);
  await shot('mobile-desk.png');
  await page.evaluate(() => document.querySelector('.mobile-nav [data-nav="write"]')?.click());
  await page.waitForTimeout(220);
  await page.evaluate(() => document.querySelector('#openChapters')?.click());
  await page.waitForTimeout(220);
  check('mobile chapter drawer', await page.evaluate(() => document.body.classList.contains('chapters-open')));
  await shot('mobile-chapters.png');
  await page.evaluate(() => document.querySelector('#closeChapters')?.click());
  await page.waitForTimeout(180);
  check('mobile chapter drawer closes', await page.evaluate(() => !document.body.classList.contains('chapters-open')));
  await page.evaluate(() => document.querySelector('#marginToggle')?.click());
  await page.waitForTimeout(220);
  check('mobile margin drawer', await page.evaluate(() => document.body.classList.contains('margin-open')));
  await shot('mobile-margin.png');
  await page.evaluate(() => document.querySelector('#closeMargin')?.click());
  await page.waitForTimeout(160);
  check('mobile margin drawer closes', await page.evaluate(() => !document.body.classList.contains('margin-open')));
  for (const view of ['outline', 'galaxy', 'archive', 'review']) {
    await page.evaluate((v) => document.querySelector(`.mobile-nav button[data-nav="${v}"]`)?.click(), view);
    await page.waitForTimeout(260);
    await shot(`mobile-${view}.png`);
  }
  check('mobile galaxy list', await page.evaluate(() => document.querySelectorAll('#galaxyMobileList .galaxy-mobile-item').length === 12));
  await page.evaluate(() => document.querySelector('.mobile-nav button[data-nav="galaxy"]')?.click());
  await page.waitForTimeout(260);
  await page.evaluate(() => document.querySelector('#galaxyMobileList [data-galaxy-node="linyao"]')?.click());
  await page.waitForTimeout(260);
  check('mobile galaxy opens detail', await page.evaluate(() => document.querySelector('#galaxyStage')?.classList.contains('has-selection') && document.querySelector('#galaxyDetail h2')?.textContent === '林遥'));
  await page.evaluate(() => document.querySelector('#galaxyDetail [data-close-galaxy]')?.click());
  await page.waitForTimeout(160);
  check('mobile galaxy detail closes', await page.evaluate(() => !document.querySelector('#galaxyStage')?.classList.contains('has-selection')));

  // New chapter flow on a fresh page
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(360);
  await page.evaluate(() => document.querySelector('.rail-item[data-nav="outline"]')?.click());
  await page.waitForTimeout(260);
  await page.evaluate(() => document.querySelector('[data-new-chapter]')?.click());
  await page.waitForTimeout(200);
  await page.locator('#chapterForm input[name="title"]').fill('雨夜来客');
  await page.locator('#chapterForm textarea[name="goal"]').fill('让沈砚在雨夜敲开 203 的门。');
  await page.locator('#chapterForm button[type="submit"]').click();
  await page.waitForTimeout(320);
  check('new chapter joins outline', await page.evaluate(() => document.querySelectorAll('#volumeBoard .chapter-card').length === 8));
  await shot('verify-new-chapter.png');

  report.checks.push({ name: 'summary', ok: report.errors.length === 0 && report.consoleErrors.length === 0 && report.externalRequests.length === 0, detail: `${report.checks.filter((item) => item.ok).length} checks before summary` });
  fs.writeFileSync(path.join(__dirname, 'validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    result: report.errors.length === 0 && report.consoleErrors.length === 0 && report.externalRequests.length === 0 ? 'pass-with-notes' : 'fail',
    checks: report.checks.length,
    failed: report.checks.filter((item) => !item.ok),
    errors: report.errors,
    consoleErrors: report.consoleErrors,
    externalRequests: report.externalRequests,
    overflow: report.overflow,
    screenshots: report.screenshots.length
  }, null, 2));
  await browser.close();
})();
