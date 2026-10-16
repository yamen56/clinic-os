import { headers } from "next/headers";
import { guardCap } from "@/lib/guard";
import { can } from "@/lib/auth";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { AppointmentsClient } from "./appointments-client";
import type { PlannedItem, Tab } from "./types";
import { STEP_SELECT, toStep } from "@/lib/charts/dental/db";
import { progressOf } from "@/lib/charts/dental/protocols";

function phoneUa(ua: string | null): boolean {
  return !!ua && /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/i.test(ua);
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ patient?: string; new?: string; items?: string; open?: string; tab?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardCap(slug, "calendar");

  const data = await inClinic(access, async (c) => {
    let initialPatient: { id: string; name: string } | null = null;
    if (isUuid(sp.patient)) {
      const p = (
        await c.query(
          `select id, full_name from patients where id = $1 and clinic_id = $2 and merged_into is null`,
          [sp.patient, access.clinicId]
        )
      ).rows[0];
      if (p) initialPatient = { id: p.id, name: p.full_name };
    }
    /*
      "Book next visit" from the patient's plan: the treatments the visit is
      for, each with the step it is up to, the doctor of their case, and a
      note that says the same — so the desk books the right length with the
      right doctor and nobody retypes the plan.
    */
    let initialPlan: { items: PlannedItem[]; doctorId: string | null; notes: string } | null = null;
    const ids = (sp.items ?? "").split(",").filter((x) => isUuid(x)).slice(0, 20);
    if (initialPatient && ids.length) {
      const marks = (
        await c.query(
          `select m.id, m.site, m.label, m.label_ar, m.treatment_key, m.performed_by
             from chart_marks m
            where m.id = any($1::uuid[]) and m.clinic_id = $2 and m.patient_id = $3 and m.voided_at is null
            order by m.created_at`,
          [ids, access.clinicId, initialPatient.id]
        )
      ).rows;
      const steps = marks.length
        ? (await c.query(`${STEP_SELECT} where s.mark_id = any($1::uuid[])`, [marks.map((m) => m.id)])).rows.map(toStep)
        : [];
      const items: PlannedItem[] = marks.map((m) => ({
        markId: m.id,
        site: m.site,
        label: m.label,
        labelAr: m.label_ar,
        next: progressOf(m.treatment_key, steps.filter((s) => s.markId === m.id))?.next?.en ?? null,
      }));
      if (items.length) {
        initialPlan = {
          items,
          // The doctor doing the work books the visit for it.
          doctorId: (marks.find((m) => m.performed_by)?.performed_by as string) ?? null,
          notes: items.map((i) => `${/^[1-8][1-8]$/.test(i.site) ? `${i.site} ` : ""}${i.label}${i.next ? ` — ${i.next}` : ""}`).join("\n"),
        };
      }
    }
    /*
      ?open=<appointment>: a link to one visit — a note about it, in the
      patient's file — lands on its day with it open.
    */
    let initialOpen: { id: string; date: string } | null = null;
    if (isUuid(sp.open)) {
      const a = (
        await c.query(
          `select a.id, (a.starts_at at time zone cl.timezone)::date::text as day
             from appointments a join clinics cl on cl.id = a.clinic_id
            where a.id = $1 and a.clinic_id = $2`,
          [sp.open, access.clinicId]
        )
      ).rows[0];
      if (a) initialOpen = { id: a.id, date: a.day };
    }
    // The waitlist tab's count, before the tab itself has been opened.
    const waitlist = (
      await c.query(
        `select count(*)::int as n from waitlist_entries where clinic_id = $1 and status in ('waiting', 'offered')`,
        [access.clinicId]
      )
    ).rows[0].n as number;
    return { initialPatient, initialPlan, initialOpen, waitlist };
  });

  /*
    Patients today opens first: it is what the desk and the doctors look at all
    day. A link that is about the calendar — a visit to open, a patient to
    book — opens the Schedule instead. The workspace that sells the product
    books meetings, not patients, and has no waiting room to show.
  */
  const showBoard = access.clinic.vocabulary !== "agency";
  const asked = sp.tab === "schedule" || sp.tab === "waitlist" || (sp.tab === "today" && showBoard) ? (sp.tab as Tab) : null;
  const aboutTheCalendar = !!(data.initialPatient || data.initialOpen || sp.new === "1");
  const initialTab: Tab = asked ?? (aboutTheCalendar || !showBoard ? "schedule" : "today");

  return (
    <AppointmentsClient
      slug={slug}
      tz={access.clinic.timezone}
      isDoctor={access.role === "doctor"}
      selfMemberId={access.memberId}
      initialTab={initialTab}
      initialPatient={data.initialPatient}
      initialPlan={data.initialPlan}
      initialOpen={data.initialOpen}
      /* ?new=1 — what the dashboard shortcut and its keyboard accelerator open. */
      openNew={sp.new === "1"}
      initialWaitlist={data.waitlist}
      caps={{
        patients: can(access, "patients"),
        invoices: can(access, "invoices"),
        conversations: can(access, "conversations"),
        settingsRooms: can(access, "settings.services"),
      }}
      showBoard={showBoard}
      /*
        A phone opens the Schedule as a list. A time grid on 390px is one
        narrow column per doctor scrolled both ways; the list is the day in
        rows. Decided from the user agent rather than in the browser, where it
        would render the week first and fetch it before switching. An iPad asks
        for the desktop site and keeps the week, which fits it.
      */
      initialView={phoneUa((await headers()).get("user-agent")) ? "list" : "week"}
    />
  );
}
