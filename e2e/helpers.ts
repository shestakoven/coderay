import { expect, type Page } from '@playwright/test';

export async function sendMessage(page: Page, text: string): Promise<void> {
  await expect(page.getByText('core connected')).toBeVisible();
  // A prompt raised before the first map snapshot has no node to open at.
  await expect(page.getByText('1 components')).toBeVisible();
  await page.getByPlaceholder(/Message the agent/).fill(text);
  await page.keyboard.press('Enter');
}
