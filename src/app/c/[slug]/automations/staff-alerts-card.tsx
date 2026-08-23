"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle, Input, Select, Field } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  STAFF_ALERT_KINDS,
  STAFF_ALERT_ROLES,
  alertShape,
  type StaffAlert,
  type StaffAlertKind,
  type StaffAlertRole,
} from "@/lib/staff-alerts";
import { saveStaffAlertAction, deleteStaffAlertAction } from "./actions";
import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";

/** A new row's starting shape, per kind — the same defaults a clinic is seeded with. */
function blank(kind: StaffAlertKind): Omit<StaffAlert, "id"> & { id?: string } {
  return {
    kind,
    roles: kind === "appointment_reminder" ? ["doctor"] : ["owner"],
    // null is a value here, not a gap: "whatever each person set for themselves".
    minutes_before: null,
    at_hour: kind === "appointment_reminder" ? null : 8,
    threshold: kind === "unread_digest" ? 3 : 0,
    enabled: true,
    sort: 99,
  };
}

export function StaffAlertsCard({ slug, alerts }: { slug: string; alerts: StaffAlert[] }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [, start] = useTransition();
  const [editing, setEditing] = useState<(Omit<StaffAlert, "id"> & { id?: string }) | null>(null);
  const [rows, setRows] = useState(alerts);

  const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

  const summary = (a: StaffAlert) => {
    const who = a.roles.map((r) => t.automations.alertRoles[r]).join("، ");
    if (a.kind === "appointment_reminder") {
      const lead =
        a.minutes_before === null
          ? t.automations.ownSetting
          : `${a.minutes_before} ${t.automations.minutesUnit}`;
      return `${t.automations.leadTime} ${lead} · ${who}`;
    }
    const base = `${t.automations.atHour} ${hourLabel(a.at_hour ?? 8)} · ${who}`;
    return a.kind === "unread_digest"
      ? `${base} · ${t.automations.threshold} ${a.threshold} ${t.automations.thresholdUnit}`
      : base;
  };

  const toggle = (a: StaffAlert, enabled: boolean) => {
    setRows((rs) => rs.map((r) => (r.id === a.id ? { ...r, enabled } : r)));
    start(async () => {
      const r = await saveStaffAlertAction(slug, {
        id: a.id,
        kind: a.kind,
        roles: a.roles,
        minutesBefore: a.minutes_before,
        atHour: a.at_hour,
        threshold: a.threshold,
        enabled,
      });
      if (r.error) toast(t.common.genericError, "error");
      router.refresh();
    });
  };

  const remove = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    start(async () => {
      await deleteStaffAlertAction(slug, id);
      toast(t.automations.alertDeleted);
      router.refresh();
    });
  };

  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <BellRing className="h-4 w-4 text-ink-400" />
              {t.automations.staffAlerts}
            </span>
          }
          sub={t.automations.staffAlertsSub}
          action={
            <Button size="sm" variant="outline" onClick={() => setEditing(blank("appointment_reminder"))}>
              <Plus className="h-4 w-4" />
              {t.automations.addAlert}
            </Button>
          }
        />
        {rows.length === 0 ? (
          <div className="px-5 py-4">
            <EmptyState
              icon={<BellRing />}
              title={t.automations.alertsEmpty}
              body={t.automations.alertsEmptyBody}
              action={
                <Button onClick={() => setEditing(blank("appointment_reminder"))}>
                  {t.automations.addAlert}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((a) => (
              <li key={a.id} className={`flex items-center gap-3 px-5 py-3.5 ${a.enabled ? "" : "opacity-70"}`}>
                <Toggle
                  checked={a.enabled}
                  label={t.automations.enable}
                  onChange={(v) => toggle(a, v)}
                />
                <button
                  type="button"
                  onClick={() => setEditing(a)}
                  className="min-w-0 flex-1 text-start"
                >
                  {/* min-w-0 so the summary truncates instead of widening the
                      card past the phone. */}
                  <div className="min-w-0 truncate text-sm font-semibold">
                    {t.automations.alertKinds[a.kind]}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-ink-500">{summary(a)}</div>
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(a)}
                  aria-label={t.common.edit}
                  className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-900/5 hover:text-ink-700"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  aria-label={t.automations.deleteAlert}
                  className="rounded-lg p-1.5 text-ink-400 hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <AlertEditor
          slug={slug}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast(t.automations.alertSaved);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function AlertEditor({
  slug,
  initial,
  onClose,
  onSaved,
}: {
  slug: string;
  initial: Omit<StaffAlert, "id"> & { id?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [saving, startSaving] = useTransition();
  const [kind, setKind] = useState<StaffAlertKind>(initial.kind);
  const [roles, setRoles] = useState<StaffAlertRole[]>(initial.roles);
  const [minutes, setMinutes] = useState<number | null>(initial.minutes_before);
  const [hour, setHour] = useState<number>(initial.at_hour ?? 8);
  const [threshold, setThreshold] = useState<number>(initial.threshold);

  const shape = alertShape(kind);

  const submit = () => {
    if (!roles.length) return toast(t.automations.noRecipients, "error");
    startSaving(async () => {
      const r = await saveStaffAlertAction(slug, {
        id: initial.id,
        kind,
        roles,
        minutesBefore: shape.minutes ? minutes : null,
        atHour: shape.hour ? hour : null,
        threshold: shape.threshold ? threshold : 0,
        enabled: initial.enabled,
      });
      if (r.error) toast(t.common.genericError, "error");
      else onSaved();
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.automations.alertKinds[kind]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={submit} loading={saving}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={t.automations.trigger} hint={t.automations.alertKindHints[kind]}>
          <Select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as StaffAlertKind;
              setKind(next);
              // Each kind carries different fields; move to that kind's own
              // sensible starting point rather than keeping numbers that mean
              // nothing here.
              if (next === "unread_digest" && !threshold) setThreshold(3);
            }}
          >
            {STAFF_ALERT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t.automations.alertKinds[k]}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-ink-900">
            {t.automations.recipients}
          </div>
          <div className="flex flex-wrap gap-2">
            {STAFF_ALERT_ROLES.map((r) => {
              const on = roles.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRoles(on ? roles.filter((x) => x !== r) : [...roles, r])}
                  className={`rounded-ctl border px-3 py-1.5 text-[13px] font-medium transition-colors duration-140 ${
                    on
                      ? "border-brand-600 bg-brand-100 text-brand-700"
                      : "border-line bg-surface text-ink-700 hover:border-line-strong"
                  }`}
                >
                  {/* For a reminder, "doctors" means the one doctor this
                      appointment belongs to — saying so here stops it reading
                      as "every doctor in the clinic, for every appointment". */}
                  {r === "doctor" && kind === "appointment_reminder"
                    ? t.automations.doctorOfAppointment
                    : t.automations.alertRoles[r]}
                </button>
              );
            })}
          </div>
        </div>

        {shape.minutes && (
          <Field label={t.automations.leadTime}>
            <div className="flex items-center gap-2">
              <Select
                value={minutes === null ? "own" : "fixed"}
                onChange={(e) => setMinutes(e.target.value === "own" ? null : 60)}
                className="!w-auto"
              >
                <option value="own">{t.automations.ownSetting}</option>
                <option value="fixed">{t.automations.minutesUnit}</option>
              </Select>
              {minutes !== null && (
                <Input
                  type="number"
                  dir="ltr"
                  min={0}
                  max={1440}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
                  className="!w-24"
                />
              )}
            </div>
          </Field>
        )}

        {shape.hour && (
          <Field label={t.automations.atHour}>
            <Select
              value={String(hour)}
              onChange={(e) => setHour(Number(e.target.value))}
              className="!w-auto"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {`${String(h).padStart(2, "0")}:00`}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {shape.threshold && (
          <Field label={t.automations.threshold} hint={t.automations.thresholdUnit}>
            <Input
              type="number"
              dir="ltr"
              min={0}
              max={999}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(0, Math.min(999, Number(e.target.value) || 0)))}
              className="!w-24"
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
