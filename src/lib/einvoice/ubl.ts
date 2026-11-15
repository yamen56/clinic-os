import type { EinvoiceSettings, TaxpayerType } from "./settings";
import { round2, type TaxCategory } from "../invoices";

/**
 * The UBL 2.1 document JoFotara wants, built as text.
 *
 * There is no Node library we depend on for this, so the XML is generated
 * here. That is less alarming than it sounds: the document is fixed in shape,
 * every value is a number or a short string, and building it by hand keeps the
 * whole contract with ISTD readable in one file.
 *
 * Deliberately pure. Rows in, string out, no database and no clock, so the
 * document a clinic will actually file can be asserted on in a test.
 *
 * The shape follows ISTD's technical guide for the national e-invoicing API
 * (v1.4), as two independent readings of it agree: the rule set of the
 * jofotara-kit validator (which cites the guide page by page) and the
 * jafar-albadarneh PHP SDK, whose author has filed income invoices live. Where
 * this file once differed from both — the amount currency, the tax blocks on
 * an income invoice, the income source sequence, the line tax structure, the
 * credit note's reference — it was wrong, and has been brought in line.
 * scripts/mock-jofotara.ts enforces the same rules on every QA submission.
 *
 * ⚠️ Still a reading of the guide, not ISTD's own acceptance. The first real
 * filing from a clinic's own device is the test that settles it; there is no
 * sandbox on ISTD's side.
 */

/** UN/CEFACT 1001 document type. */
export const DOC_INVOICE = "388";
export const DOC_CREDIT_NOTE = "381";

/**
 * ISTD's invoice sub-type, carried as the `name` attribute of InvoiceTypeCode.
 *
 * Second digit: 1 settled now (cash), 2 owed (receivable). Third digit: 1 an
 * income-tax taxpayer, 2 a general sales-tax one. Special sales tax (3) covers
 * goods no clinic sells and is not offered.
 */
export const SUBTYPE: Record<TaxpayerType, { cash: string; receivable: string }> = {
  income: { cash: "011", receivable: "021" },
  general: { cash: "012", receivable: "022" },
};

/**
 * Every amount carries `currencyID="JO"` — ISTD's own value, not the ISO "JOD"
 * that the document- and tax-currency codes use. Sending "JOD" on the amounts
 * is a rejection.
 */
const AMT = `currencyID="JO"`;

/** The sales-tax rates ISTD accepts on a line. */
export const ISTD_RATES = [0, 1, 2, 3, 4, 5, 7, 8, 10, 16] as const;

/**
 * Clinicti's tax categories, as ISTD spells them.
 *
 * JoFotara uses three codes and gives two of them the opposite of their UN/ECE
 * meaning: `Z` is **exempt** (معفى) and `O` is **zero-rated** (خاضع بنسبة صفر).
 * `E` does not exist there. So exempt goes out as Z, zero-rated as O, and
 * "outside the scope" — which ISTD has no code for — as exempt.
 */
export function istdCategory(c: TaxCategory): "S" | "Z" | "O" {
  if (c === "S") return "S";
  if (c === "Z") return "O";
  return "Z";
}

export type EinvoiceLine = {
  description: string;
  qty: number;
  unitPrice: number;
  /** Gross of discount: qty x unitPrice. */
  amount: number;
  discount: number;
  taxCategory: TaxCategory;
  taxRate: number;
  tax: number;
};

export type EinvoiceInput = {
  settings: EinvoiceSettings;
  /** Ours, generated once and reused on every retry of the same invoice. */
  uuid: string;
  /** The clinic's own invoice number, as printed. */
  number: string;
  /** Per-clinic monotonic counter; ISTD calls it the ICV. */
  icv: number;
  issueDate: string;
  documentType: typeof DOC_INVOICE | typeof DOC_CREDIT_NOTE;
  /** Settled now (cash) or owed (receivable). A credit note passes its original's. */
  paid: boolean;
  buyerName: string;
  /** The patient's Jordanian national number, when the file has one. */
  buyerNationalId?: string | null;
  buyerTaxNumber?: string | null;
  lines: EinvoiceLine[];
  /** Credit notes only: the document being reversed, as ISTD holds it. */
  corrects?: { number: string; uuid: string; payable: number } | null;
  correctionReason?: string | null;
};

/** Escapes the five characters that can end an XML document early. */
export function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Money, as ISTD reads it: a plain decimal, three places for the fils. Clinicti
 * stores two — a deliberate, recorded limitation — so the third is always zero.
 */
function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(3);
}

