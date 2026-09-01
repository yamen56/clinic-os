import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import type { ExportedBatch, ExportedRecord } from "./patient-export";
import type { Dict } from "./i18n";

/**
 * The clinic's patients as a spreadsheet.
 *
 * The same `ExportedBatch` the printed record is built from, so the two
 * documents cannot say different things about the same clinic — the PDF is the
 * record a person reads, this is the one a person sorts.
 *
 * Six sheets rather than one wide one. A patient has many notes and many visits,
 * so flattening everything into a single row per patient would mean either
 * losing all but the most recent of each or producing a sheet with a hundred
 * near-empty columns. One row per thing, with the patient's name and id repeated
 * on every row, is what makes a pivot table possible — and a pivot table is the
 * only reason to want this in Excel rather than as the PDF that already exists.
 *
 * ## About the dates
 *
 * Written as `yyyy-MM-dd HH:mm` text in the clinic's own timezone, not as Excel
 * date values. Excel has no timezone: a real date cell is a bare number that the
 * reader's machine interprets, so a 09:00 appointment in Amman opens as 06:00
 * for a colleague whose laptop is set to London — silently, with no way to tell
 * from the file that it happened. The text form is unambiguous, sorts correctly
 * because the format is big-endian, and says the same thing on every machine.
 *
 * Money is written as a real number, because adding up a column of it is the
 * entire point, and money carries no timezone to lie about.
 */

/** A note body can be long, and Excel refuses a cell over 32,767 characters. */
const MAX_CELL = 32_000;

/**
 * How many records one spreadsheet may hold.
 *
 * Ten times the PDF's limit, and for a specific reason: `MAX_EXPORT_RECORDS` is
 * bounded by the 30-second Chromium render behind the printed version, and
 * nothing here goes near a browser. What bounds this instead is memory — the
 * whole batch is held at once — and the eight queries that load it.
 *
 * So a clinic too big to print is not too big to export, which is the case that
 * matters: the practice with four thousand files is exactly the one that needs
 * to get its data out and cannot.
 */
export const MAX_SHEET_RECORDS = 4000;

const clip = (s: string) => (s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s);

