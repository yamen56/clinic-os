/**
 * A stand-in for JoFotara, so QA can exercise the whole submission path without
 * touching the Jordanian tax authority.
 *
 * This is not a convenience. Filing an invoice with ISTD is a real, recorded,
 * irreversible act — a test that reached the live endpoint would put fictional
 * patients into a clinic's tax return, and the only way back from that is a
 * credit note. `JOFOTARA_BASE_URL` points at this instead, and the real host is
 * never in a test's reach.
 *
 * It validates rather than just answering: the credentials have to be present,
 * the payload has to be base64 of parseable UBL, and the totals in the document
 * have to add up. Those are the checks ISTD actually performs, and a mock that
 * accepts anything would let exactly the bugs that matter through.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_JOFOTARA_PORT || 4111);

/** Set by a test to make the next N submissions fail in a particular way. */
type Fault = { status: number; body: string; times: number } | null;
let fault: Fault = null;

function num(xml: string, tag: string): number {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([-0-9.]+)</${tag}>`));
  return m ? Number(m[1]) : NaN;
}

function all(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

export function validateUbl(xml: string): string | null {
  if (!xml.startsWith("<?xml")) return "not xml";
  for (const required of ["cbc:ID", "cbc:UUID", "cbc:IssueDate", "cbc:InvoiceTypeCode"]) {
    if (!xml.includes(`<${required}`)) return `missing ${required}`;
  }
  const lines = all(xml, "cac:InvoiceLine");
  if (!lines.length) return "no invoice lines";

  // The check that matters: the header must be the sum of the lines.
  const lineNet = lines.reduce((s, l) => s + num(l, "cbc:LineExtensionAmount"), 0);
  const lineTax = lines.reduce((s, l) => {
    const t = l.match(/<cac:TaxTotal>[\s\S]*?<cbc:TaxAmount[^>]*>([-0-9.]+)</);
    return s + (t ? Number(t[1]) : 0);
  }, 0);
  const totals = xml.match(/<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/)?.[0] ?? "";
  const exclusive = num(totals, "cbc:TaxExclusiveAmount");
  const inclusive = num(totals, "cbc:TaxInclusiveAmount");

  if (Math.abs(lineNet - exclusive) > 0.0005) {
    return `lines sum to ${lineNet.toFixed(3)} but TaxExclusiveAmount is ${exclusive.toFixed(3)}`;
  }
  if (Math.abs(lineNet + lineTax - inclusive) > 0.0005) {
    return `net + tax is ${(lineNet + lineTax).toFixed(3)} but TaxInclusiveAmount is ${inclusive.toFixed(3)}`;
  }
  if (/<cbc:InvoicedQuantity[^>]*>-/.test(xml) || /<cbc:PriceAmount[^>]*>-/.test(xml)) {
    return "negative quantity or price";
  }
  return null;
}

export function startMockJofotara(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    };

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

    if (!req.url?.startsWith("/core/invoices")) return send(404, { error: "not_found" });

    const clientId = req.headers["client-id"];
    const secret = req.headers["secret-key"];
    if (!clientId || !secret) {
      return send(401, { EINV_RESULTS: { ERRORS: [{ EINV_MESSAGE: "missing credentials" }] } });
    }

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
        return send(400, { EINV_RESULTS: { ERRORS: [{ EINV_MESSAGE: "bad json" }] } });
      }
      const xml = Buffer.from(payload, "base64").toString("utf8");
      const problem = validateUbl(xml);
      if (problem) {
        return send(400, { EINV_RESULTS: { ERRORS: [{ EINV_MESSAGE: problem }] } });
      }
      const uuid = xml.match(/<cbc:UUID>([^<]+)<\/cbc:UUID>/)?.[1] ?? "";
      const id = xml.match(/<cbc:ID>([^<]+)<\/cbc:ID>/)?.[1] ?? "";
      send(200, {
        EINV_RESULTS: { STATUS: "SUBMITTED" },
        EINV_INV_UUID: uuid,
        EINV_NUM: id,
        // The real one is a base64 TLV blob; its content is opaque to us and we
        // only ever print it, so any stable string exercises the same path.
        EINV_QR: Buffer.from(`JOFOTARA|${id}|${uuid}`).toString("base64"),
      });
    });
  });

  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

if (process.argv[1]?.includes("mock-jofotara")) {
  void startMockJofotara().then(() => console.log(`[mock-jofotara] listening on :${PORT}`));
}
