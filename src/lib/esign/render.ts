import { createHash } from "node:crypto";

/**
 * Turning a template into the exact thing somebody signs.
 *
 * Two rules govern this file:
 *
 * 1. The output is shown on a public page and printed by a headless browser, so
 *    the clinic-authored body is sanitized against an allowlist. Staff are
 *    trusted, but "trusted" is not a security boundary when the result is
 *    served to patients on the open internet.
 * 2. Merged values are escaped, never interpolated as markup. A patient whose
 *    name contains an angle bracket must not be able to change the document.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "hr", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "span", "div", "a", "section", "article", "figure", "figcaption", "small",
]);

/** Tags whose *content* is dropped along with the tag. */
const VOID_CONTENT = /<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "dir"]),
  td: new Set(["colspan", "rowspan", "style", "dir"]),
  th: new Set(["colspan", "rowspan", "style", "dir"]),
  "*": new Set(["dir", "style"]),
};

const ALLOWED_STYLE_PROPS = new Set([
  "text-align",
  "font-weight",
  "font-style",
  "text-decoration",
  "padding-inline-start",
  "margin-inline-start",
]);

function sanitizeStyle(value: string): string {
  const kept: string[] = [];
  for (const decl of value.split(";")) {
    const [rawProp, ...rest] = decl.split(":");
    if (!rawProp || rest.length === 0) continue;
    const prop = rawProp.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    // No url(), no expression(), no escapes that could reconstruct either.
    if (/[()\\]/.test(val)) continue;
    kept.push(`${prop}: ${val}`);
  }
  return kept.join("; ");
}

function sanitizeHref(value: string): string | null {
  const v = value.trim();
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  return null;
}

/**
 * Allowlist sanitizer. Disallowed tags lose their markup but keep their text —
 * dropping the text too would silently delete clauses from a consent form,
 * which is worse than showing them unstyled.
 */
export function sanitizeHtml(input: string): string {
  let html = String(input ?? "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(VOID_CONTENT, "");

  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_m, rawName: string, rawAttrs: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    const isClosing = _m.startsWith("</");
    if (isClosing) return `</${name}>`;

    const allowed = ALLOWED_ATTRS[name] ?? ALLOWED_ATTRS["*"];
    const attrs: string[] = [];
    for (const m of String(rawAttrs).matchAll(
      /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    )) {
      const attr = m[1].toLowerCase();
      if (!allowed.has(attr)) continue;
      let value = m[2] ?? m[3] ?? m[4] ?? "";
      if (attr === "href") {
        const safe = sanitizeHref(value);
        if (!safe) continue;
        value = safe;
      } else if (attr === "style") {
        value = sanitizeStyle(value);
        if (!value) continue;
      } else if (attr === "dir") {
        if (value !== "rtl" && value !== "ltr" && value !== "auto") continue;
      } else if (attr === "colspan" || attr === "rowspan") {
        if (!/^\d{1,2}$/.test(value)) continue;
      }
      attrs.push(`${attr}="${escapeHtml(value)}"`);
    }
    const selfClosing = name === "br" || name === "hr";
    return `<${name}${attrs.length ? " " + attrs.join(" ") : ""}${selfClosing ? " /" : ""}>`;
  });
}

export type MergeValue = { value: string; isOverride?: boolean };

/**
 * Replaces `{{token}}` with the frozen value.
 *
 * An unresolved token is rendered as a visible gap rather than an empty string:
 * silently vanishing is how a consent form ends up saying "I, , consent to".
 * Sending is blocked before this point anyway — this is the last line of defence.
 */
export function renderTokens(
  body: string,
  values: Map<string, MergeValue>,
  opts: { markOverrides?: boolean } = {}
): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const entry = values.get(key);
    if (!entry || !entry.value) {
      return `<span class="doc-missing" data-key="${escapeHtml(key)}">…</span>`;
    }
    const text = escapeHtml(entry.value);
    return opts.markOverrides && entry.isOverride
      ? `<span class="doc-override">${text}</span>`
      : text;
  });
}

/**
 * The frozen document: sanitized body, tokens already replaced, wrapped with the
 * clinic identity as it stood at that moment.
 *
 * The clinic's name and address are baked in rather than joined at render time
 * because the hash has to cover everything the signer was shown. A clinic that
 * renames itself next year must not change what this document says.
 */
export function buildSnapshot(args: {
  title: string;
  bodyHtml: string;
  clinicName: string;
  clinicAddress: string | null;
  clinicPhone: string | null;
  locale: "ar" | "en";
  /** One-off and overridden values, listed under the body so nothing is hidden. */
  extraFields?: { label: string; value: string }[];
}): string {
  const dir = args.locale === "ar" ? "rtl" : "ltr";
  const extras = (args.extraFields ?? []).filter((f) => f.value);
  const extrasHtml = extras.length
    ? `<section class="doc-extras"><table>${extras
        .map(
          (f) =>
            `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}</td></tr>`
        )
        .join("")}</table></section>`
    : "";

  return [
    `<article class="doc" dir="${dir}" lang="${args.locale}">`,
    `<header class="doc-head">`,
    `<div class="doc-clinic">${escapeHtml(args.clinicName)}</div>`,
    args.clinicAddress ? `<div class="doc-clinic-meta">${escapeHtml(args.clinicAddress)}</div>` : "",
    args.clinicPhone
      ? `<div class="doc-clinic-meta" dir="ltr">${escapeHtml(args.clinicPhone)}</div>`
      : "",
    `</header>`,
    `<h1 class="doc-title">${escapeHtml(args.title)}</h1>`,
    `<div class="doc-body">${args.bodyHtml}</div>`,
    extrasHtml,
    `</article>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** SHA-256 of the frozen document, hex. Recomputed and compared before every signature. */
export function documentHash(snapshot: string): string {
  return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

/** Short, readable form for the certificate page. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8).toUpperCase() + "…" + hash.slice(-8).toUpperCase();
}

/** Plain text, for WhatsApp previews and list summaries. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