export function buildPatientWorkbook(batch: ExportedBatch, t: Dict): ExcelJS.Workbook {
  const tz = batch.clinic.timezone;
  const isAr = batch.clinic.locale === "ar";
  const clinicName = (isAr ? batch.clinic.nameAr : null) || batch.clinic.name;

  /** Clinic-local, big-endian, and the same string on every machine. */
  const at = (iso: string | null | undefined, dateOnly = false) => {
    if (!iso) return "";
    const d = DateTime.fromISO(iso, { zone: "utc" }).setZone(tz);
    if (!d.isValid) return "";
    return d.toFormat(dateOnly ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm");
  };
  /*
    A `date` column has no time and no zone, so shifting it into the clinic's
    timezone would move a birthday by a day for anybody born east of it. Taken
    as the calendar date it is, and never converted.

    Both shapes have to be handled. `loadPatientExportBatch` stringifies whatever
    node-pg returns, and for a `date` that is a JS Date — whose `String()` is
    "Tue Apr 17 1990 00:00:00 GMT+0300", not an ISO date. Slicing ten characters
    off that yields "Tue Apr 17", which is how this first shipped and what the
    suite caught.
  */
  const plainDate = (v: string | null | undefined) => {
    if (!v) return "";
    const s = String(v);
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    // Local getters, because that Date was built at local midnight for this
    // calendar day; reading it in UTC would walk it back a day west of Greenwich.
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };

  const money = (v: string | null | undefined) => (v == null ? null : Number(v));
  const label = (group: Record<string, string>, key: string) => group[key] ?? key;
  // Patients keep their three states as separate keys rather than a group, so
  // the map is assembled here instead of being reached for.
  const patientStatus: Record<string, string> = {
    lead: t.patients.statusLead,
    active: t.patients.statusActive,
    archived: t.patients.statusArchived,
  };
  const genders: Record<string, string> = { male: t.patients.male, female: t.patients.female };

  const wb = new ExcelJS.Workbook();
  wb.creator = clinicName;
  wb.created = new Date(batch.generatedAt);

  /*
    Every clinic can rename its own fields and add its own, so the extra columns
    are the union of whatever the records actually carry, in first-seen order.
    Reading them off the records rather than the definitions means a value on a
    file whose definition was later retired still leaves with the patient.
  */
  const customLabels: string[] = [];
  for (const r of batch.records) {
    for (const f of r.patient.customFields) {
      if (!customLabels.includes(f.label)) customLabels.push(f.label);
    }
  }

  /** Header row, frozen, filterable, bold — the three things a list needs. */
  const sheetOf = (name: string, headers: string[]) => {
    const ws = wb.addWorksheet(name.slice(0, 31), {
      views: [{ state: "frozen", ySplit: 1, rightToLeft: isAr }],
    });
    ws.addRow(headers);
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.alignment = { vertical: "middle" };
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: Math.max(1, headers.length) },
    };
    return ws;
  };

  /*
    Widths from the header and the first few hundred rows rather than from every
    row: the point is a column somebody can read without dragging it, and a
    single very long note must not make one column a thousand characters wide.
  */
  const fitColumns = (ws: ExcelJS.Worksheet) => {
    ws.columns.forEach((col) => {
      let width = 10;
      let seen = 0;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        if (seen++ > 300) return;
        const len = String(cell.value ?? "").length;
        if (len > width) width = len;
      });
      col.width = Math.min(Math.max(width + 2, 10), 48);
    });
  };

  const E = t.patientSheet;
  const who = (r: ExportedRecord) => [r.patient.fullName, r.patient.id];

  /* ------------------------------------------------------------- patients */
  const patients = sheetOf(E.sheetPatients, [
    E.name,
    E.id,
    E.phone,
    E.secondPhone,
    E.otherPhones,
    E.birthDate,
    E.age,
    E.gender,
    E.status,
    E.source,
    E.tags,
    E.insurer,
    E.policyNo,
    E.policyUntil,
    E.mutedFromAutomations,
    E.lastVisit,
    E.registered,
    E.notesCount,
    E.visitsCount,
    E.invoicesCount,
    E.billed,
    E.paid,
    E.outstanding,
    ...customLabels,
  ]);

  for (const r of batch.records) {
    const p = r.patient;
    const billed = r.invoices.reduce((s, i) => s + Number(i.total), 0);
    const paid = r.invoices.reduce((s, i) => s + Number(i.amountPaid), 0);
    const custom = new Map(p.customFields.map((f) => [f.label, f.value]));
    /*
      Age from the birth date rather than stored: it is the number staff actually
      read, and a stored one is wrong within a year of being written.
    */
    const born = plainDate(p.birthDate);
    const age = born ? Math.floor(DateTime.fromISO(born).diffNow("years").years * -1) : null;

    patients.addRow([
      p.fullName,
      p.id,
      p.phone ?? "",
      p.secondaryPhone ?? "",
      (p.extraPhones ?? []).join(", "),
      born,
      Number.isFinite(age as number) && (age as number) >= 0 ? age : null,
      p.gender ? label(genders, p.gender) : "",
      label(patientStatus, p.status),
      label(t.patients.sources as unknown as Record<string, string>, p.source),
      (p.tags ?? []).join(", "),
      p.insurer ?? "",
      p.insuranceNo ?? "",
      plainDate(p.insuranceValidUntil),
      p.automationOptOut ? E.yes : E.no,
      at(p.lastVisitAt),
      at(p.createdAt),
      r.notes.length,
      r.appointments.length,
      r.invoices.length,
      billed,
      paid,
      billed - paid,
      ...customLabels.map((l) => custom.get(l) ?? ""),
    ]);
  }

  /* ---------------------------------------------------------------- notes */
  const notes = sheetOf(E.sheetNotes, [
    E.name,
    E.patientId,
    E.date,
    E.category,
    E.author,
    E.note,
    E.edited,
    E.voiceNote,
  ]);
  for (const r of batch.records) {
    for (const n of r.notes) {
      notes.addRow([
        ...who(r),
        at(n.createdAt),
        n.category ?? "",
        n.author ?? "",
        clip(n.body ?? ""),
        n.editedAt ? at(n.editedAt) : "",
        // A recording cannot go in a cell; the row says one exists and how long.
        n.hasAudio ? `${E.yes}${n.audioSeconds ? ` (${n.audioSeconds}s)` : ""}` : E.no,
      ]);
    }
  }

  /* --------------------------------------------------------- appointments */
  const visits = sheetOf(E.sheetAppointments, [
    E.name,
    E.patientId,
    E.date,
    E.service,
    E.doctor,
    E.status,
  ]);
  for (const r of batch.records) {
    for (const a of r.appointments) {
      visits.addRow([
        ...who(r),
        at(a.startsAt),
        a.service ?? "",
        a.doctor ?? "",
        label(t.calendar.statuses as unknown as Record<string, string>, a.status),
      ]);
    }
  }

  /* ------------------------------------------------------------- invoices */
  const invoices = sheetOf(E.sheetInvoices, [
    E.name,
    E.patientId,
    E.invoiceNo,
    E.date,
    E.status,
    E.total,
    E.paid,
    E.outstanding,
  ]);
  for (const r of batch.records) {
    for (const i of r.invoices) {
      const total = money(i.total) ?? 0;
      const paid = money(i.amountPaid) ?? 0;
      invoices.addRow([
        ...who(r),
        i.number,
        plainDate(i.issueDate),
        label(t.invoices.statuses as unknown as Record<string, string>, i.status),
        total,
        paid,
        total - paid,
      ]);
    }
  }
  // Two decimals, so a column of money reads as money rather than as 12.300000001.
  for (const col of [6, 7, 8]) invoices.getColumn(col).numFmt = "0.00";
  for (const col of [21, 22, 23]) patients.getColumn(col).numFmt = "0.00";

  /* ------------------------------------------------------ documents/files */
  const documents = sheetOf(E.sheetDocuments, [E.name, E.patientId, E.title, E.status, E.date]);
  for (const r of batch.records) {
    for (const d of r.documents) {
      documents.addRow([
        ...who(r),
        d.title,
        label(t.docs.statuses as unknown as Record<string, string>, d.status),
        at(d.createdAt),
      ]);
    }
  }

  const files = sheetOf(E.sheetFiles, [E.name, E.patientId, E.fileName, E.date]);
  for (const r of batch.records) {
    for (const f of r.files) {
      files.addRow([...who(r), f.fileName, at(f.createdAt)]);
    }
  }

  for (const ws of [patients, notes, visits, invoices, documents, files]) fitColumns(ws);
  return wb;
}
