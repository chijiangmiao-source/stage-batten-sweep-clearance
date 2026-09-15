import { expect, test } from '@playwright/test';

test('shows the exact first contact, object pair, edges and pose for the real default scene', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '首次接触' })).toBeVisible();
  await expect(page.getByText('时间：')).toContainText('700 ms');
  await expect(page.getByText('对象 1 ↔ 对象 3').first()).toBeVisible();
  // The segment overlap pair E2/E1 is enumerated together with its endpoint contacts.
  await expect(page.getByText(/E1 \/ E1/).first()).toBeVisible();
  await expect(page.getByText(/E2 \/ E1/)).toBeVisible();
  await expect(page.getByText(/共线重合/).first()).toBeVisible();
});

test('jump-to-contact and playback controls move the playhead over a real rendered canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: '跳到首次接触' }).click();
  await expect(page.getByTestId('playhead')).toHaveText('700.00 ms');

  await page.getByRole('button', { name: '回放' }).click();
  await page.getByRole('button', { name: '暂停' }).waitFor();
  await expect(page.getByTestId('playhead')).not.toHaveText('700.00 ms');
});

test('moving the forbidden zone away yields a safe verdict over the whole closed interval', async ({ page }) => {
  await page.goto('/');
  for (let i = 0; i < 4; i += 1) {
    const x = page.locator(`#field-forbidden-vertices-${i}-x`);
    await x.fill(String(1300 + i * 0 + (i === 2 || i === 3 ? 200 : 0)));
  }
  await expect(page.getByRole('heading', { name: '安全' })).toBeVisible();
  await expect(page.getByText(/全程严格分离/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '首次接触' })).toHaveCount(0);
});

test('jumping to a sub-microsecond rational first contact does not crash the page', async ({ page }) => {
  await page.goto('/');
  const fields: Array<[string, string]> = [
    ['#field-booms-1-keyframes-0-x', '200'],
    ['#field-booms-1-keyframes-0-y', '169'],
    ['#field-booms-1-keyframes-1-t', '1'],
    ['#field-booms-1-keyframes-1-x', '200'],
    ['#field-booms-1-keyframes-1-y', '1000000169']
  ];
  for (const [selector, value] of fields) {
    await page.locator(selector).fill(value);
  }

  await expect(page.getByText('时间：')).toContainText('1/1000000000 ms');
  await page.getByRole('button', { name: '跳到首次接触' }).click();
  await expect(page.getByRole('heading', { name: '首次接触' })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
});

test('a counter-clockwise forbidden polygon focuses the first offending field', async ({ page }) => {
  await page.goto('/');
  const ccw = [
    ['300', '100'],
    ['500', '100'],
    ['500', '300'],
    ['300', '300']
  ];
  for (let i = 0; i < ccw.length; i += 1) {
    await page.locator(`#field-forbidden-vertices-${i}-x`).fill(ccw[i][0]);
    await page.locator(`#field-forbidden-vertices-${i}-y`).fill(ccw[i][1]);
  }
  await expect(page.getByRole('heading', { name: '输入非法' })).toBeVisible();
  await expect(page.getByText(/必须按顺时针录入/)).toBeVisible();
  await expect(page.locator('#field-forbidden-vertices-0-x')).toBeFocused();
});

test('illegal input is retained, clears the stale verdict and locates the first bad field', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '首次接触' })).toBeVisible();

  // Vertex 4 already equals vertex 1 once its X becomes 300 (Y is already 100):
  // the transition to invalid must keep the text and relocate focus to the bad field.
  const duplicateField = page.locator('#field-forbidden-vertices-3-x');
  await duplicateField.fill('300');

  await expect(page.getByRole('heading', { name: '输入非法' })).toBeVisible();
  await expect(page.getByText('旧校核结论已清除')).toBeVisible();
  await expect(page.getByRole('heading', { name: '安全' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '首次接触' })).toHaveCount(0);
  await expect(duplicateField).toBeFocused();

  // Restoring the value must immediately produce a fresh conclusion rather than a stuck error.
  await duplicateField.fill('500');
  await expect(page.getByRole('heading', { name: '首次接触' })).toBeVisible();
});

