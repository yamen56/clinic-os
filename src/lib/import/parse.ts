/**
 * Reading whatever a clinic actually sends.
 *
 * There is no knowing in advance what shape their old records take — an export
 * from another system, a spreadsheet somebody has kept for nine years, a list
 * typed by a receptionist. So nothing here assumes a schema. It reads a
 * delimited file, works out its encoding and delimiter, and hands back the
 * headers for a human to map. The mapping is the part that cannot be guessed
 * reliably, so it is asked rather than assumed — the guessing below only
 * pre-selects, and every guess is overridable.
 */

/** Columns the platform can fill from an import. */
export type ImportField =
  | "full_name"
  /*
    A list split across two columns is as common as one that is not — every
    system that ever asked for a title exports "First name" and "Last name"
    separately. Mapped as their own fields and joined when the row is read, so
    the operator does not have to merge the columns in Excel first, which is the
    step at which somebody gives up.
  */
  | "first_name"
  | "last_name"
  | "phone"
  | "secondary_phone"
  | "birth_date"
  | "gender"
  | "notes"
  | "tags"
  | "insurance_no"
  | "ignore";

/**
 * Decodes an uploaded file.
 *
 * Excel on an Arabic Windows machine saves "CSV" in windows-1256, not UTF-8 —
 * the single most likely file to arrive, and the one that turns every name into
 * mojibake if read as UTF-8. Detection is by BOM first, then by whether a strict
 * UTF-8 read succeeds; only then does it fall back.
 */
export function decodeUpload(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    // `fatal` is the whole point: a windows-1256 file is usually *valid-looking*
    // UTF-8 nonsense otherwise, and would decode silently into rubbish.
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1256").decode(buf);
  }
}

/**
 * Picks the delimiter by counting candidates in the header line.
 *
 * Tab first, because pasting straight out of Excel produces tab-separated text
 * and that is the path that avoids file encoding entirely. Semicolon is included
 * because Excel uses it wherever the list separator is not a comma.
 */