function qty(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Only S carries a rate; Z and O are 0 by definition. */
function percentOf(line: EinvoiceLine): number {
  return istdCategory(line.taxCategory) === "S" ? line.taxRate : 0;
}

/** What the document is, which decides which blocks it carries. */
function kindOf(input: EinvoiceInput): { sales: boolean; credit: boolean; salesReturn: boolean } {
  const sales = input.settings.taxpayerType === "general";
  const credit = input.documentType === DOC_CREDIT_NOTE;
  return { sales, credit, salesReturn: sales && credit };
}

function taxCategoryXml(line: EinvoiceLine, indent: string): string {
  return [
    `${indent}<cac:TaxCategory>`,
    `${indent}  <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${istdCategory(line.taxCategory)}</cbc:ID>`,
    `${indent}  <cbc:Percent>${percentOf(line)}</cbc:Percent>`,
    `${indent}  <cac:TaxScheme>`,
    `${indent}    <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>`,
    `${indent}  </cac:TaxScheme>`,
    `${indent}</cac:TaxCategory>`,
  ].join("\n");
}

function lineXml(line: EinvoiceLine, i: number, k: ReturnType<typeof kindOf>): string {
  const net = round2(line.amount - line.discount);
  const out = [
    `  <cac:InvoiceLine>`,
    `    <cbc:ID>${i + 1}</cbc:ID>`,
    `    <cbc:InvoicedQuantity unitCode="PCE">${qty(line.qty)}</cbc:InvoicedQuantity>`,
    `    <cbc:LineExtensionAmount ${AMT}>${money(net)}</cbc:LineExtensionAmount>`,
  ];
  /*
    Tax on the line only for a sales-tax taxpayer — an income-tax invoice carries
    no tax block anywhere, line or document. Every sales line carries one, exempt
    and zero-rated included, with the category inside the subtotal.
  */
  if (k.sales) {
    out.push(
      `    <cac:TaxTotal>`,
      `      <cbc:TaxAmount ${AMT}>${money(line.tax)}</cbc:TaxAmount>`,
      // What the buyer pays for this line. ISTD recomputes it and compares.
      `      <cbc:RoundingAmount ${AMT}>${money(round2(net + line.tax))}</cbc:RoundingAmount>`,
      `      <cac:TaxSubtotal>`,
      ...(k.salesReturn ? [`        <cbc:TaxableAmount ${AMT}>${money(net)}</cbc:TaxableAmount>`] : []),
      `        <cbc:TaxAmount ${AMT}>${money(line.tax)}</cbc:TaxAmount>`,
      taxCategoryXml(line, "        "),
      `      </cac:TaxSubtotal>`,
      `    </cac:TaxTotal>`
    );
  }
  out.push(
    `    <cac:Item>`,
    `      <cbc:Name>${esc(line.description)}</cbc:Name>`,
    `    </cac:Item>`,
    `    <cac:Price>`,
    `      <cbc:PriceAmount ${AMT}>${money(line.unitPrice)}</cbc:PriceAmount>`,
    ...(k.salesReturn ? [`      <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity>`] : []),
    /*
      The discount is an allowance on the price, which is where ISTD wants it per
      line. Always emitted, zero included.
    */
    `      <cac:AllowanceCharge>`,
    `        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>`,
    `        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>`,
    `        <cbc:Amount ${AMT}>${money(line.discount)}</cbc:Amount>`,
    `      </cac:AllowanceCharge>`,
    `    </cac:Price>`,
    `  </cac:InvoiceLine>`
  );
  return out.join("\n");
}

/**
 * The totals block, from the same line numbers that are emitted.
 *
 * ISTD's arithmetic: TaxExclusiveAmount is quantity × price before any
 * discount; the allowance is the sum of the line discounts; TaxInclusiveAmount
 * is that less the discount plus the tax; PayableAmount equals it.
 */
export function totalsOf(lines: EinvoiceLine[], sales = true): {
  /** Σ qty × price, before discount — ISTD's TaxExclusiveAmount. */
  extended: number;
  /** Σ (amount − discount): what the lines come to before tax. */
  net: number;
  discount: number;
  tax: number;
  /** net + tax — TaxInclusiveAmount and PayableAmount. */
  gross: number;
} {
  const extended = round2(lines.reduce((s, l) => s + l.amount, 0));
  const discount = round2(lines.reduce((s, l) => s + l.discount, 0));
  const net = round2(extended - discount);
  const tax = sales ? round2(lines.reduce((s, l) => s + l.tax, 0)) : 0;
  return { extended, net, discount, tax, gross: round2(net + tax) };
}

/**
 * What would make ISTD refuse this document, found before it is sent — so the
 * clinic reads a sentence it can act on instead of an error code, and nothing
 * leaves for a submission that cannot succeed. Null when it is fit to file.
 */
export function preflight(input: EinvoiceInput): string | null {
  const s = input.settings;
  if (!/^\d+$/.test(s.taxNumber.trim())) return "The tax number must be digits only.";
  if (!/^\d+$/.test(s.incomeSourceSequence.trim())) {
    return "The income source sequence (تسلسل مصدر الدخل) is missing or not digits — it is on every invoice.";
  }
  if (!input.lines.length) return "The invoice has no lines.";
  const k = kindOf(input);
  for (const l of input.lines) {
    if (!(l.qty > 0)) return `"${l.description}": the quantity must be more than zero.`;
    if (!l.description.trim()) return "A line has no description.";
    if (k.sales && istdCategory(l.taxCategory) === "S") {
      if (!(ISTD_RATES as readonly number[]).includes(l.taxRate) || l.taxRate === 0) {
        return `"${l.description}": ISTD accepts sales tax at ${ISTD_RATES.filter((r) => r).join(", ")}% only, not ${l.taxRate}%.`;
      }
    }
  }
  if (totalsOf(input.lines, k.sales).gross <= 0) return "The invoice comes to nothing — there is no sale to report.";
  if (k.credit) {
    if (!input.corrects?.uuid) return "A credit note needs the invoice it reverses, as ISTD holds it.";
    if (!input.correctionReason?.trim()) return "A credit note needs a reason.";
  }
  return null;
}

export function buildInvoiceXml(input: EinvoiceInput): string {
  const { settings: s, lines } = input;
  const k = kindOf(input);
  const t = totalsOf(lines, k.sales);
  const sub = SUBTYPE[s.taxpayerType];
  const subtype = input.paid ? sub.cash : sub.receivable;

  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"`,
    `         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"`,
    `         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"`,
    `         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">`,
    `  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>`,
    `  <cbc:ID>${esc(input.number)}</cbc:ID>`,
    `  <cbc:UUID>${esc(input.uuid)}</cbc:UUID>`,
    `  <cbc:IssueDate>${esc(input.issueDate)}</cbc:IssueDate>`,
    `  <cbc:InvoiceTypeCode name="${subtype}">${input.documentType}</cbc:InvoiceTypeCode>`,
    `  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>`,
    `  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>`,
  ];

  /*
    A credit note names the document it reverses exactly as ISTD holds it: the
    original's number, the original's UUID — the one we sent and they stamped —
    and the original's payable amount.
  */
  if (k.credit && input.corrects) {
    parts.push(
      `  <cac:BillingReference>`,
      `    <cac:InvoiceDocumentReference>`,
      `      <cbc:ID>${esc(input.corrects.number)}</cbc:ID>`,
      `      <cbc:UUID>${esc(input.corrects.uuid)}</cbc:UUID>`,
      `      <cbc:DocumentDescription>${money(input.corrects.payable)}</cbc:DocumentDescription>`,
      `    </cac:InvoiceDocumentReference>`,
      `  </cac:BillingReference>`
    );
  }

  // The invoice counter value. ISTD uses it to notice a gap, which is why the
  // counter must never be reused.
  parts.push(
    `  <cac:AdditionalDocumentReference>`,
    `    <cbc:ID>ICV</cbc:ID>`,
    `    <cbc:UUID>${input.icv}</cbc:UUID>`,
    `  </cac:AdditionalDocumentReference>`,

    `  <cac:AccountingSupplierParty>`,
    `    <cac:Party>`,
    `      <cac:PostalAddress>`,
    `        <cac:Country>`,
    `          <cbc:IdentificationCode>JO</cbc:IdentificationCode>`,
    `        </cac:Country>`,
    `      </cac:PostalAddress>`,
    `      <cac:PartyTaxScheme>`,
    `        <cbc:CompanyID>${esc(s.taxNumber.trim())}</cbc:CompanyID>`,
    `        <cac:TaxScheme>`,
    `          <cbc:ID>VAT</cbc:ID>`,
    `        </cac:TaxScheme>`,
    `      </cac:PartyTaxScheme>`,
    `      <cac:PartyLegalEntity>`,
    `        <cbc:RegistrationName>${esc(s.registeredName)}</cbc:RegistrationName>`,
    `      </cac:PartyLegalEntity>`,
    `    </cac:Party>`,
    `  </cac:AccountingSupplierParty>`
  );

  /*
    The buyer. Identified by the patient's national number when the file has
    one — the identifier the guide asks for (scheme NIN) — and otherwise by an
    empty NIN, as a walk-in cash sale is: buyer details are only required for a
    receivable invoice or one over 10,000 JOD. The name goes either way; it is
    what makes the invoice useful to the patient afterwards, and it is required
    on the receivable ones.
  */
  const nin = input.buyerNationalId && /^\d{10}$/.test(input.buyerNationalId) ? input.buyerNationalId : "";
  parts.push(
    `  <cac:AccountingCustomerParty>`,
    `    <cac:Party>`,
    `      <cac:PartyIdentification>`,
    `        <cbc:ID schemeID="NIN">${nin}</cbc:ID>`,
    `      </cac:PartyIdentification>`,
    `      <cac:PostalAddress>`,
    `        <cac:Country>`,
    `          <cbc:IdentificationCode>JO</cbc:IdentificationCode>`,
    `        </cac:Country>`,
    `      </cac:PostalAddress>`
  );
  if (input.buyerTaxNumber) {
    parts.push(
      `      <cac:PartyTaxScheme>`,
      `        <cbc:CompanyID>${esc(input.buyerTaxNumber)}</cbc:CompanyID>`,
      `        <cac:TaxScheme>`,
      `          <cbc:ID>VAT</cbc:ID>`,
      `        </cac:TaxScheme>`,
      `      </cac:PartyTaxScheme>`
    );
  }
  parts.push(
    `      <cac:PartyLegalEntity>`,
    `        <cbc:RegistrationName>${esc(input.buyerName)}</cbc:RegistrationName>`,
    `      </cac:PartyLegalEntity>`,
    `    </cac:Party>`,
    `  </cac:AccountingCustomerParty>`,

    // The registered activity this sale belongs to. On every invoice, for every
    // taxpayer — income and sales alike.
    `  <cac:SellerSupplierParty>`,
    `    <cac:Party>`,
    `      <cac:PartyIdentification>`,
    `        <cbc:ID>${esc(s.incomeSourceSequence.trim())}</cbc:ID>`,
    `      </cac:PartyIdentification>`,
    `    </cac:Party>`,
    `  </cac:SellerSupplierParty>`
  );

  // Why a credit note exists: ISTD reads the reason here, not from a Note.
  if (k.credit) {
    parts.push(
      `  <cac:PaymentMeans>`,
      `    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>`,
      `    <cbc:InstructionNote>${esc(input.correctionReason?.trim() || "إرجاع فاتورة")}</cbc:InstructionNote>`,
      `  </cac:PaymentMeans>`
    );
  }

  parts.push(
    `  <cac:AllowanceCharge>`,
    `    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>`,
    `    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>`,
    `    <cbc:Amount ${AMT}>${money(t.discount)}</cbc:Amount>`,
    `  </cac:AllowanceCharge>`
  );

  if (k.sales) {
    parts.push(`  <cac:TaxTotal>`, `    <cbc:TaxAmount ${AMT}>${money(t.tax)}</cbc:TaxAmount>`);
    // A sales return also breaks the tax down by category and rate.
    if (k.salesReturn) {
      const groups = new Map<string, { line: EinvoiceLine; taxable: number; tax: number }>();
      for (const l of lines) {
        const key = `${istdCategory(l.taxCategory)}:${percentOf(l)}`;
        const g = groups.get(key) ?? { line: l, taxable: 0, tax: 0 };
        g.taxable = round2(g.taxable + l.amount - l.discount);
        g.tax = round2(g.tax + l.tax);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        parts.push(
          `    <cac:TaxSubtotal>`,
          `      <cbc:TaxableAmount ${AMT}>${money(g.taxable)}</cbc:TaxableAmount>`,
          `      <cbc:TaxAmount ${AMT}>${money(g.tax)}</cbc:TaxAmount>`,
          taxCategoryXml(g.line, "      "),
          `    </cac:TaxSubtotal>`
        );
      }
    }
    parts.push(`  </cac:TaxTotal>`);
  }

  parts.push(
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:TaxExclusiveAmount ${AMT}>${money(t.extended)}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount ${AMT}>${money(t.gross)}</cbc:TaxInclusiveAmount>`,
    `    <cbc:AllowanceTotalAmount ${AMT}>${money(t.discount)}</cbc:AllowanceTotalAmount>`,
    ...(k.salesReturn ? [`    <cbc:PrepaidAmount ${AMT}>0</cbc:PrepaidAmount>`] : []),
    `    <cbc:PayableAmount ${AMT}>${money(t.gross)}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`
  );

  for (const [i, line] of lines.entries()) parts.push(lineXml(line, i, k));
  parts.push(`</Invoice>`);
  return parts.join("\n");
}

/** The document as ISTD receives it: base64 of the UTF-8 bytes. */
export function encodeInvoice(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}
