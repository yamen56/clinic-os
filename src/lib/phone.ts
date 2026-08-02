/**
 * Phone normalization to E.164 — the single source of patient identity.
 * Handles Jordanian, Saudi, and Emirati formats plus Arabic-Indic digits.
 */

export type CountryCode = keyof typeof COUNTRIES;

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] ?? d);
}

/**
 * Country dialling metadata.
 *
 * `subLen` is the national number's length once the trunk zero is stripped, and
 * it is what tells a country code apart from the start of a local number.
 *
 * The first three carry the existing rules exactly — they are load-bearing for
 * patient identity and WhatsApp, and every case in test-phone.ts still holds.
 * The rest are the countries a Jordanian clinic's patients actually come from,
 * added so a number can be entered without the caller knowing E.164.
 *
 * Ordering matters twice over: the picker shows them in this order, and the
 * country-code scan below takes the first match, so longer codes must not be
 * shadowed by shorter ones. None of these are prefixes of each other.
 */
const COUNTRIES = {
  JO: { cc: "962", subLen: 9, name: "Jordan", nameAr: "الأردن", flag: "🇯🇴" },
  SA: { cc: "966", subLen: 9, name: "Saudi Arabia", nameAr: "السعودية", flag: "🇸🇦" },
  AE: { cc: "971", subLen: 9, name: "UAE", nameAr: "الإمارات", flag: "🇦🇪" },
  PS: { cc: "970", subLen: 9, name: "Palestine", nameAr: "فلسطين", flag: "🇵🇸" },
  EG: { cc: "20", subLen: 10, name: "Egypt", nameAr: "مصر", flag: "🇪🇬" },
  KW: { cc: "965", subLen: 8, name: "Kuwait", nameAr: "الكويت", flag: "🇰🇼" },
  QA: { cc: "974", subLen: 8, name: "Qatar", nameAr: "قطر", flag: "🇶🇦" },
  BH: { cc: "973", subLen: 8, name: "Bahrain", nameAr: "البحرين", flag: "🇧🇭" },
  OM: { cc: "968", subLen: 8, name: "Oman", nameAr: "عُمان", flag: "🇴🇲" },
  LB: { cc: "961", subLen: 8, name: "Lebanon", nameAr: "لبنان", flag: "🇱🇧" },
  IQ: { cc: "964", subLen: 10, name: "Iraq", nameAr: "العراق", flag: "🇮🇶" },
  SY: { cc: "963", subLen: 9, name: "Syria", nameAr: "سوريا", flag: "🇸🇾" },
  TR: { cc: "90", subLen: 10, name: "Türkiye", nameAr: "تركيا", flag: "🇹🇷" },
  GB: { cc: "44", subLen: 10, name: "United Kingdom", nameAr: "بريطانيا", flag: "🇬🇧" },
  US: { cc: "1", subLen: 10, name: "United States", nameAr: "أمريكا", flag: "🇺🇸" },
} as const;

export const COUNTRY_LIST = (Object.keys(COUNTRIES) as CountryCode[]).map((code) => ({
  code,
  ...COUNTRIES[code],
}));

/** The dialling code for a country, without the plus. */
export function dialCode(country: CountryCode): string {
  return COUNTRIES[country].cc;
}

/**
 * Splits an E.164 number into the country it belongs to and the rest.
 *
 * Used by the phone input, which shows the country as a separate control so
 * nobody has to know that +962 means Jordan. Falls back to the given default
 * when the number is foreign or absent, so the field always has a country
 * selected rather than starting blank.
 */
export function splitE164(
  e164: string | null | undefined,
  fallback: CountryCode = "JO"
): { country: CountryCode; national: string } {
  if (!e164 || !e164.startsWith("+")) return { country: fallback, national: "" };
  const digits = e164.slice(1);
  // Longest code first, so +1 never claims a +962 number.
  const ordered = (Object.keys(COUNTRIES) as CountryCode[]).sort(
    (a, b) => COUNTRIES[b].cc.length - COUNTRIES[a].cc.length
  );
  for (const code of ordered) {
    const { cc, subLen } = COUNTRIES[code];
    if (digits.startsWith(cc) && digits.length - cc.length === subLen) {
      return { country: code, national: digits.slice(cc.length) };
    }
  }
  return { country: fallback, national: digits };
}

/** Builds E.164 from a country and whatever the user typed as the local part. */
export function joinE164(country: CountryCode, national: string): string | null {
  const digits = toAsciiDigits(national).replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return null;
  const { cc, subLen } = COUNTRIES[country];
  if (digits.length !== subLen) return null;
  return `+${cc}${digits}`;
}

/** The clinic's country, inferred from what the clinic record already knows. */
export function countryFromClinic(opts: {
  timezone?: string | null;
  currency?: string | null;
}): CountryCode {
  const byCurrency: Record<string, CountryCode> = {
    JOD: "JO", SAR: "SA", AED: "AE", EGP: "EG", KWD: "KW",
    QAR: "QA", BHD: "BH", OMR: "OM", ILS: "PS", IQD: "IQ", TRY: "TR",
  };
  const byZone: Record<string, CountryCode> = {
    "Asia/Amman": "JO", "Asia/Riyadh": "SA", "Asia/Dubai": "AE",
    "Africa/Cairo": "EG", "Asia/Kuwait": "KW", "Asia/Qatar": "QA",
    "Asia/Bahrain": "BH", "Asia/Muscat": "OM", "Asia/Hebron": "PS",
    "Asia/Gaza": "PS", "Asia/Baghdad": "IQ", "Asia/Beirut": "LB",
    "Asia/Damascus": "SY", "Europe/Istanbul": "TR",
  };
  // Timezone is the stronger signal: a clinic may bill in dollars and sit in Amman.
  return byZone[opts.timezone ?? ""] ?? byCurrency[opts.currency ?? ""] ?? "JO";
}

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
  const m = e164.match(/^\+(962|966|971)(\d{2})(\d{3})(\d{4})$/);
  if (m) return `+${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
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
