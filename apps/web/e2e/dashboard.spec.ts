import { expect, test, type Page } from '@playwright/test';

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

async function runScenario(page: Page, type: string, fields: Record<string, string> = {}) {
  await page.goto('/runner');
  await page.getByTestId(`scenario-${type}`).check({ force: true });
  for (const [label, value] of Object.entries(fields))
    await page.getByLabel(label, { exact: true }).fill(value);
  const button = page.getByTestId('run-button');
  await expect(button).toBeEnabled();
  await button.click();
  const result = page.getByTestId('run-result');
  await expect(result).toBeVisible();
  await expect(result).not.toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  return result;
}

test('run the healthy scenario and see every expectation pass', async ({ page }) => {
  const result = await runScenario(page, 'healthy');
  await expect(result).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('assertion-succeeded')).toContainText('passed');
  await expect(page.getByTestId('assertion-effects')).toContainText('passed');

  await nav(page, 'Overview').click();
  await expect(page.getByTestId('stat-succeeded')).toContainText('1');
  await expect(page.getByTestId('stat-business-effects')).toContainText('1');
});

test('inspect the attempt timeline of a retried delivery', async ({ page }) => {
  const result = await runScenario(page, 'fail_twice', { 'Backoff base (ms)': '100' });
  await expect(result).toHaveAttribute('data-status', 'passed');

  await nav(page, 'Events').click();
  await page.getByTestId('events-table').getByRole('link').first().click();
  const timeline = page.getByTestId('attempt-timeline');
  await expect(timeline.locator('li')).toHaveCount(3);
  await expect(page.getByTestId('attempt-1')).toContainText('HTTP 500');
  await expect(page.getByTestId('attempt-1')).toContainText('retryable HTTP error');
  await expect(page.getByTestId('attempt-1')).toContainText('Next retry scheduled');
  await expect(page.getByTestId('attempt-3')).toContainText('HTTP 200');
});

test('timeouts are shown as unknown at the sender, not as a receiver failure', async ({ page }) => {
  const result = await runScenario(page, 'timeout_after_commit', {
    'HTTP timeout (ms)': '400',
    'Backoff base (ms)': '100',
  });
  await expect(result).toHaveAttribute('data-status', 'passed');
  await nav(page, 'Events').click();
  await page.getByTestId('events-table').getByRole('link').first().click();
  await expect(page.getByTestId('attempt-1')).toContainText('Outcome unknown at the sender');

  await nav(page, 'Receiver Inspector').click();
  await expect(page.getByTestId('receiver-summary')).toContainText('Duplicates');
  await expect(page.getByTestId('receiver-requests').getByText('duplicate')).toBeVisible();
});

test('dead letter -> replay keeps the original history and creates a new delivery', async ({
  page,
}) => {
  const result = await runScenario(page, 'invalid_signature');
  await expect(result).toHaveAttribute('data-status', 'passed');

  await nav(page, 'Dead Letters').click();
  const list = page.getByTestId('dead-letters');
  await expect(list).toContainText('permanent_failure');
  await list.getByRole('button', { name: 'Replay' }).first().click();
  await expect(page.getByTestId('replay-created')).toBeVisible();

  // the replay is a second delivery of the same event; the original is untouched
  await nav(page, 'Events').click();
  await page.getByTestId('events-table').getByRole('link').first().click();
  await expect(page.getByText('Replay of', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Delivery/ })).toHaveCount(2);
});

test('exhaust retries then replay passes end to end', async ({ page }) => {
  const result = await runScenario(page, 'exhaust_and_replay', {
    'Max attempts': '3',
    'Backoff base (ms)': '100',
    'Backoff cap (ms)': '300',
  });
  await expect(result).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('assertion-lineage')).toContainText('passed');
});

test('out-of-order snapshots: receiver inspector shows projection at sequence 3', async ({
  page,
}) => {
  const result = await runScenario(page, 'out_of_order');
  await expect(result).toHaveAttribute('data-status', 'passed');
  await nav(page, 'Receiver Inspector').click();
  await expect(page.getByTestId('order-projection')).toContainText('sequence 3');
  await expect(page.getByTestId('receiver-summary')).toContainText('Stale');
  await expect(page.locator('main')).toContainText('receive order (event sequence): 3,1,2');
});

test('events can be filtered and the keyboard can drive navigation', async ({ page }) => {
  await page.goto('/events');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByLabel('Has delivery in state').selectOption('dead');
  await page.getByLabel('All runs').check();
  await expect(page.getByTestId('events-table').getByRole('row')).not.toHaveCount(0);
  await page.getByLabel('Has delivery in state').selectOption('queued');
  await expect(page.getByText('No events match')).toBeVisible();
});