function sniffDelimiter(firstLine: string): string {
  const counts = [
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    [",", (firstLine.match(/,/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
  ] as [string, number][];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * A delimited parser that honours quotes, because names contain commas.
 *
 * Deliberately hand-written rather than pulled in: the format is small, the
 * rules are RFC 4180, and a dependency here would be a supply-chain risk taken
 * on for about forty lines.
 */
export function parseDelimited(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!clean) return { headers: [], rows: [] };
  /*
    Sniffed from the widest of the first few lines rather than from the first.
    A sheet that opens with a title — "Patient list 2024" alone in A1 — has no
    delimiter at all on line one, and guessing comma there would read a
    semicolon-separated file as a single column.
  */
  const delim = sniffDelimiter(
    clean
      .split("\n", 5)
      .reduce((best, line) => (countDelims(line) > countDelims(best) ? line : best), "")
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  // A trailing delimiter, or a blank line anywhere, is not a record.
  const filled = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  const head = headerRowIndex(filled);
  const headers = (filled[head] ?? []).map((h) => h.trim());
  return { headers, rows: filled.slice(head + 1) };
}

/** How many of the candidate delimiters a line carries. Used to pick a header. */
function countDelims(line: string): number {
  return (line.match(/[\t,;]/g) ?? []).length;
}

/**
 * Which row is the header.
 *
 * Almost always the first, and that is what this returns unless the file opens
 * with something narrower — a report title, a clinic name, an export timestamp
 * — which spreadsheets put above the table often enough to matter. Taking such a
 * line as the header names every column after the first "" and maps the whole
 * file to `ignore`, which looks to the operator like the importer cannot read
 * their file at all.
 *
 * Conservative on purpose: a row only loses to the one below it when it has
 * fewer than half as many filled cells, so an ordinary sheet whose last column
 * is blank in the header is untouched. Only the first few rows are considered,
 * because a header is never buried deep.
 */
function headerRowIndex(rows: string[][]): number {
  const filledCells = (r: string[]) => r.filter((c) => c.trim() !== "").length;
  const limit = Math.min(rows.length - 1, 4);
  let i = 0;
  while (i < limit && filledCells(rows[i]) * 2 < filledCells(rows[i + 1])) i++;
  return i;
}

/*
  Header names we have seen or would expect, in both languages. This only
  pre-selects the dropdowns — being wrong costs a click, so the list errs
  towards guessing rather than leaving everything blank.
*/
const GUESSES: [ImportField, RegExp][] = [
  ["full_name", /^(full[\s_-]?name|name|patient([\s_-]?name)?|الاسم|اسم|اسم المريض|الاسم الكامل)$/i],
  ["first_name", /^(first[\s_-]?name|given[\s_-]?name|fname|الاسم الأول|الاسم الاول|الاسم ?1)$/i],
  ["last_name", /^(last[\s_-]?name|surname|family[\s_-]?name|lname|اسم العائلة|العائلة|الكنية|اللقب)$/i],
  ["phone", /^(phone|mobile|cell|tel|telephone|whatsapp|هاتف|جوال|موبايل|تلفون|رقم|الهاتف|الجوال)$/i],
  ["secondary_phone", /^(phone ?2|second(ary)? ?phone|alt ?phone|هاتف ?2|هاتف اخر|هاتف آخر)$/i],
  ["birth_date", /^(birth|dob|date ?of ?birth|birth ?date|تاريخ الميلاد|الميلاد|المواليد)$/i],
  ["gender", /^(gender|sex|الجنس|النوع)$/i],
  ["notes", /^(notes?|comment|remarks|ملاحظات|ملاحظة|تعليق)$/i],
  ["tags", /^(tags?|labels?|category|وسوم|تصنيف|فئة)$/i],
  ["insurance_no", /^(insurance|policy|insurance ?no|رقم التأمين|التأمين|البوليصة)$/i],
];

/** Pre-selects a field per column. Every choice is the operator's to override. */
/**
 * The forms of a header worth testing against the patterns above.
 *
 * Arabic headers arrive with and without the definite article — one clinic
 * writes "ملاحظات", the next writes "الملاحظات" — and listing both spellings of
 * every word would be a table nobody keeps up to date. The bare form is tried
 * alongside the written one, so "ال" costs nothing.
 *
 * A trailing colon and a bracketed aside come off too, because "Phone (mobile):"
 * is how a person writes a header and not how a matcher expects one.
 */
function headerForms(raw: string): string[] {
  const base = raw
    .trim()
    .replace(/[:\uFF1A]\s*$/, "")
    .replace(/\s*[([][^)\]]*[)\]]\s*$/, "")
    .trim();
  const forms = [base];
  if (/^ال\p{L}/u.test(base)) forms.push(base.slice(2));
  return forms;
}

export function guessMapping(headers: string[]): ImportField[] {
  // A sheet carrying both a full name and its parts means the full one; mapping
  // all three would append the surname to a name that already ends in it.
  const hasFull = headers.some((h) => headerForms(h).some((f) => GUESSES[0][1].test(f)));
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const forms = headerForms(h);
    for (const [field, re] of GUESSES) {
      if (hasFull && (field === "first_name" || field === "last_name")) continue;
      // One column per field: a sheet with "Phone" and "Phone 2" must not map
      // both onto `phone` and silently drop one.
      if (!used.has(field) && forms.some((f) => re.test(f))) {
        used.add(field);
        return field;
      }
    }
    return "ignore" as ImportField;
  });
}

/** Normalises the free-text gender column into what `patients.gender` allows. */
export function readGender(raw: string): "male" | "female" | null {
  const v = raw.trim().toLowerCase();
  if (/^(m|male|ذكر|ذ)$/.test(v)) return "male";
  if (/^(f|female|أنثى|انثى|ا?نثى|ث)$/.test(v)) return "female";
  return null;
}

/**
 * Reads a date without imposing one country's order on another's file.
 *
 * ISO is taken as written. Anything else is ambiguous — 03/04/2026 is March in
 * one convention and April in another — so a day greater than twelve is used as
 * proof of day-first, and where there is no proof the file is assumed to be
 * day-first, which is what Jordan writes.
 */
export function readDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const parts = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!parts) return null;
  let [, a, b, y] = parts;
  if (y.length === 2) y = Number(y) > 40 ? `19${y}` : `20${y}`;
  const first = Number(a);
  const second = Number(b);
  const [day, month] = second > 12 ? [second, first] : [first, second];
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
