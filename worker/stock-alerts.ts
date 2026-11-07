import { DateTime } from "luxon";
import { withSystem } from "./db";
import { licensed } from "./features";
import { loadStockAttention, type StockAttention } from "../src/lib/charts/face/stock";
import { productAmount } from "../src/lib/charts/face/catalog";
import { notifyUser, staffMembersInRoles } from "../src/lib/notify";
import { resolveCapabilities, type MemberRole } from "../src/lib/permissions";
import { NT, asLocale, type NLocale } from "../src/lib/notification-text";

/*
  Its own module, like treatments.ts: the scheduler reaches the WhatsApp session
  store, and a QA script that imports it to run this pass would load Baileys.
  `force` skips the clinic-hours gate, for that script.
*/

/** Told during the clinic's day only. Something that ran low at night is news in the morning. */
const FIRST_HOUR = 9;
const LAST_HOUR = 21;

/** Lines in one notification before the rest become "and N more". */
const LINES = 6;

function line(L: (typeof NT)[NLocale], locale: NLocale, a: StockAttention): string {
  const left = productAmount(a.unit, a.amount, locale);
  if (a.kind === "out") return L.stockOut(a.name);
  if (a.kind === "low") return L.stockLow(a.name, left);
  if (a.kind === "expired") return L.stockExpired(a.name, a.lot, left);
  const date = DateTime.fromISO(a.expiresOn!)
    .setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB")
    .toFormat("d LLLL");
  return L.stockExpiring(a.name, a.lot, date);
}

/**
 * The face chart's products running low or out, and batches about to expire or
 * expired on the shelf (2026-11-07: "make everything more connected").
 *
 * The Stock page already showed all of it, to whoever thought to open it. This
 * tells the people who order: the owner and the desk, where they keep Stock.
 *
 * Each occurrence is told once. It is claimed with a row in `jobs`, whose unique
 * `dedupe_key` is the occurrence's name, so a second tick, a second worker or a
 * restart finds it taken. What is new on a tick goes out as one notification.
 */
export async function stockAlerts(opts: { force?: boolean } = {}) {
  await withSystem(async (c) => {
    const clinics = (await c.query(`select cl.id, cl.slug, cl.timezone from clinics cl where ${licensed("aesthetic")}`)).rows;
    for (const clinic of clinics) {
      const hour = DateTime.now().setZone(clinic.timezone).hour;
      if (!opts.force && (hour < FIRST_HOUR || hour >= LAST_HOUR)) continue;

      const fresh: StockAttention[] = [];
      for (const a of await loadStockAttention(c, clinic.id)) {
        const claimed = await c.query(
          `insert into jobs (clinic_id, kind, payload, status, dedupe_key)
           values ($1, 'stock_alert', $2, 'done', $3)
           on conflict (dedupe_key) do nothing returning id`,
          [clinic.id, JSON.stringify({ kind: a.kind, product: a.productId }), a.episode]
        );
        if (claimed.rowCount) fresh.push(a);
      }
      if (!fresh.length) continue;

      for (const m of await staffMembersInRoles(c, clinic.id, ["owner", "receptionist"])) {
        if (!resolveCapabilities(m.permissions, { isOwner: m.isOwner, role: m.role as MemberRole }).stock) continue;
        const locale = asLocale(m.locale);
        const L = NT[locale];
        const lines = fresh.map((a) => line(L, locale, a));
        const shown = lines.slice(0, LINES);
        if (lines.length > LINES) shown.push(L.stockMore(lines.length - LINES));
        await notifyUser(c, m.userId, {
          clinicId: clinic.id,
          kind: "stock_alert",
          title: lines.length === 1 ? lines[0] : L.stockTitle(lines.length),
          body: lines.length === 1 ? "" : shown.join("\n"),
          url: `/c/${clinic.slug}/stock`,
        });
      }
    }
  });
}
