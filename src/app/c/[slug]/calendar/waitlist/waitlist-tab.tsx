"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { fmtDate, fmtRelative } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, EmptyState, Spinner } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ServiceSelect } from "@/components/ui/service-picker";
import type { WaitlistEntry } from "@/lib/waitlist";
import { addToWaitlistAction, setWaitlistStatusAction } from "../../waitlist/actions";
import { createPatientAction } from "../../patients/actions";
import type { CalendarMeta } from "../types";
import { Hourglass, Plus, Search, Sparkles, CalendarPlus, X, UserRound, Stethoscope } from "lucide-react";

type Slot = { startISO: string; doctorMemberId: string | null };

/**
 * Who would take an earlier appointment if one came free — beside the
 * calendar it fills, rather than a page of its own.
 *
 * Cancellations offer slots on their own (worker/waitlist.ts). This is where
 * the desk adds somebody, sees who has been offered what, and books them by
 * hand: "Find a free time" asks the same engine the booking page uses, and a
 * time picked here opens the booking panel already filled in. Booking them
 * takes them off the list (closeWaitlistOnBooking).
 */
export function WaitlistTab({
  slug,
  tz,
  meta,
  onCount,
  onBook,
}: {
  slug: string;
  tz: string;
  meta: CalendarMeta | null;
  onCount: (n: number) => void;
  onBook: (e: WaitlistEntry, slot?: Slot) => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [data, setData] = useState<{ entries: WaitlistEntry[]; hasBookingLink: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WaitlistEntry | null>(null);
  const [slots, setSlots] = useState<Record<string, Slot[] | "loading">>({});
  const [pending, start] = useTransition();

  const refetch = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/waitlist`, { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json();
    setData(d);
    onCount(d.entries.length);
  }, [slug, onCount]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRealtimeRefresh(slug, ["waitlist_entries"], refetch);

  const findSlot = async (e: WaitlistEntry) => {
    if (!e.service_id) return;
    setSlots((m) => ({ ...m, [e.id]: "loading" }));
    const q = new URLSearchParams({ service: e.service_id, limit: "6" });
    if (e.doctor_member_id) q.set("doctor", e.doctor_member_id);
    if (e.earliest_date) q.set("from", e.earliest_date);
    const res = await fetch(`/api/c/${slug}/free-slots?${q}`);
    const found: Slot[] = res.ok ? (await res.json()).slots : [];
    // Nothing after the date they need it by is worth offering.
    const until = e.latest_date ? DateTime.fromISO(e.latest_date, { zone: tz }).endOf("day").toMillis() : Infinity;
    setSlots((m) => ({ ...m, [e.id]: found.filter((s) => Date.parse(s.startISO) <= until) }));
  };

  const service = (e: WaitlistEntry) => (locale === "ar" && e.service_name_ar) || e.service_name;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-ink-500">{t.waitlist.sub}</p>
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
          {t.waitlist.add}
        </Button>
      </div>

      {/*
        A waitlist with nowhere to send people is a list that quietly does
        nothing, so say so rather than letting the clinic discover it when a
        cancellation produces silence.
      */}
      {data && !data.hasBookingLink && (
        <div className="rounded-card border border-st-pending/40 bg-st-pending-soft p-4 text-[13px]">
          {t.waitlist.needsBookingLink}{" "}
          <Link href={`/c/${slug}/settings/booking`} className="font-semibold underline">
            {t.settings.bookingLinks}
          </Link>
        </div>
      )}

      {!data ? (
        <Spinner label={t.common.loading} />
      ) : data.entries.length === 0 ? (
        <EmptyState
          icon={<Hourglass />}
          title={t.waitlist.emptyTitle}
          body={t.waitlist.emptyBody}
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              {t.waitlist.add}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-waitlist>
          {data.entries.map((e) => {
            const found = slots[e.id];
            const window =
              e.earliest_date && e.latest_date
                ? t.waitlist.window.replace("{from}", fmtDate(e.earliest_date, tz, locale)).replace("{to}", fmtDate(e.latest_date, tz, locale))
                : e.earliest_date
                  ? t.waitlist.fromOnly.replace("{date}", fmtDate(e.earliest_date, tz, locale))
                  : e.latest_date
                    ? `${t.waitlist.until} ${fmtDate(e.latest_date, tz, locale)}`
                    : null;
            return (
              <div key={e.id} data-waitlist-entry={e.id} className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-card">
                <div className="flex items-start gap-3">
                  <Avatar name={e.full_name} size={36} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/c/${slug}/patients/${e.patient_id}`} className="block truncate text-[15px] font-semibold text-ink-900 hover:underline">
                      {e.full_name}
                    </Link>
                    {e.phone_e164 && (
                      <span className="num block text-[12px] text-ink-400 tnum">{formatPhone(e.phone_e164)}</span>
                    )}
                  </div>
                  {e.status === "offered" ? (
                    <Badge status="pending">
                      {t.waitlist.offered}
                      {e.last_offered_at ? ` · ${fmtRelative(e.last_offered_at, locale)}` : ""}
                    </Badge>
                  ) : (
                    <Badge status="neutral">{t.waitlist.waiting}</Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-700">
                  <span className="inline-flex items-center gap-1">
                    <Stethoscope className="h-3.5 w-3.5 text-ink-400" />
                    {e.doctor_name ?? t.waitlist.anyDoctor}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <UserRound className="h-3.5 w-3.5 text-ink-400" />
                    {service(e) ?? t.waitlist.anyService}
                  </span>
                  {window && <span className="font-medium text-ink-900">{window}</span>}
                </div>
                {e.note && <p className="whitespace-pre-line text-[12.5px] text-ink-500">{e.note}</p>}
                <div className="text-[11.5px] text-ink-400">
                  {t.waitlist.since.replace("{when}", fmtRelative(e.created_at, locale))}
                  {e.offers_sent > 0 && ` · ${t.waitlist.offeredTimes.replace("{n}", String(e.offers_sent))}`}
                </div>

                {Array.isArray(found) && (
                  <div className="flex flex-wrap gap-1.5" data-waitlist-slots>
                    {found.length === 0 ? (
                      <span className="text-[12px] text-ink-500">{t.calendar.noFreeTimes}</span>
                    ) : (
                      found.map((s) => {
                        const d = DateTime.fromISO(s.startISO).setZone(tz).setLocale(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB");
                        return (
                          <button
                            key={`${s.startISO}${s.doctorMemberId}`}
                            type="button"
                            onClick={() => onBook(e, s)}
                            className="rounded-full border border-line-strong px-2.5 py-1 text-[12px] font-medium text-ink-700 transition-colors hover:border-brand-400 hover:bg-brand-50"
                          >
                            {d.toFormat("ccc d LLL")} · <span className="tnum">{d.toFormat("H:mm")}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  {e.service_id && (
                    <Button variant="outline" size="sm" loading={found === "loading"} onClick={() => findSlot(e)}>
                      <Sparkles className="h-4 w-4" />
                      {t.waitlist.findSlot}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => onBook(e)}>
                    <CalendarPlus className="h-4 w-4" />
                    {t.waitlist.book}
                  </Button>
                  <button
                    type="button"
                    aria-label={t.waitlist.remove}
                    title={t.waitlist.remove}
                    className="ms-auto rounded-full p-1.5 text-ink-300 transition-colors hover:bg-danger-soft hover:text-danger"
                    onClick={() => setRemoving(e)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddModal
        open={adding}
        onClose={() => setAdding(false)}
        slug={slug}
        meta={meta}
        onAdded={() => {
          setAdding(false);
          toast(t.waitlist.added, "success");
          void refetch();
        }}
      />

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t.waitlist.remove}
        body={removing?.full_name ?? ""}
        confirmLabel={t.waitlist.remove}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!removing) return;
            const id = removing.id;
            setRemoving(null);
            // Gone from the list at once; realtime confirms.
            setData((d) => d && { ...d, entries: d.entries.filter((x) => x.id !== id) });
            const r = await setWaitlistStatusAction(slug, id, "cancelled");
            if (r.error) {
              toast(t.common.genericError, "error");
              void refetch();
            } else toast(t.waitlist.removed);
          })
        }
      />
      {pending && <span className="sr-only">{t.common.loading}</span>}
    </div>
  );
}

/** Patient search + preferences. The patient is found the same way as elsewhere. */
function AddModal(props: {
  open: boolean;
  onClose: () => void;
  slug: string;
  meta: CalendarMeta | null;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const [picked, setPicked] = useState<{ id: string; full_name: string } | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [earliest, setEarliest] = useState("");
  const [latest, setLatest] = useState("");
  const [note, setNote] = useState("");
  const [searched, setSearched] = useState(false);

  /*
    `results`, not `patients` — the endpoint has always returned that key, and
    reading the wrong one meant the list was silently empty however correct the
    search term was. Nothing errored; there was simply never anybody to pick.
  */
  const search = async (value: string) => {
    setQ(value);
    setSearched(false);
    if (value.trim().length < 2) return setResults([]);
    const r = await fetch(`/api/c/${props.slug}/patients/search?q=${encodeURIComponent(value)}`).then((x) =>
      x.ok ? x.json() : { results: [] }
    );
    setResults(r.results ?? []);
    setSearched(true);
  };

  // Somebody ringing to ask for an earlier slot is often not on file yet, so
  // the dead end of "no matches" has to lead somewhere.
  const digits = q.replace(/\D/g, "");
  const looksLikePhone = digits.length >= 7;

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
              <Input value={q} onChange={(e) => search(e.target.value)} placeholder={t.patients.searchPlaceholder} className="ps-9" autoFocus />
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
                      {r.phone_e164 && <span className="num tnum text-[12px] text-ink-400">{formatPhone(r.phone_e164)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searched && results.length === 0 && (
              <div className="mt-2 grid gap-2 rounded-lg border border-dashed border-line p-3">
                <span className="text-[13px] text-ink-500">{t.waitlist.noMatch}</span>
                <Button
                  variant="outline"
                  size="sm"
                  loading={pending}
                  onClick={() =>
                    start(async () => {
                      // What was typed is used as whichever field it looks like,
                      // so a phone number does not become somebody's name.
                      const r = await createPatientAction(props.slug, {
                        fullName: q.trim(),
                        phone: looksLikePhone ? q.trim() : "",
                      });
                      if (!r.id) return toast(t.waitlist.createFailed, "error");
                      setPicked({ id: r.id, full_name: q.trim() });
                      setResults([]);
                      setQ("");
                      setSearched(false);
                    })
                  }
                >
                  <Plus className="h-4 w-4" />
                  {t.waitlist.createPatient}
                </Button>
              </div>
            )}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.waitlist.doctor}>
            <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">{t.waitlist.anyDoctor}</option>
              {(props.meta?.doctors ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.waitlist.service}>
            {/* Grouped by section, and in the clinic's own language. */}
            <ServiceSelect
              services={props.meta?.services ?? []}
              sections={props.meta?.sections ?? []}
              value={serviceId}
              onChange={setServiceId}
              emptyLabel={t.waitlist.anyService}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.waitlist.from} hint={t.waitlist.fromHint}>
            <Input type="date" value={earliest} onChange={(e) => setEarliest(e.target.value)} />
          </Field>
          <Field label={t.waitlist.until} hint={t.waitlist.untilHint}>
            <Input type="date" value={latest} min={earliest || undefined} onChange={(e) => setLatest(e.target.value)} />
          </Field>
        </div>
        <Field label={t.waitlist.note}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose}>
            {t.common.cancel}
          </Button>
          <Button
            loading={pending}
            disabled={!picked}
            onClick={() =>
              start(async () => {
                const r = await addToWaitlistAction(props.slug, {
                  patientId: picked!.id,
                  doctorMemberId: doctorId || null,
                  serviceId: serviceId || null,
                  earliestDate: earliest || null,
                  latestDate: latest || null,
                  note,
                });
                if (r.error) {
                  toast(r.error === "already_waiting" ? t.waitlist.alreadyWaiting : t.common.required, "error");
                  return;
                }
                setPicked(null);
                setDoctorId("");
                setServiceId("");
                setEarliest("");
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
