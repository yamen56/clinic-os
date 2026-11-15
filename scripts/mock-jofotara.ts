/**
 * A stand-in for JoFotara, so QA can exercise the whole submission path without
 * touching the Jordanian tax authority.
 *
 * This is not a convenience. Filing an invoice with ISTD is a real, recorded,
 * irreversible act — a test that reached the live endpoint would put fictional
 * patients into a clinic's tax return, and the only way back from that is a
 * credit note. `JOFOTARA_BASE_URL` points at this instead, and the real host is
 * never in a test's reach. ISTD has no sandbox of its own.
 *
 * It validates rather than just answering, against the rules of ISTD's
 * technical guide for the e-invoicing API (v1.4) as the jofotara-kit validator
 * reads them — the rule ids below are that kit's, so a failure here can be
 * looked up there. It parses the document as XML rather than matching text, and
 * it remembers what it accepted, so a credit note is checked against the
 * invoice it reverses the way ISTD checks it.
 *
 * Answers in ISTD's own shape: EINV_RESULTS (status, ERRORS), EINV_STATUS,
 * EINV_QR, EINV_NUM, EINV_INV_UUID.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_JOFOTARA_PORT || 4111);

/** Set by a test to make the next N submissions fail in a particular way. */
type Fault = { status: number; body: string; times: number } | null;
let fault: Fault = null;

/* ------------------------------------------------------------------ XML */

type El = { name: string; attrs: Record<string, string>; children: El[]; text: string };

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A small strict parser — enough for UBL: elements, attributes, text. Throws on malformed input. */
export function parseXml(xml: string): El {
  let i = 0;
  const s = xml.replace(/^﻿/, "");
  const skipProlog = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith("<?", i)) i = s.indexOf("?>", i) + 2;
      else if (s.startsWith("<!--", i)) i = s.indexOf("-->", i) + 3;
      else return;
      if (i < 2) throw new Error("unterminated declaration");
    }
  };
  const element = (): El => {
    if (s[i] !== "<") throw new Error(`expected an element at ${i}`);
    const end = s.indexOf(">", i);
    if (end < 0) throw new Error("unterminated tag");
    let head = s.slice(i + 1, end);
    const selfClosing = head.endsWith("/");
    if (selfClosing) head = head.slice(0, -1);
    const name = head.match(/^[\w:.-]+/)?.[0];
    if (!name) throw new Error(`bad tag at ${i}`);
    const attrs: Record<string, string> = {};
    for (const m of head.slice(name.length).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = decode(m[2]);
    i = end + 1;
    const el: El = { name, attrs, children: [], text: "" };
    if (selfClosing) return el;
    for (;;) {
      const lt = s.indexOf("<", i);
      if (lt < 0) throw new Error(`unclosed <${name}>`);
      el.text += decode(s.slice(i, lt));
      i = lt;
      if (s.startsWith("</", i)) {
        const close = s.indexOf(">", i);
        const closing = s.slice(i + 2, close).trim();
        if (closing !== name) throw new Error(`</${closing}> closes <${name}>`);
        i = close + 1;
        el.text = el.children.length ? el.text.trim() : el.text;
        return el;
      }
      if (s.startsWith("<!--", i)) {
        i = s.indexOf("-->", i) + 3;
        continue;
      }
      el.children.push(element());
    }
  };
  skipProlog();
  const root = element();
  skipProlog();
  if (i < s.length) throw new Error("content after the root element");
  return root;
}

const kids = (el: El | undefined, name: string) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el: El | undefined, name: string) => kids(el, name)[0];
/** Follow a path of child names. */
const at = (el: El | undefined, ...path: string[]): El | undefined => path.reduce<El | undefined>((e, p) => kid(e, p), el);
const txt = (el: El | undefined, ...path: string[]) => (at(el, ...path)?.text ?? "").trim();
const descendants = (el: El): El[] => el.children.flatMap((c) => [c, ...descendants(c)]);

/* ------------------------------------------------------------------ rules */

