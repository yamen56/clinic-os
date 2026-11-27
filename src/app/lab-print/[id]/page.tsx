import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { withSystem } from "@/lib/db";
import { verifyPrintKeyFor } from "@/lib/print-token";
import { fmtDateOnly } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { dictFor } from "@/lib/i18n/client-dict";
import { orderRef, toLabCase, tripsOf } from "@/lib/charts/dental/labs";
import { orderRows } from "@/lib/charts/dental/lab-message";
import { PRINT_KIND } from "@/lib/charts/dental/lab-order";
import { PERMANENT_UPPER, PERMANENT_LOWER } from "@/lib/charts/dental/teeth";
import { PoweredBy } from "@/components/powered-by";
import { whiteLabelSql } from "@/lib/white-label";

export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = [PRINT_KIND] as const;

/**
 * The page a lab order's PDF is made of (lab-order.ts).
 *
 * What a lab works from: who it is for, which teeth and what each is, what it
 * is made of, the shade, what is to come back and by when — on a chart of the
 * mouth with the work's teeth marked, as a lab slip has it. English, like the
 * chart and the lab's own words; the patient's name as the clinic wrote it.
 * Nothing else of the patient: no phone number, no medical history, no money.
 *
 * Reachable only by the renderer, with a key of minutes over the case.
 */
