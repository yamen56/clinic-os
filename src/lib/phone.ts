/**
 * Phone normalization to E.164 — the single source of patient identity.
 * Handles Jordanian, Saudi, and Emirati formats plus Arabic-Indic digits.
 */

export type CountryCode = "JO" | "SA" | "AE";

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

/** Country dialing metadata: cc → mobile subscriber length + local prefixes. */
const COUNTRIES = {
  JO: { cc: "962", subLen: 9, mobileStart: /^7[789]/ },
  SA: { cc: "966", subLen: 9, mobileStart: /^5/ },
  AE: { cc: "971", subLen: 9, mobileStart: /^5/ },
} as const;

/**
 * Normalizes any input to E.164 (+9627..., +9665..., +9715...).
 * Returns null when the input cannot be interpreted as a valid number.
 *
 * defaultCountry resolves ambiguous local formats (05… exists in both SA and AE).
 */
export function normalizePhone(raw: string, defaultCountry: CountryCode = "JO"): string | null {
  if (!raw) return null;
  let s = toAsciiDigits(raw.trim());
  // Keep a leading +, drop everything else that isn't a digit
  const hadPlus = /^\s*\+/.test(s);
  s = s.replace(/\D/g, "");
  if (!s) return null;

  if (!hadPlus && s.startsWith("00")) s = s.slice(2);

  // Already has a known country code?
  for (const { cc, subLen } of Object.values(COUNTRIES)) {
    if (s.startsWith(cc)) {
      let rest = s.slice(cc.length);
      // e.g. 9620790744070 — some people keep the trunk 0 after the CC
      if (rest.length === subLen + 1 && rest.startsWith("0")) rest = rest.slice(1);
      if (rest.length === subLen) return `+${cc}${rest}`;
    }
  }

  if (hadPlus) {
    // Foreign but plausible E.164 — accept as-is
    return s.length >= 8 && s.length <= 15 ? `+${s}` : null;
  }

  // Local formats
  const jo = COUNTRIES.JO;
  if (/^07[789]\d{7}$/.test(s)) return `+${jo.cc}${s.slice(1)}`; // 0790744070
  if (/^7[789]\d{7}$/.test(s)) return `+${jo.cc}${s}`; // 790744070

  if (/^05\d{8}$/.test(s)) {
    const c = defaultCountry === "AE" ? COUNTRIES.AE : COUNTRIES.SA;
    return `+${c.cc}${s.slice(1)}`;
  }
  if (/^5\d{8}$/.test(s)) {
    const c = defaultCountry === "AE" ? COUNTRIES.AE : COUNTRIES.SA;
    return `+${c.cc}${s}`;
  }

  // Jordanian landlines 0X XXXXXXX (area codes 2,3,5,6)
  if (/^0[2356]\d{7}$/.test(s) && defaultCountry === "JO") return `+${jo.cc}${s.slice(1)}`;

  return null;
}

/** True when the string is already a plausible E.164 number. */
export function isE164(s: string | null | undefined): s is string {
  return !!s && /^\+\d{8,15}$/.test(s);
}

/** Display format: +962 79 074 4070 style grouping. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = e164.match(/^\+(962|966|971)(\d)(\d{2})(\d{3})(\d{3,4})$/);
  if (m) return `+${m[1]} ${m[2]}${m[3]} ${m[4]} ${m[5]}`;
  return e164;
}

/** WhatsApp JID for an E.164 number. */
export function e164ToJid(e164: string): string {
  return `${e164.replace(/^\+/, "")}@s.whatsapp.net`;
}

/** E.164 from a WhatsApp JID (5-30 digit user part). */
export function jidToE164(jid: string): string | null {
  const m = jid.match(/^(\d{7,15})@/);
  return m ? `+${m[1]}` : null;
}