test('envelope across keyframes overlays exact area and ring count, and edge click jumps to its earliest time', async ({ page }) => {
  await page.goto('/');
  // Boom 1 keyframes 0..1000; request an interval straddling no interior frame
  // first (0..1000), then a between-frames interval (200..800) to exercise
  // endpoint pose reuse between keyframes.
  await page.locator('#field-envelope-start').fill('200');
  await page.locator('#field-envelope-end').fill('800');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();

  await expect(page.getByTestId('envelope-summary')).toContainText('[200, 800] ms');
  // Box 60x30 translates 60 mm in x: area = 1800 + 60*30 = 3600.
  await expect(page.getByTestId('envelope-area')).toHaveText('3600');
  await expect(page.getByTestId('envelope-outers')).toHaveText('1');
  await expect(page.getByTestId('envelope-holes')).toHaveText('0');

  // Click the first envelope edge using the canvas projection test hook, then
  // verify the playhead jumps to that edge's exact earliest time.
  const click = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement & {
      __project?: (x: number, y: number) => [number, number];
      __envelopeEdges?: Array<{ id: number; x1: number; y1: number; x2: number; y2: number; firstTime: number }>;
    };
    const edges = canvas.__envelopeEdges ?? [];
    const target = edges.find((edge) => edge.firstTime === 200) ?? edges[0];
    const rect = canvas.getBoundingClientRect();
    const cx = (target.x1 + target.x2) / 2;
    const cy = (target.y1 + target.y2) / 2;
    return { clientX: rect.left + cx, clientY: rect.top + cy, firstTime: target.firstTime };
  });
  await page.mouse.click(click.clientX, click.clientY);
  await expect(page.getByTestId('playhead')).toHaveText(`${click.firstTime.toFixed(2)} ms`);
  await expect(page.getByTestId('envelope-edge-info')).toBeVisible();
});

test('envelope start/end errors retain text, remove the envelope and refocus, without clearing the 700 ms contact', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('时间：')).toContainText('700 ms');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();
  await expect(page.getByTestId('envelope-area')).toBeVisible();

  // Non-integer start: text retained, envelope removed, first error focused.
  await page.locator('#field-envelope-start').fill('1.5');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();
  await expect(page.getByTestId('envelope-area')).toHaveCount(0);
  await expect(page.locator('#field-envelope-start')).toBeFocused();
  await expect(page.getByText(/起始毫秒必须是整数/)).toBeVisible();
  // Contact verdict remains.
  await expect(page.getByText('时间：')).toContainText('700 ms');

  // Reversed bounds:
  await page.locator('#field-envelope-start').fill('900');
  await page.locator('#field-envelope-end').fill('100');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();
  await expect(page.locator('#field-envelope-start')).toBeFocused();
  await expect(page.getByText(/不得晚于/)).toBeVisible();

  // Out of common interval [0,1000]:
  await page.locator('#field-envelope-start').fill('0');
  await page.locator('#field-envelope-end').fill('1001');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();
  await expect(page.locator('#field-envelope-end')).toBeFocused();

  // Fix and reconfirm: envelope comes back, errors gone.
  await page.locator('#field-envelope-end').fill('1000');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();
  await expect(page.getByTestId('envelope-area')).toBeVisible();
  await expect(page.getByText(/必须是整数|不得晚于|必须位于共同校核区间/)).toHaveCount(0);
  await expect(page.getByText('时间：')).toContainText('700 ms');
});

test('default scene still reports the original first contact at 700 ms after envelope interactions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '确认计算占用包络' }).click();
  await expect(page.getByTestId('envelope-area')).toHaveText('4800');
  await expect(page.getByRole('heading', { name: '首次接触' })).toBeVisible();
  await expect(page.getByText('时间：')).toContainText('700 ms');
  await page.getByRole('button', { name: '跳到首次接触' }).click();
  await expect(page.getByTestId('playhead')).toHaveText('700.00 ms');
});