export default async function LabPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ exp?: string; sig?: string; kind?: string }>;
}) {
  const { id } = await params;
  const { exp, sig, kind = PRINT_KIND } = await searchParams;
  if (!verifyPrintKeyFor(id, kind, exp, sig, KINDS)) notFound();

  const r = await withSystem(async (c) => {
    const q = await c.query(
      `select lc.*, l.name as lab_name, l.in_house,
              p.full_name as patient_name,
              m.label, m.site, m.treatment_key, m.detail,
              coalesce(du.full_name, cu.full_name) as doctor_name, coalesce(dm.title, '') as doctor_title,
              cl.name as clinic_name, cl.slug, cl.logo_path, cl.brand_color, cl.address, cl.phone_e164 as clinic_phone,
              ${whiteLabelSql()} as white_label
         from lab_cases lc
         join dental_labs l on l.id = lc.lab_id
         join patients p on p.id = lc.patient_id
         join chart_marks m on m.id = lc.mark_id
         join clinics cl on cl.id = lc.clinic_id
         left join clinic_members dm on dm.id = m.performed_by
         left join users du on du.id = dm.user_id
         left join users cu on cu.id = lc.created_by
        where lc.id = $1`,
      [id]
    );
    return q.rows[0] as Record<string, unknown> | undefined;
  });
  if (!r) notFound();

  const T = dictFor("en").dental.lab;
  const S = T.sheet;
  const c = toLabCase(r);
  const site = r.site as string;
  const treatmentKey = r.treatment_key as string;
  const material = ((r.detail as Record<string, string> | null)?.material as string | undefined) ?? null;
  const rows = orderRows(c, { work: r.label as string, site, treatmentKey, material }, T.msg);
  const teeth = c.spec.teeth ?? [];
  const implants = new Set([...(c.spec.implants ?? []).map((i) => i.site), ...teeth.filter((x) => x.implant).map((x) => x.site)]);
  const arch = !/^[1-8][1-8]$/.test(site);
  const roleOf = new Map(teeth.map((x) => [x.site, arch ? "pontic" : x.role]));
  if (!teeth.length && !arch) roleOf.set(site, "abutment");
  const trips = tripsOf(c);
  const doctor = [r.doctor_title, r.doctor_name].filter(Boolean).join(" ");

  // One row of the mouth as the lab sees it, the patient's right on the left.
  const Row = ({ sites }: { sites: readonly string[] }) => (
    <div className="flex justify-center gap-[3px]">
      {sites.map((s, i) => {
        const role = roleOf.get(s);
        const implant = implants.has(s);
        return (
          <div key={s} className={`flex flex-col items-center ${i === 8 ? "ms-3" : ""}`}>
            <div
              className="grid h-9 w-9 place-items-center rounded-md border text-[0.8125rem] font-bold tnum"
              style={
                role === "abutment"
                  ? { background: "var(--bk)", borderColor: "var(--bk)", color: "#fff" }
                  : role === "pontic"
                    ? { background: "color-mix(in srgb, var(--bk) 12%, #fff)", borderColor: "var(--bk)", borderStyle: "dashed", color: "var(--bk)" }
                    : { borderColor: "#d5d9e0", color: "#9aa1ad" }
              }
              data-sheet-tooth={s}
              data-sheet-role={role ?? ""}
            >
              {s}
            </div>
            <div className="h-4 text-[0.625rem] font-bold leading-4" style={{ color: "var(--bk)" }}>
              {implant ? S.implantMark : ""}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <main dir="ltr" className="bg-white text-ink-900" style={{ "--bk": (r.brand_color as string) || "#0b1220" } as React.CSSProperties} data-lab-sheet={orderRef(id)}>
      <div className="mx-auto flex min-h-[285mm] w-full max-w-[210mm] flex-col bg-white">
        <div className="h-2.5 w-full" style={{ background: "var(--bk)" }} />
        <div className="flex flex-1 flex-col px-12 pb-8 pt-10">
          <header className="flex items-start justify-between gap-6">
            <div className="flex items-center gap-4">
              {r.logo_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/public/clinic-logo/${r.slug}`} alt="" className="h-16 w-16 rounded-2xl border border-line object-cover" />
              ) : (
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-bold text-white" style={{ background: "var(--bk)" }}>
                  {String(r.clinic_name).slice(0, 1)}
                </span>
              )}
              <div>
                <h1 className="font-display text-xl font-bold">{r.clinic_name as string}</h1>
                {!!r.address && <p className="text-[0.8125rem] text-ink-500">{r.address as string}</p>}
                {!!r.clinic_phone && <p className="text-[0.8125rem] text-ink-500 tnum">{formatPhone(r.clinic_phone as string)}</p>}
              </div>
            </div>
            <div className="text-end">
              <div className="text-[0.8125rem] font-semibold uppercase tracking-widest text-ink-500">{T.msg.title}</div>
              <div className="font-display text-lg font-bold tnum">#{orderRef(id)}</div>
              <div className="mt-1 text-[0.8125rem] text-ink-500">
                {S.sent}: {fmtDateOnly(c.sentOn, "en")}
              </div>
            </div>
          </header>

          <section className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border px-5 py-4" style={{ borderColor: "color-mix(in srgb, var(--bk) 25%, transparent)" }}>
            {(
              [
                [S.lab, r.lab_name as string],
                [T.msg.due, c.dueOn ? fmtDateOnly(c.dueOn, "en") : S.noDue],
                [T.msg.patient, r.patient_name as string],
                [S.doctor, doctor || "—"],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <div className="text-[0.75rem] font-semibold uppercase tracking-widest text-ink-500">{k}</div>
                <div className="mt-1 text-[0.9375rem] font-semibold">
                  <bdi>{v}</bdi>
                </div>
              </div>
            ))}
          </section>

          <section className="mt-7">
            <div className="text-[0.75rem] font-semibold uppercase tracking-widest text-ink-500">{S.make}</div>
            <div className="mt-1 font-display text-2xl font-bold" data-sheet-work>
              {r.label as string}
            </div>
          </section>

          {/* The mouth, the work's teeth marked. */}
          <section className="mt-5 rounded-xl border border-line px-4 py-4">
            <div className="grid gap-1">
              <div className="flex justify-between px-1 text-[0.6875rem] font-semibold uppercase tracking-widest text-ink-400">
                <span>{S.right}</span>
                <span>{S.upper}</span>
                <span>{S.left}</span>
              </div>
              <Row sites={PERMANENT_UPPER} />
              <div className="mx-6 border-t border-dashed border-line" />
              <Row sites={PERMANENT_LOWER} />
              <div className="text-center text-[0.6875rem] font-semibold uppercase tracking-widest text-ink-400">{S.lower}</div>
            </div>
            <div className="mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1 text-[0.75rem] text-ink-700">
              {!arch && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-sm" style={{ background: "var(--bk)" }} />
                  {S.keySupport}
                </span>
              )}
              {[...roleOf.values()].includes("pontic") && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-sm border border-dashed" style={{ borderColor: "var(--bk)", background: "color-mix(in srgb, var(--bk) 12%, #fff)" }} />
                  {arch ? S.keyArch : S.keyReplaced}
                </span>
              )}
              {implants.size > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[0.6875rem] font-bold" style={{ color: "var(--bk)" }}>
                    {S.implantMark}
                  </span>
                  {S.keyImplant}
                </span>
              )}
            </div>
          </section>

          <dl className="mt-6 grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[0.9375rem]" data-sheet-rows>
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-500">{k}</dt>
                <dd className="min-w-0 break-words font-semibold tnum">
                  <bdi>{v}</bdi>
                </dd>
              </div>
            ))}
          </dl>

          {/* A piece that goes more than once: where it has been. */}
          {trips.length > 1 && (
            <section className="mt-6">
              <div className="text-[0.75rem] font-semibold uppercase tracking-widest text-ink-500">{S.trips}</div>
              <ol className="mt-2 grid gap-1 text-[0.875rem]">
                {trips.map((x, i) => (
                  <li key={i} className={i === trips.length - 1 ? "font-semibold" : "text-ink-700"}>
                    {i + 1}. {T.stages[x.stage]} · {S.sent.toLowerCase()} {fmtDateOnly(x.sentOn, "en")}
                    {x.receivedAt ? ` · ${S.backOn} ${fmtDateOnly(x.receivedAt.slice(0, 10), "en")}` : i === trips.length - 1 ? ` · ${S.now}` : ""}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="mt-auto flex items-end justify-between gap-6 pt-12">
            <p className="max-w-[60%] text-[0.75rem] text-ink-500">{S.questions}</p>
            <div className="w-64 text-center">
              <div className="h-14" />
              <div className="border-t border-ink-300 pt-2 text-[0.875rem] font-semibold">{doctor || "—"}</div>
              <div className="text-[0.75rem] text-ink-500">{S.doctor}</div>
            </div>
          </div>

          <div className="mt-8 flex justify-center border-t border-line pt-4">
            <PoweredBy label={S.poweredBy} showUrl hidden={!!r.white_label} />
          </div>
        </div>
      </div>
    </main>
  );
}
