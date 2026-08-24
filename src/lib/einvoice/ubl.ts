import type { EinvoiceSettings, TaxpayerType } from "./settings";
import type { TaxCategory } from "../invoices";

/**
 * The UBL 2.1 document JoFotara wants, built as text.
 *
 * There is no Node library for this — the published integrations are PHP and
 * .NET — so the XML is generated here. That is less alarming than it sounds:
 * the document is fixed in shape, every value is a number or a short string,
 * and building it by hand keeps the whole contract with ISTD readable in one
 * file rather than buried in a dependency's opinions.
 *
 * Deliberately pure. Rows in, string out, no database and no clock, so the
 * document a clinic will actually file can be asserted on in a test.
 *
 * ⚠️ The element set below follows ISTD's published UBL profile as documented by
 * the integrators building against it. The authoritative specification is
 * delivered with the device credentials inside a taxpayer's own JoFotara portal
 * account. Reconcile against that document, and against a test device, before a
 * clinic files anything real.
 */

/** UN/CEFACT 1001 document type. */
export const DOC_INVOICE = "388";
export const DOC_CREDIT_NOTE = "381";

/**
 * ISTD's invoice sub-type, carried as the `name` attribute of InvoiceTypeCode.
 *
 * The digits encode two independent things: which tax the taxpayer is
 * registered for, and whether this sale was settled now or is owed. Income
 * taxpayers charge no sales tax at all, which is most small clinics in Jordan.
 */
export const SUBTYPE: Record<TaxpayerType, { cash: string; receivable: string }> = {
  income: { cash: "011", receivable: "021" },
  general: { cash: "012", receivable: "022" },
};

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
  currency: string;
  documentType: typeof DOC_INVOICE | typeof DOC_CREDIT_NOTE;
  paid: boolean;
  buyerName: string;
  buyerPhone?: string | null;
  buyerTaxNumber?: string | null;
  lines: EinvoiceLine[];
  /** Credit notes only: the invoice being corrected, and why. */
  correctsNumber?: string | null;
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
 * Money, as ISTD reads it.
 *
 * Fixed to three places because JOD divides into 1000 fils and the receiving
 * end compares at that precision or finer. Clinicti stores two — a deliberate,
 * recorded limitation — so the third digit is always zero here. Emitting two
 * would be a different statement: that the clinic priced to the piastre.
 */
function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(3);
}