const ORDER = [
  "cbc:ProfileID", "cbc:ID", "cbc:UUID", "cbc:IssueDate", "cbc:InvoiceTypeCode", "cbc:Note",
  "cbc:DocumentCurrencyCode", "cbc:TaxCurrencyCode", "cac:BillingReference", "cac:AdditionalDocumentReference",
  "cac:AccountingSupplierParty", "cac:AccountingCustomerParty", "cac:SellerSupplierParty", "cac:PaymentMeans",
  "cac:AllowanceCharge", "cac:TaxTotal", "cac:LegalMonetaryTotal", "cac:InvoiceLine",
];
const OPTIONAL = new Set(["cbc:Note", "cac:BillingReference", "cac:PaymentMeans", "cac:TaxTotal"]);
const REPEATABLE = new Set(["cac:AdditionalDocumentReference", "cac:InvoiceLine"]);
const CITY_CODES = new Set(["JO-BA", "JO-MN", "JO-MD", "JO-MA", "JO-KA", "JO-JA", "JO-IR", "JO-AZ", "JO-AT", "JO-AQ", "JO-AM", "JO-AJ"]);
const RATES = new Set([0, 1, 2, 3, 4, 5, 7, 8, 10, 16]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEC_RE = /^\d+(\.\d+)?$/;

/** Equal within ISTD's tolerance: a fil, plus a hair of relative slack. */
const close = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps + Math.abs(b) * 1e-6;

/** What a document says about itself, for the checks that span documents. */
export type Filed = { number: string; uuid: string; payable: number; typeName: string; credit: boolean; corrects?: { number: string; uuid: string } };

/**
 * Every rule a single document must pass, as `[ruleId, message]`; empty when it
 * is fit to accept. Pure — the checks against earlier documents are the
 * server's, below.
 */
export function checkUbl(xml: string): { problems: [string, string][]; doc: Filed | null } {
  const problems: [string, string][] = [];
  const fail = (id: string, msg: string) => problems.push([id, msg]);
  let root: El;
  try {
    root = parseXml(xml);
  } catch (e) {
    return { problems: [["XML-001", `not well-formed XML: ${(e as Error).message}`]], doc: null };
  }
  if (root.name !== "Invoice" || root.attrs.xmlns !== "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2") {
    fail("XML-002", "the root must be Invoice in the UBL Invoice-2 namespace");
  }

  // Structure: required, ordered, not repeated.
  const top = root.children.map((c) => c.name);
  for (const name of ORDER) if (!OPTIONAL.has(name) && !top.includes(name)) fail("XML-003", `missing ${name}`);
  let last = -1;
  for (const name of top) {
    const pos = ORDER.indexOf(name);
    if (pos < 0) continue;
    if (pos < last) fail("XML-004", `${name} is out of order`);
    last = Math.max(last, pos);
  }
  for (const name of new Set(top)) {
    if (!REPEATABLE.has(name) && top.filter((n) => n === name).length > 1) fail("XML-006", `${name} appears more than once`);
  }

  // Header.
  if (txt(root, "cbc:ProfileID") !== "reporting:1.0") fail("HDR-001", 'ProfileID must be "reporting:1.0"');
  const uuid = txt(root, "cbc:UUID");
  if (!UUID_RE.test(uuid)) fail("HDR-002", "UUID is not a valid UUID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt(root, "cbc:IssueDate"))) fail("HDR-003", "IssueDate must be yyyy-mm-dd");
  const typeCode = txt(root, "cbc:InvoiceTypeCode");
  if (typeCode !== "388" && typeCode !== "381") fail("HDR-004", "InvoiceTypeCode must be 388 or 381");
  const typeName = kid(root, "cbc:InvoiceTypeCode")?.attrs.name ?? "";
  const tn = typeName.match(/^0([12])([123])$/);
  if (!tn) fail("HDR-005", `unknown invoice type name "${typeName}"`);
  const receivable = tn?.[1] === "2";
  const track = tn?.[2] === "1" ? "income" : tn?.[2] === "3" ? "special" : "sales";
  const credit = typeCode === "381";
  const salesReturn = credit && track === "sales";
  if (txt(root, "cbc:DocumentCurrencyCode") !== "JOD" || txt(root, "cbc:TaxCurrencyCode") !== "JOD") {
    fail("HDR-007", "DocumentCurrencyCode and TaxCurrencyCode must be JOD");
  }
  const icv = kids(root, "cac:AdditionalDocumentReference").find((d) => txt(d, "cbc:ID") === "ICV");
  if (!/^[1-9]\d*$/.test(txt(icv, "cbc:UUID"))) fail("HDR-008", "ICV must be a positive integer");

  // Parties.
  const seller = at(root, "cac:AccountingSupplierParty", "cac:Party");
  if (!txt(seller, "cac:PartyTaxScheme", "cbc:CompanyID")) fail("PTY-001", "seller tax number missing");
  if (!txt(seller, "cac:PartyLegalEntity", "cbc:RegistrationName")) fail("PTY-002", "seller registered name missing");
  if (txt(seller, "cac:PostalAddress", "cac:Country", "cbc:IdentificationCode") !== "JO") fail("PTY-008", "seller country must be JO");
  const sequence = txt(root, "cac:SellerSupplierParty", "cac:Party", "cac:PartyIdentification", "cbc:ID");
  if (!sequence) fail("PTY-003", "income source sequence missing (every taxpayer)");
  else if (!/^\d+$/.test(sequence)) fail("PTY-004", "income source sequence must be digits");
  const buyer = at(root, "cac:AccountingCustomerParty", "cac:Party");
  const buyerId = at(buyer, "cac:PartyIdentification", "cbc:ID");
  if (!buyerId) fail("PTY-005", "buyer PartyIdentification missing");
  else {
    if (!["NIN", "PN", "TN"].includes(buyerId.attrs.schemeID ?? "")) fail("PTY-005", "buyer id scheme must be NIN, PN or TN");
    // Empty is a walk-in cash sale; anything typed must be digits.
    if (buyerId.text.trim() && !/^\d+$/.test(buyerId.text.trim())) fail("PTY-005", "buyer id must be digits");
  }
  const city = txt(buyer, "cac:PostalAddress", "cbc:CountrySubentityCode");
  if (city && !CITY_CODES.has(city)) fail("PTY-009", `unknown city code ${city}`);

  // Amounts: plain decimals, never negative, all in "JO".
  for (const el of descendants(root)) {
    if ("currencyID" in el.attrs) {
      if (el.attrs.currencyID !== "JO") fail("AMT-002", `${el.name} has currencyID="${el.attrs.currencyID}", ISTD wants "JO"`);
      if (!DEC_RE.test(el.text.trim())) fail(el.text.trim().startsWith("-") ? "AMT-003" : "AMT-001", `${el.name} is not a plain non-negative decimal: "${el.text}"`);
    }
  }

  // Lines.
  const lines = kids(root, "cac:InvoiceLine");
  const ids = new Set<string>();
  let sumExtended = 0;
  let sumDiscount = 0;
  let sumTax = 0;
  for (const [n, l] of lines.entries()) {
    const ref = `line ${n + 1}`;
    const id = txt(l, "cbc:ID");
    if (!/^[1-9]\d*$/.test(id) || ids.has(id)) fail("LIN-001", `${ref}: ids must be unique positive integers`);
    ids.add(id);
    const q = kid(l, "cbc:InvoicedQuantity");
    const qty = Number(q?.text);
    if (!(qty > 0)) fail("LIN-002", `${ref}: quantity must be more than zero`);
    if (q?.attrs.unitCode !== "PCE") fail("LIN-004", `${ref}: unitCode must be PCE`);
    if (!txt(l, "cac:Item", "cbc:Name")) fail("LIN-005", `${ref}: item name missing`);
    if (at(l, "cac:Item", "cac:TaxCategory") || at(l, "cac:Item", "cac:ClassifiedTaxCategory")) {
      fail("XML-005", `${ref}: the tax category belongs in TaxTotal/TaxSubtotal, not under Item`);
    }
    const price = Number(txt(l, "cac:Price", "cbc:PriceAmount"));
    const discount = Number(txt(l, "cac:Price", "cac:AllowanceCharge", "cbc:Amount") || 0);
    const ext = Number(txt(l, "cbc:LineExtensionAmount"));
    if (!close(qty * price - discount, ext, 0.0051)) fail("MTH-001", `${ref}: ${qty} × ${price} − ${discount} is not ${ext}`);
    sumExtended += qty * price;
    sumDiscount += discount;

    const lineTax = kid(l, "cac:TaxTotal");
    if (track === "income") {
      if (lineTax) fail("INC-001", `${ref}: an income invoice carries no tax`);
    } else {
      if (!lineTax) {
        fail("INC-002", `${ref}: a sales invoice needs a TaxTotal on every line`);
        continue;
      }
      const tax = Number(txt(lineTax, "cbc:TaxAmount"));
      sumTax += tax;
      if (!close(Number(txt(lineTax, "cbc:RoundingAmount")), ext + tax)) fail("MTH-002", `${ref}: RoundingAmount must be the line plus its tax`);
      const sub = kid(lineTax, "cac:TaxSubtotal");
      const cat = kid(sub, "cac:TaxCategory");
      if (!sub || !cat) {
        fail("XML-003", `${ref}: TaxTotal needs a TaxSubtotal with its TaxCategory`);
        continue;
      }
      if (!close(Number(txt(sub, "cbc:TaxAmount")), tax)) fail("MTH-003", `${ref}: subtotal tax differs from the line's`);
      const code = txt(cat, "cbc:ID");
      const rate = Number(txt(cat, "cbc:Percent"));
      if (!["S", "Z", "O"].includes(code)) fail("LIN-007", `${ref}: tax category must be S, Z or O (not ${code})`);
      if (code === "S" && rate === 0) fail("LIN-006", `${ref}: S needs a rate`);
      if ((code === "Z" || code === "O") && (rate !== 0 || tax !== 0)) fail("LIN-006", `${ref}: ${code} carries no tax`);
      if (!RATES.has(rate)) fail("LIN-009", `${ref}: ${rate}% is not a rate ISTD accepts`);
      if (!close(tax, ext * (rate / 100), 0.006)) fail("LIN-008", `${ref}: tax is not ${rate}% of the line`);
      if (salesReturn) {
        if (!close(Number(txt(sub, "cbc:TaxableAmount")), ext)) fail("RET-006", `${ref}: a sales return needs TaxableAmount`);
        const base = at(l, "cac:Price", "cbc:BaseQuantity");
        if (base?.attrs.unitCode !== "C62" || Number(base.text) !== 1) fail("RET-009", `${ref}: a sales return needs BaseQuantity C62 = 1`);
      }
    }
  }

  // Document totals.
  const allowance = Number(txt(root, "cac:AllowanceCharge", "cbc:Amount") || 0);
  const totals = kid(root, "cac:LegalMonetaryTotal");
  const exclusive = Number(txt(totals, "cbc:TaxExclusiveAmount"));
  const inclusive = Number(txt(totals, "cbc:TaxInclusiveAmount"));
  const allowanceTotal = Number(txt(totals, "cbc:AllowanceTotalAmount") || 0);
  const prepaid = Number(txt(totals, "cbc:PrepaidAmount") || 0);
  const payable = Number(txt(totals, "cbc:PayableAmount"));
  if (!close(allowance, sumDiscount) || !close(allowanceTotal, sumDiscount)) {
    fail("MTH-005", "the document discount must be the sum of the line discounts");
  }
  if (!close(exclusive, sumExtended, 0.0051 * Math.max(1, lines.length))) {
    fail("MTH-006", `TaxExclusiveAmount ${exclusive} must be Σ qty × price before discount (${sumExtended.toFixed(3)})`);
  }
  const docTax = kid(root, "cac:TaxTotal");
  if (track === "income") {
    if (docTax) fail("INC-001", "an income invoice carries no TaxTotal");
  } else if (!docTax) {
    fail("INC-002", "a sales invoice needs a document TaxTotal");
  } else if (!close(Number(txt(docTax, "cbc:TaxAmount")), sumTax)) {
    fail("MTH-004", "document tax must be the sum of the line tax");
  }
  if (!close(inclusive, exclusive - allowanceTotal + (track === "income" ? 0 : sumTax))) {
    fail("MTH-007", "TaxInclusiveAmount must be TaxExclusiveAmount − discount + tax");
  }
  if (!close(payable, inclusive - prepaid)) fail("MTH-008", "PayableAmount must be TaxInclusiveAmount − PrepaidAmount");
  if (!credit && (receivable || payable > 10000) && !txt(buyer, "cac:PartyLegalEntity", "cbc:RegistrationName")) {
    fail("PTY-007", "the buyer's name is required on a receivable invoice or one over 10,000 JOD");
  }

  // Returns.
  let corrects: Filed["corrects"];
  if (credit) {
    const ref = at(root, "cac:BillingReference", "cac:InvoiceDocumentReference");
    if (!ref || !txt(ref, "cbc:ID") || !txt(ref, "cbc:UUID") || !txt(ref, "cbc:DocumentDescription")) {
      fail("RET-001", "a credit note needs BillingReference with the original's ID, UUID and DocumentDescription");
    } else {
      if (!UUID_RE.test(txt(ref, "cbc:UUID"))) fail("RET-002", "BillingReference UUID must be the original invoice's UUID");
      if (!DEC_RE.test(txt(ref, "cbc:DocumentDescription"))) fail("RET-003", "DocumentDescription must be the original's payable amount");
      if (txt(ref, "cbc:UUID") === uuid) fail("RET-007", "a credit note needs its own UUID");
      if (payable > Number(txt(ref, "cbc:DocumentDescription")) + 0.001) fail("RET-008", "a credit note cannot exceed the original");
      corrects = { number: txt(ref, "cbc:ID"), uuid: txt(ref, "cbc:UUID") };
    }
    if (!txt(root, "cac:PaymentMeans", "cbc:InstructionNote")) fail("RET-004", "a credit note needs a reason in PaymentMeans/InstructionNote");
    if (salesReturn) {
      if (!kids(docTax, "cac:TaxSubtotal").length) fail("RET-010", "a sales return needs document TaxSubtotals");
      if (txt(totals, "cbc:PrepaidAmount") === "" || prepaid !== 0) fail("RET-011", "a sales return needs PrepaidAmount 0");
    }
  }

  return {
    problems,
    doc: { number: txt(root, "cbc:ID"), uuid, payable, typeName, credit, corrects },
  };
}

/** The first problem as one line, or null — the shape the older QA reads. */
export function validateUbl(xml: string): string | null {
  const { problems } = checkUbl(xml);
  return problems.length ? `${problems[0][0]}: ${problems[0][1]}` : null;
}

/* ------------------------------------------------------------------ server */

/** The last document accepted, so a test can read what was actually filed. */
let lastXml = "";
/** And the key it came with — a sealed one reaching ISTD would be a rejection. */
let lastSecret = "";
/** What has been accepted, by UUID, for the checks a credit note answers to. */
const accepted = new Map<string, Filed>();

export function startMockJofotara(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    };
    const refuse = (status: number, errors: [string, string][]) =>
      send(status, {
        EINV_RESULTS: {
          status: "ERROR",
          ERRORS: errors.map(([code, message]) => ({ EINV_CODE: code, EINV_MESSAGE: message })),
          WARNINGS: [],
          INFO: [],
        },
        EINV_STATUS: "NOT_SUBMITTED",
      });

    // A test's control channel, not part of the real API.
    if (req.method === "POST" && req.url === "/__fault") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        fault = raw ? JSON.parse(raw) : null;
        send(200, { ok: true });
      });
      return;
    }
    if (req.method === "POST" && req.url === "/__reset") {
      fault = null;
      return send(200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/__last") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      return res.end(lastXml);
    }
    if (req.method === "GET" && req.url === "/__last-secret") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(lastSecret);
    }

    if (!req.url?.startsWith("/core/invoices")) return send(404, { error: "not_found" });

    const clientId = req.headers["client-id"];
    const secret = req.headers["secret-key"];
    if (!clientId || !secret) return refuse(403, [["AUTH-001", "missing credentials"]]);

    if (fault && fault.times > 0) {
      fault.times -= 1;
      return send(fault.status, fault.body);
    }

    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let payload: string;
      try {
        payload = String(JSON.parse(raw).invoice ?? "");
      } catch {
        return refuse(400, [["ENV-001", 'the body must be {"invoice": "<base64>"}']]);
      }
      const xml = Buffer.from(payload, "base64").toString("utf8");
      const { problems, doc } = checkUbl(xml);

      // Across documents: a credit note must reverse something accepted, as it was.
      if (doc?.credit && doc.corrects) {
        const original = accepted.get(doc.corrects.uuid);
        if (!original) problems.push(["STA-003", "the credit note reverses an invoice that was never accepted"]);
        else {
          if (original.number !== doc.corrects.number) problems.push(["STA-004", "BillingReference number differs from the original"]);
          if (original.typeName !== doc.typeName) problems.push(["STA-007", `the credit note is ${doc.typeName}, the original ${original.typeName}`]);
        }
      }
      if (doc && accepted.has(doc.uuid)) {
        // A retry of a document already taken: ISTD answers, and does not file it twice.
        return send(200, {
          EINV_RESULTS: { status: "PASS", ERRORS: [], WARNINGS: [], INFO: [] },
          EINV_STATUS: "ALREADY_SUBMITTED",
          EINV_INV_UUID: doc.uuid,
          EINV_NUM: doc.number,
          EINV_QR: Buffer.from(`JOFOTARA|${doc.number}|${doc.uuid}`).toString("base64"),
        });
      }
      if (problems.length || !doc) return refuse(400, problems);

      accepted.set(doc.uuid, doc);
      lastXml = xml;
      lastSecret = String(secret);
      send(200, {
        EINV_RESULTS: { status: "PASS", ERRORS: [], WARNINGS: [], INFO: [] },
        EINV_STATUS: "SUBMITTED",
        EINV_INV_UUID: doc.uuid,
        EINV_NUM: doc.number,
        // The real one is a base64 TLV blob; its content is opaque to us and we
        // only ever print it, so any stable string exercises the same path.
        EINV_QR: Buffer.from(`JOFOTARA|${doc.number}|${doc.uuid}`).toString("base64"),
      });
    });
  });

  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

if (process.argv[1]?.includes("mock-jofotara")) {
  void startMockJofotara().then(() => console.log(`[mock-jofotara] listening on :${PORT}`));
}
