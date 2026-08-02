import {
  normalizePhone,
  e164ToJid,
  jidToE164,
  splitE164,
  joinE164,
  countryFromClinic,
} from "../src/lib/phone";

let pass = 0;
let fail = 0;

function eq(input: string, expected: string | null, country: "JO" | "SA" | "AE" = "JO") {
  const got = normalizePhone(input, country);
  if (got === expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL normalize(${JSON.stringify(input)}, ${country}) = ${got}, expected ${expected}`);
  }
}

// Jordan — the four canonical forms from the spec
eq("0790744070", "+962790744070");
eq("790744070", "+962790744070");
eq("+962790744070", "+962790744070");
eq("962790744070", "+962790744070");
// Jordan variants
eq("07 9074 4070", "+962790744070");
eq("079-074-4070", "+962790744070");
eq("00962790744070", "+962790744070");
eq("+962 79 074 4070", "+962790744070");
eq("9620790744070", "+962790744070"); // kept trunk zero after CC
eq("٠٧٩٠٧٤٤٠٧٠", "+962790744070"); // Arabic-Indic digits
eq("0770123456", "+962770123456");
eq("0781234567", "+962781234567");
eq("064616161", "+96264616161"); // Amman landline

// Saudi
eq("0501234567", "+966501234567", "SA");
eq("501234567", "+966501234567", "SA");
eq("+966501234567", "+966501234567", "SA");
eq("966501234567", "+966501234567", "SA");
eq("00966501234567", "+966501234567", "SA");
eq("٠٥٠١٢٣٤٥٦٧", "+966501234567", "SA");

// UAE
eq("0501234567", "+971501234567", "AE");
eq("501234567", "+971501234567", "AE");
eq("+971501234567", "+971501234567", "AE");
eq("971501234567", "+971501234567", "AE");
eq("00971501234567", "+971501234567", "AE");

// Saudi/UAE numbers typed in a Jordanian clinic default to SA
eq("0501234567", "+966501234567", "JO");

// Full international forms resolve regardless of clinic country
eq("+971501234567", "+971501234567", "JO");
eq("966501234567", "+966501234567", "JO");

// Foreign E.164 passes through
eq("+14155552671", "+14155552671");

// Garbage rejected
eq("", null);
eq("abc", null);
eq("123", null);
eq("079074", null);

// JID round-trip
const jid = e164ToJid("+962790744070");
if (jid === "962790744070@s.whatsapp.net" && jidToE164(jid) === "+962790744070") {
  pass++;
} else {
  fail++;
  console.error(`FAIL jid round-trip: ${jid}`);
}

/* ------------------------------------------- the countries added for the picker */

// Each has to survive the country-code scan without a shorter code shadowing it.
eq("+201012345678", "+201012345678"); // Egypt, 10-digit national
eq("+96550123456", "+96550123456"); // Kuwait, 8
eq("+97433123456", "+97433123456"); // Qatar, 8
eq("+96170123456", "+96170123456"); // Lebanon, 8
eq("+970599123456", "+970599123456"); // Palestine, 9
eq("+9647701234567", "+9647701234567"); // Iraq, 10
eq("+905551234567", "+905551234567"); // Türkiye, 10 — cc "90" must not eat a "9…" number
eq("+12125551234", "+12125551234"); // US, 10 — cc "1" is the shortest and greediest

/* ------------------------------------------------ splitting and rejoining */

function split(e164: string, country: string, national: string) {
  const got = splitE164(e164);
  if (got.country === country && got.national === national) pass++;
  else {
    fail++;
    console.error(`FAIL splitE164(${e164}) = ${JSON.stringify(got)}, expected ${country}/${national}`);
  }
}
split("+962790744070", "JO", "790744070");
split("+966501234567", "SA", "501234567");
split("+201012345678", "EG", "1012345678");
split("+12125551234", "US", "2125551234");
// A number the picker cannot place still shows something rather than nothing.
split("+9991234567", "JO", "9991234567");

function join(country: string, national: string, expected: string | null) {
  const got = joinE164(country as never, national);
  if (got === expected) pass++;
  else {
    fail++;
    console.error(`FAIL joinE164(${country}, ${national}) = ${got}, expected ${expected}`);
  }
}
join("JO", "790744070", "+962790744070");
join("JO", "0790744070", "+962790744070"); // trunk zero typed out of habit
join("JO", "٠٧٩٠٧٤٤٠٧٠", "+962790744070"); // Arabic-Indic digits
join("JO", "079 074 4070", "+962790744070"); // spacing
join("SA", "0501234567", "+966501234567");
join("JO", "12345", null); // too short to be anything
join("JO", "", null);

/* -------------------------------------------- the clinic's default country */

function clinic(tz: string | null, currency: string | null, expected: string) {
  const got = countryFromClinic({ timezone: tz, currency });
  if (got === expected) pass++;
  else {
    fail++;
    console.error(`FAIL countryFromClinic(${tz}, ${currency}) = ${got}, expected ${expected}`);
  }
}
clinic("Asia/Amman", "JOD", "JO");
clinic("Asia/Riyadh", "SAR", "SA");
clinic("Asia/Dubai", "AED", "AE");
// Timezone wins: a clinic in Amman that prices in dollars is still in Jordan.
clinic("Asia/Amman", "USD", "JO");
clinic(null, "EGP", "EG");
clinic(null, null, "JO");

console.log(`phone tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
