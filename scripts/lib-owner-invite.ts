import type { Browser, Page } from "playwright";

/**
 * Completes a new clinic owner's invitation in the browser.
 *
 * The agency no longer types a password when it creates a clinic — the owner is
 * emailed a link and chooses one. QA has to walk that same path, because a suite
 * that reached in and set `password_hash` by SQL would sign in perfectly well
 * while the invitation was quietly broken.
 *
 * The link comes from the clinic page's "Resend invitation" button rather than
 * from an inbox. Locally RESEND_API_KEY is unset, so `sendEmail` reports
 * `skipped` and the action hands the URL back to be shown — the same fallback a
 * real agency relies on before a mail provider exists.
 *
 * Accepting is done in a throwaway context, never on `adminPage`. The invite
 * action signs the new owner straight in, which would replace the admin's
 * session cookie and quietly sign the suite out of /admin for everything after.
 */
export async function acceptOwnerInvite(
  adminPage: Page,
  browser: Browser,
  base: string,
  slug: string,
  password: string
): Promise<void> {
  await adminPage.goto(`${base}/admin/clinics/${slug}`);
  await adminPage.waitForLoadState("networkidle");
  await adminPage.addStyleTag({ content: "nextjs-portal{display:none!important}" });

  await adminPage.getByRole("button", { name: /resend invitation|إعادة إرسال الدعوة/i }).click();
  const link = adminPage.locator("code");
  await link.waitFor({ state: "visible", timeout: 20000 });
  const url = (await link.innerText()).trim();
  if (!/\/invite\//.test(url)) throw new Error(`not an invite link: ${url.slice(0, 60)}`);

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirm"]', password);
    await page.click('button[type="submit"]');
    /*
      Accepting signs the owner in with `window.location.replace`, so this is a
      full document load into the clinic workspace — a route `next dev` may not
      have compiled yet. Same 120s patience the sign-in helpers use, for the same
      reason: a cold compile is not a failure.
    */
    await page.waitForURL((u) => !u.pathname.includes("/invite/"), { timeout: 120000 });
  } finally {
    await ctx.close();
  }
}
