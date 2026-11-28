"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { asLocale, when } from "@/lib/notification-text";
import { timeOffRangeText, type TimeOffRow } from "@/lib/time-off";
import { addTimeOffAction, deleteTimeOffAction, type TimeOffClash } from "./time-off-actions";
import { CalendarOff, Trash2 } from "lucide-react";

/**
 * A doctor's days off: the ones coming up, and a row to add more.
 *
 * On Settings → Hours it lists every doctor and asks which one; on a doctor's
 * own My hours it is theirs alone. Adding stops at visits already booked on
 * those days and shows them, because they do not move by themselves.
 */
export function DaysOffCard({
  slug,
  tz,
  today,
  doctors,
  initialRows,
}: {
  slug: string;
  tz: string;
  /** The clinic's today, yyyy-MM-dd. */
  today: string;
  /** One doctor on their own page; every doctor in Settings. */
  doctors: { id: string; name: string }[];
  initialRows: TimeOffRow[];
}) {
  const { t, locale } = useI18n();
  const T = t.timeOff;
  const { toast } = useToast();
  const [rows, setRows] = useState(initialRows);
  const [memberId, setMemberId] = useState(doctors[0]?.id ?? "");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [note, setNote] = useState("");
  const [clashes, setClashes] = useState<{ total: number; list: TimeOffClash[] } | null>(null);
  const [pending, start] = useTransition();
  const [removing, setRemoving] = useState<string | null>(null);
  const many = doctors.length > 1;

  const add = (confirmed: boolean) =>
    start(async () => {
      const r = await addTimeOffAction(slug, { memberId, from, to, note, confirmed });
      if (r.clashes) {
        setClashes(r.clashes);
        return;
      }
      setClashes(null);
      if (r.error || !r.row) {
        toast(r.error === "invalid" ? T.invalid : r.error === "past" ? T.past : t.common.genericError, "error");
        return;
      }
      const row = r.row;
      setRows((prev) => [...prev, row].sort((a, b) => a.starts_on.localeCompare(b.starts_on)));
      setNote("");
      toast(T.added);
    });

  const remove = (id: string) => {
    setRemoving(id);
    deleteTimeOffAction(slug, id)
      .then((r) => {
        if (r.error) return toast(t.common.genericError, "error");
        setRows((prev) => prev.filter((x) => x.id !== id));
        toast(T.removed);
      })
      .catch(() => toast(t.common.genericError, "error"))
      .finally(() => setRemoving(null));
  };

  return (
    <Card>
      <CardHeader title={many ? T.titleDoctors : T.title} sub={T.sub} />
      <div className="space-y-4 p-5" data-days-off>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">{T.none}</p>
        ) : (
          <ul className="divide-y divide-line rounded-ctl border border-line" data-days-off-list>
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2.5" data-days-off-row={r.member_id}>
                <CalendarOff className="h-4 w-4 shrink-0 text-ink-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink-900">
                    {many && <span>{r.doctor_name} · </span>}
                    <bdi>{timeOffRangeText(r.starts_on, r.ends_on, locale)}</bdi>
                  </div>
                  {r.note && <div className="truncate text-[0.75rem] text-ink-500">{r.note}</div>}
                </div>
                <button
                  type="button"
                  aria-label={T.remove}
                  onClick={() => remove(r.id)}
                  disabled={removing === r.id}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl text-ink-500 hover:bg-sunken hover:text-danger disabled:opacity-45"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {doctors.length === 0 ? (
          <p className="text-sm text-ink-500">{T.noDoctors}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] sm:items-end">
            {many && (
              <div className="col-span-2 sm:col-span-1">
                <Field label={T.doctor}>
                  <Select value={memberId} onChange={(e) => setMemberId(e.target.value)} data-days-off-doctor>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <Field label={T.from}>
              <Input
                type="date"
                value={from}
                min={today}
                onChange={(e) => {
                  setFrom(e.target.value);
                  // A range that would end before it starts follows the start.
                  if (e.target.value > to) setTo(e.target.value);
                }}
                data-days-off-from
              />
            </Field>
            <Field label={T.to}>
              <Input type="date" value={to} min={from || today} onChange={(e) => setTo(e.target.value)} data-days-off-to />
            </Field>
            <div className="col-span-2 sm:col-span-1">
              <Field label={T.note}>
                <Input value={note} maxLength={120} placeholder={T.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            <Button
              className="col-span-2 sm:col-span-1"
              onClick={() => add(false)}
              loading={pending}
              disabled={pending || !memberId || !from || !to}
              data-days-off-add
            >
              {T.add}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!clashes}
        onClose={() => setClashes(null)}
        onConfirm={() => add(true)}
        title={`${T.clashTitle} (${clashes?.total ?? 0})`}
        body={T.clashBody}
        confirmLabel={T.addAnyway}
        cancelLabel={t.common.cancel}
        danger={false}
        loading={pending}
      >
        <ul className="space-y-1 text-[0.8125rem] text-ink-700" data-days-off-clashes>
          {clashes?.list.map((c) => (
            <li key={c.id}>
              <bdi>{when(c.startsAt, tz, asLocale(locale))}</bdi>
              {c.patient && <> · {c.patient}</>}
            </li>
          ))}
          {clashes && clashes.total > clashes.list.length && (
            <li>{T.clashMore.replace("{n}", String(clashes.total - clashes.list.length))}</li>
          )}
        </ul>
      </ConfirmDialog>
    </Card>
  );
}
