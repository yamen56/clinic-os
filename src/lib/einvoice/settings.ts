import type { PoolClient } from "pg";

/**
 * A clinic's registration with ISTD, and the device credentials it issues.
 *
 * Every field here belongs to one clinic. Each is its own taxpayer with its own
 * tax number, and nothing in this module is ever shared between them or held by
 * the agency — a clinic's invoices are filed under the clinic's registration or
 * they are filed wrongly.
 */

export const TAXPAYER_TYPES = ["income", "general"] as const;
export type TaxpayerType = (typeof TAXPAYER_TYPES)[number];

export type EinvoiceSettings = {
  enabled: boolean;
  taxpayerType: TaxpayerType;
  registeredName: string;
  taxNumber: string;
  incomeSourceSequence: string;
  clientId: string;
  secretKey: string;
  environment: "production" | "sandbox";
  lastOkAt: string | null;
  lastError: string | null;
};

/** What the settings screen may see: everything except the key itself. */
export type EinvoiceSettingsView = Omit<EinvoiceSettings, "secretKey"> & { hasSecret: boolean };

export const EMPTY_SETTINGS: EinvoiceSettings = {
  enabled: false,
  taxpayerType: "income",
  registeredName: "",
  taxNumber: "",
  incomeSourceSequence: "",
  clientId: "",
  secretKey: "",
  environment: "production",
  lastOkAt: null,
  lastError: null,
};

function fromRow(r: Record<string, unknown> | undefined): EinvoiceSettings {
  if (!r) return { ...EMPTY_SETTINGS };
  return {
    enabled: Boolean(r.enabled),
    taxpayerType: (r.taxpayer_type === "general" ? "general" : "income") as TaxpayerType,
    registeredName: String(r.registered_name ?? ""),
    taxNumber: String(r.tax_number ?? ""),
    incomeSourceSequence: String(r.income_source_sequence ?? ""),
    clientId: String(r.client_id ?? ""),
    secretKey: String(r.secret_key ?? ""),
    environment: r.environment === "sandbox" ? "sandbox" : "production",
    lastOkAt: r.last_ok_at ? new Date(r.last_ok_at as string).toISOString() : null,
    lastError: (r.last_error as string) || null,
  };
}

/** The full record, secret included. Server and worker only — never a prop. */
export async function loadEinvoiceSettings(
  c: PoolClient,
  clinicId: string
): Promise<EinvoiceSettings> {
  const r = await c.query(`select * from clinic_einvoice_settings where clinic_id = $1`, [clinicId]);
  return fromRow(r.rows[0]);
}

/** The same record with the key replaced by whether there is one. Safe to send. */
export async function loadEinvoiceSettingsView(
  c: PoolClient,
  clinicId: string
): Promise<EinvoiceSettingsView> {
  const { secretKey, ...rest } = await loadEinvoiceSettings(c, clinicId);
  return { ...rest, hasSecret: secretKey.length > 0 };
}

/**
 * Whether this clinic can actually file an invoice right now.
 *
 * Deliberately stricter than `enabled`: a clinic that ticked the switch but has
 * not pasted its credentials in yet would otherwise queue every invoice into a
 * submission that cannot possibly succeed, and learn about it as a wall of
 * failures rather than an empty field on a form.
 */
export function isReady(s: EinvoiceSettings): boolean {
  if (!s.enabled) return false;
  if (!s.clientId || !s.secretKey || !s.taxNumber || !s.registeredName) return false;
  // The income-source sequence identifies which registered activity the sale
  // belongs to, and only a sales-tax taxpayer has one.
  if (s.taxpayerType === "general" && !s.incomeSourceSequence) return false;
  return true;
}

/** What is missing, so the settings screen can say so rather than just refusing. */
export function missingFields(s: EinvoiceSettings): string[] {
  const out: string[] = [];
  if (!s.registeredName) out.push("registeredName");
  if (!s.taxNumber) out.push("taxNumber");
  if (!s.clientId) out.push("clientId");
  if (!s.secretKey) out.push("secretKey");
  if (s.taxpayerType === "general" && !s.incomeSourceSequence) out.push("incomeSourceSequence");
  return out;
}
