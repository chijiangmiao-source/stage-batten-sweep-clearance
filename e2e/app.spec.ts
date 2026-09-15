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