function qty(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Only 'S' carries a percentage; the other three are 0 by definition. */
function percentOf(line: EinvoiceLine): number {
  return line.taxCategory === "S" ? line.taxRate : 0;
}

function taxCategoryXml(line: EinvoiceLine, indent: string): string {
  return [
    `${indent}<cac:TaxCategory>`,
    `${indent}  <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${line.taxCategory}</cbc:ID>`,
    `${indent}  <cbc:Percent>${percentOf(line).toFixed(2)}</cbc:Percent>`,
    `${indent}  <cac:TaxScheme>`,
    `${indent}    <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>`,
    `${indent}  </cac:TaxScheme>`,
    `${indent}</cac:TaxCategory>`,
  ].join("\n");
}

function lineXml(line: EinvoiceLine, i: number, cur: string): string {
  const net = round2(line.amount - line.discount);
  return [
    `  <cac:InvoiceLine>`,
    `    <cbc:ID>${i + 1}</cbc:ID>`,
    `    <cbc:InvoicedQuantity unitCode="PCE">${qty(line.qty)}</cbc:InvoicedQuantity>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${money(net)}</cbc:LineExtensionAmount>`,
    `    <cac:TaxTotal>`,
    `      <cbc:TaxAmount currencyID="${cur}">${money(line.tax)}</cbc:TaxAmount>`,
    // What the buyer pays for this line. ISTD recomputes it and compares.
    `      <cbc:RoundingAmount currencyID="${cur}">${money(round2(net + line.tax))}</cbc:RoundingAmount>`,
    `    </cac:TaxTotal>`,
    `    <cac:Item>`,
    `      <cbc:Name>${esc(line.description)}</cbc:Name>`,
    taxCategoryXml(line, "      "),
    `    </cac:Item>`,
    `    <cac:Price>`,
    `      <cbc:PriceAmount currencyID="${cur}">${money(line.unitPrice)}</cbc:PriceAmount>`,
    /*
      The discount is an allowance on the price, which is the only place UBL
      lets it live per line — and per line is the only place ISTD accepts it.
      Always emitted, zero included: an absent allowance and a zero allowance
      read the same to a person and differently to a validator.
    */
    `      <cac:AllowanceCharge>`,
    `        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>`,
    `        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>`,
    `        <cbc:Amount currencyID="${cur}">${money(line.discount)}</cbc:Amount>`,
    `      </cac:AllowanceCharge>`,
    `    </cac:Price>`,
    `  </cac:InvoiceLine>`,
  ].join("\n");
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The totals block, summed from the same line numbers that were just emitted. */
export function totalsOf(lines: EinvoiceLine[]): {
  net: number;
  discount: number;
  tax: number;
  gross: number;
} {
  const net = round2(lines.reduce((s, l) => s + (l.amount - l.discount), 0));
  const discount = round2(lines.reduce((s, l) => s + l.discount, 0));
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
  return { net, discount, tax, gross: round2(net + tax) };
}

export function buildInvoiceXml(input: EinvoiceInput): string {
  const { settings: s, lines } = input;
  const cur = input.currency;
  const t = totalsOf(lines);
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
  ];

  if (input.documentType === DOC_CREDIT_NOTE) {
    // A credit note is only meaningful against the invoice it corrects, and
    // ISTD requires both the reference and a stated reason.
    parts.push(`  <cbc:Note>${esc(input.correctionReason || "Correction")}</cbc:Note>`);
  }

  parts.push(
    `  <cbc:DocumentCurrencyCode>${esc(cur)}</cbc:DocumentCurrencyCode>`,
    `  <cbc:TaxCurrencyCode>${esc(cur)}</cbc:TaxCurrencyCode>`
  );

  if (input.documentType === DOC_CREDIT_NOTE && input.correctsNumber) {
    parts.push(
      `  <cac:BillingReference>`,
      `    <cac:InvoiceDocumentReference>`,
      `      <cbc:ID>${esc(input.correctsNumber)}</cbc:ID>`,
      `      <cbc:UUID>${esc(input.correctionReason || "Correction")}</cbc:UUID>`,
      `    </cac:InvoiceDocumentReference>`,
      `  </cac:BillingReference>`
    );
  }

  // The invoice counter value: how many documents this clinic has issued. ISTD
  // uses it to notice a gap, which is why the counter must never be reused.
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
    `        <cbc:CompanyID>${esc(s.taxNumber)}</cbc:CompanyID>`,
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
    The buyer.

    Not required at all for a cash invoice, which is the overwhelming majority of
    a clinic's work — somebody pays at the desk and leaves. That matters more
    here than it looks: it means reception never has to ask a patient for a tax
    number, which they would not have and would not enjoy being asked for.
    Whatever the clinic does know is still sent, because a name on the invoice is
    what makes it useful to the patient afterwards.
  */
  parts.push(`  <cac:AccountingCustomerParty>`, `    <cac:Party>`);
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
    `      <cac:PostalAddress>`,
    `        <cac:Country>`,
    `          <cbc:IdentificationCode>JO</cbc:IdentificationCode>`,
    `        </cac:Country>`,
    `      </cac:PostalAddress>`,
    `      <cac:PartyLegalEntity>`,
    `        <cbc:RegistrationName>${esc(input.buyerName)}</cbc:RegistrationName>`,
    `      </cac:PartyLegalEntity>`,
    `    </cac:Party>`
  );
  if (input.buyerPhone) {
    parts.push(
      `    <cac:AccountingContact>`,
      `      <cbc:Telephone>${esc(input.buyerPhone)}</cbc:Telephone>`,
      `    </cac:AccountingContact>`
    );
  }
  parts.push(`  </cac:AccountingCustomerParty>`);

  // Which registered activity this sale belongs to. Sales-tax taxpayers only.
  if (s.taxpayerType === "general" && s.incomeSourceSequence) {
    parts.push(
      `  <cac:SellerSupplierParty>`,
      `    <cac:Party>`,
      `      <cac:PartyIdentification>`,
      `        <cbc:ID>${esc(s.incomeSourceSequence)}</cbc:ID>`,
      `      </cac:PartyIdentification>`,
      `    </cac:Party>`,
      `  </cac:SellerSupplierParty>`
    );
  }

  parts.push(
    `  <cac:AllowanceCharge>`,
    `    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>`,
    `    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>`,
    `    <cbc:Amount currencyID="${cur}">${money(t.discount)}</cbc:Amount>`,
    `  </cac:AllowanceCharge>`,

    `  <cac:TaxTotal>`,
    `    <cbc:TaxAmount currencyID="${cur}">${money(t.tax)}</cbc:TaxAmount>`,
    `  </cac:TaxTotal>`,

    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${money(t.net)}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${money(t.gross)}</cbc:TaxInclusiveAmount>`,
    `    <cbc:AllowanceTotalAmount currencyID="${cur}">${money(t.discount)}</cbc:AllowanceTotalAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${money(t.gross)}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`
  );

  for (const [i, line] of lines.entries()) parts.push(lineXml(line, i, cur));
  parts.push(`</Invoice>`);
  return parts.join("\n");
}

/** The document as ISTD receives it: base64 of the UTF-8 bytes. */
export function encodeInvoice(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}
