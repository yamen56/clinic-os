import { normalizePhone, e164ToJid, jidToE164 } from "../src/lib/phone";

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

console.log(`phone tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
