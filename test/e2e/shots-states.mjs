// Optional state steps for shots.e2e.mjs (STATE_SCRIPT=test/e2e/shots-states.mjs STATES=main,preview,settings,detail).
export default async function step(page, state) {
  const scroll = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel);
  if (state === 'preview') {
    const open = await page.locator('[data-section=preview]').getAttribute('aria-expanded');
    if (open !== 'true') await page.click('[data-section=preview]');
    await page.fill('input[aria-label="인물(chars)"]', '아드리안: 미소 | 옷: black suit, red tie');
    await page.fill('input[aria-label="장면 프롬프트"]', '비 오는 골목, 밤');
    await page.click('text=미리보기 >> nth=-1');
    await page.waitForTimeout(300);
    await scroll('[data-section=preview]');
  } else if (state === 'settings') {
    const open = await page.locator('[data-section=settings]').getAttribute('aria-expanded');
    if (open !== 'true') await page.click('[data-section=settings]');
    await scroll('[data-section=settings]');
  } else if (state === 'detail') {
    await scroll('.lvil');
    await page.click('.lvil-thumb >> nth=0');
  }
}
