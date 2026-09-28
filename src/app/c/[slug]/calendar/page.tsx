import { headers } from "next/headers";
import { guardCap } from "@/lib/guard";
import { isUuid } from "@/lib/uuid";
import { inClinic } from "@/lib/clinic-api";
import { CalendarClient } from "./calendar-client";

function phoneUa(ua: string | null): boolean {
  return !!ua && /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/i.test(ua);
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ patient?: string; new?: string }>;
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
    return { initialPatient };
  });

  return (
    <CalendarClient
      slug={slug}
      tz={access.clinic.timezone}
      isDoctor={access.role === "doctor"}
      selfMemberId={access.memberId}
      initialPatient={data.initialPatient}
      /* ?new=1 — what the dashboard shortcut and its keyboard accelerator open. */
      openNew={sp.new === "1"}
      /*
        A phone opens on today. Seven columns do not fit 390px, so the week
        showed two and a half days and scrolled sideways for the rest. Decided
        here from the user agent rather than in the browser, where it would
        render the week first and fetch it before switching. An iPad asks for
        the desktop site and keeps the week, which fits it.
      */
      initialView={phoneUa((await headers()).get("user-agent")) ? "day" : "week"}
    />
  );
}
