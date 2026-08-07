"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtRelative } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { addToWaitlistAction, setWaitlistStatusAction } from "./actions";
import { Hourglass, Plus, X, Search } from "lucide-react";

type Entry = {
  id: string;
  status: string;
  earliest_date: string | null;
  latest_date: string | null;
  note: string;
  last_offered_at: string | null;
  offers_sent: number;
  created_at: string;
  patient_id: string;
  full_name: string;
  phone_e164: string | null;
  doctor_name: string | null;
  service_name: string | null;
};

export function WaitlistClient(props: {
  slug: string;
  tz: string;
  entries: Entry[];
  doctors: { id: string; name: string }[];
  services: { id: string; name: string }[];
  hasBookingLink: boolean;
}) {
  const { slug, tz } = props;
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <>
      <PageHeader
        title={t.nav.waitlist}
        sub={t.waitlist.sub}
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            {t.waitlist.add}
          </Button>
        }
      />

      {/*
        A waitlist with nowhere to send people is a list that quietly does
        nothing, so say so rather than letting the clinic discover it when a
        cancellation produces silence.
      */}
      {!props.hasBookingLink && (
        <Card className="mb-4 border-st-pending bg-st-pending-soft p-4 text-[13px]">
          {t.waitlist.needsBookingLink}{" "}
          <Link href={`/c/${slug}/settings/booking`} className="font-semibold underline">
            {t.settings.bookingLinks}
          </Link>
        </Card>
      )}

      {props.entries.length === 0 ? (
        <EmptyState
          icon={<Hourglass />}
          title={t.waitlist.emptyTitle}
          body={t.waitlist.emptyBody}
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              {t.waitlist.add}
            </Button>
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {props.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
                <Link
                  href={`/c/${slug}/patients/${e.patient_id}`}
                  className="min-w-0 flex-1 hover:underline"
                >
                  <span className="block truncate text-sm font-semibold">{e.full_name}</span>
                  <span className="block truncate text-[13px] text-ink-500">
                    {[
                      e.doctor_name ?? t.waitlist.anyDoctor,
                      e.service_name ?? t.waitlist.anyService,
                      e.latest_date
                        ? `${t.waitlist.until} ${fmtDate(e.latest_date, tz, locale)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </Link>
                {e.phone_e164 && (
                  <span className="num tnum hidden text-[13px] text-ink-400 sm:block">
                    {formatPhone(e.phone_e164)}
                  </span>
                )}
                {e.status === "offered" ? (
                  <Badge status="pending">
                    {t.waitlist.offered}
                    {e.last_offered_at ? ` · ${fmtRelative(e.last_offered_at, locale)}` : ""}
                  </Badge>
                ) : (
                  <Badge status="neutral">{t.waitlist.waiting}</Badge>
                )}
                <button
                  aria-label={t.common.delete}
                  className="text-ink-300 hover:text-danger"
                  onClick={() =>
                    start(async () => {
                      await setWaitlistStatusAction(slug, e.id, "cancelled");
                      router.refresh();
                    })
                  }
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AddModal
        open={open}
        onClose={() => setOpen(false)}
        slug={slug}
        doctors={props.doctors}
        services={props.services}
        onAdded={() => {
          setOpen(false);
          router.refresh();
          toast(t.waitlist.added, "success");
        }}
        pending={pending}
        start={start}
      />
    </>
  );
}

/** Patient search + preferences. The patient is found the same way as elsewhere. */
function AddModal(props: {
  open: boolean;
  onClose: () => void;
  slug: string;
  doctors: { id: string; name: string }[];
  services: { id: string; name: string }[];
  onAdded: () => void;
  pending: boolean;
  start: (fn: () => Promise<void>) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const [picked, setPicked] = useState<{ id: string; full_name: string } | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [latest, setLatest] = useState("");
  const [note, setNote] = useState("");

  const search = async (value: string) => {
    setQ(value);
    if (value.trim().length < 2) return setResults([]);
    const r = await fetch(
      `/api/c/${props.slug}/patients/search?q=${encodeURIComponent(value)}`
    ).then((x) => (x.ok ? x.json() : { patients: [] }));
    setResults(r.patients ?? []);
  };

  return (
    <Modal open={props.open} onClose={props.onClose} title={t.waitlist.add}>
      <div className="grid gap-4">
        {picked ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
            <span className="truncate text-sm font-semibold">{picked.full_name}</span>
            <button className="text-[13px] text-brand-700" onClick={() => setPicked(null)}>
              {t.common.edit}
            </button>
          </div>
        ) : (
          <Field label={t.waitlist.patient} required>
            <div className="relative">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-ink-300" />
              <Input
                value={q}
                onChange={(e) => search(e.target.value)}
                placeholder={t.patients.searchPlaceholder}
                className="ps-9"
                autoFocus
              />
            </div>
            {results.length > 0 && (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-line">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-sunken"
                      onClick={() => {
                        setPicked({ id: r.id, full_name: r.full_name });
                        setResults([]);
                        setQ("");
                      }}
                    >
                      <span className="truncate">{r.full_name}</span>
                      {r.phone_e164 && (
                        <span className="num tnum text-[12px] text-ink-400">
                          {formatPhone(r.phone_e164)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.waitlist.doctor}>
            <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">{t.waitlist.anyDoctor}</option>
              {props.doctors.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t.waitlist.service}>
            <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              <option value="">{t.waitlist.anyService}</option>
              {props.services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t.waitlist.until} hint={t.waitlist.untilHint}>
          <Input type="date" value={latest} onChange={(e) => setLatest(e.target.value)} />
        </Field>
        <Field label={t.waitlist.note}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose}>{t.common.cancel}</Button>
          <Button
            loading={props.pending}
            disabled={!picked}
            onClick={() =>
              props.start(async () => {
                const r = await addToWaitlistAction(props.slug, {
                  patientId: picked!.id,
                  doctorMemberId: doctorId || null,
                  serviceId: serviceId || null,
                  latestDate: latest || null,
                  note,
                });
                if (r.error) {
                  toast(
                    r.error === "already_waiting" ? t.waitlist.alreadyWaiting : t.common.required,
                    "error"
                  );
                  return;
                }
                setPicked(null);
                setDoctorId("");
                setServiceId("");
                setLatest("");
                setNote("");
                props.onAdded();
              })
            }
          >
            {t.common.add}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
