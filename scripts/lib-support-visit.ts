import type { Page } from "playwright";

/**
 * Goes into a clinic the only way an agency admin can: from the clinic's page in
 * /admin, through "Open workspace", with a reason. See migrations/0067.
 *
 * Opens the clinic page first when given `{ base, slug }`; otherwise expects to
 * be on it already. Returns once the workspace has loaded.
 */
export async function enterWorkspace(
  page: Page,
  opts: { base?: string; slug?: string; reason?: string } = {}
): Promise<void> {
  if (opts.base && opts.slug) {
    await page.goto(`${opts.base}/admin/clinics/${opts.slug}`);
    await page.waitForLoadState("networkidle");
  }
  await page.getByRole("button", { name: /open workspace|فتح مساحة العمل/i }).click();
  await page.fill('input[name="reason"]', opts.reason ?? "QA run");
  await page.getByRole("button", { name: /enter workspace|دخول مساحة العمل/i }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/c/"), { timeout: 60000 });
}
