"use client";

/*
  The patient's family (migration 0127), on the file's overview.

  Everyone in it, each with their role and age, the number they are reached
  on — their own, or the family contact's — their next visit and what they
  owe, with a Book on every row. Below them what the family owes together and
  one payment toward all of it.

  Adding someone is either a file already here (found by name or phone) or a
  new member typed in with no phone — the child the mother brings.
*/

import { useState, useTransition } from "react";
import Link from "next/link";
import { CalendarPlus, Phone, Star, UserPlus, Users, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime, fmtMoney } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { ageOn, familyRoleLabel, FAMILY_ROLES, type Family, type FamilyRole } from "@/lib/families";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { Avatar } from "@/components/ui/misc";
import { Field, Input, Select } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PatientPicker } from "@/components/appointments/patient-picker";
import { TakePayment } from "@/components/take-payment";
import { addFamilyMemberAction, removeFamilyMemberAction, setFamilyContactAction } from "./family-actions";

export function FamilyCard({
  slug,
  patientId,
  patientName,
  family,
  tz,
  today,
  currency,
  canBook,
  canPay,
  className = "",
}: {
  slug: string;
  patientId: string;
  patientName: string;
  family: Family | null;
  tz: string;
  today: string;
  currency: string;
  canBook: boolean;
  /** May see and take what is owed — the figures are null otherwise. */
  canPay: boolean;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const F = t.family;
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const members = family?.members ?? [];
  const contact = members.find((m) => m.isContact) ?? null;
  const owedTotal = members.reduce((n, m) => n + (m.owed ?? 0), 0);

  const makeContact = (id: string, name: string) =>
    start(async () => {
      const r = await setFamilyContactAction(slug, patientId, id);
      if (r.error) toast(t.common.genericError, "error");
      else toast(F.contactSet.replace("{name}", name));
    });

  return (
    <div className={className} data-family={members.length}>
      <Card className="p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-[0.9375rem] font-semibold text-ink-900">
            <Users className="h-4 w-4 text-ink-500" />
            {F.title}
          </h3>
          <Button size="sm" variant="soft" onClick={() => setAdding(true)} data-family-add>
            <UserPlus className="h-4 w-4" />
            {F.add}
          </Button>
        </div>

        {members.length === 0 ? (
          <p className="text-[0.8125rem] text-ink-500">{F.none}</p>
        ) : (
          <ul className="grid gap-1" data-family-list>
            {members.map((m) => {
              const self = m.id === patientId;
              const age = ageOn(m.birthDate, today);
              const role = familyRoleLabel(m.role, m.gender, F);
              const reach = m.phone
                ? formatPhone(m.phone)
                : contact?.phone
                  ? F.viaContact.replace("{name}", contact.name)
                  : F.noPhone;
              return (
                <li
                  key={m.id}
                  className={`flex items-start gap-2.5 rounded-lg px-2 py-2 ${self ? "bg-sunken" : ""}`}
                  data-family-member={m.id}
                  data-family-role={m.role ?? ""}
                  data-family-contact={m.isContact ? "1" : undefined}
                >
                  <Avatar name={m.name} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                      {self ? (
                        <span className="font-semibold text-ink-900">{m.name}</span>
                      ) : (
                        <Link href={`/c/${slug}/patients/${m.id}`} className="font-semibold text-ink-900 hover:text-brand-700 hover:underline">
                          {m.name}
                        </Link>
                      )}
                      {(role || age !== null) && (
                        <span className="text-[0.75rem] text-ink-500">{[role, age !== null ? F.age.replace("{n}", String(age)) : ""].filter(Boolean).join(" · ")}</span>
                      )}
                      {m.isContact && (
                        <span className="inline-flex items-center gap-0.5 text-[0.75rem] font-semibold text-brand-700" title={F.contactHint}>
                          <Star className="h-3 w-3" />
                          {F.contact}
                        </span>
                      )}
                    </div>
                    <div className={`flex items-center gap-1 text-[0.75rem] ${m.phone || contact?.phone ? "text-ink-500" : "text-st-pending"}`} data-family-reach>
                      {m.phone && <Phone className="h-3 w-3 shrink-0" />}
                      <span className={`min-w-0 truncate ${m.phone ? "num tnum" : ""}`}>{reach}</span>
                    </div>
                    {(m.nextAt || (m.owed ?? 0) > 0) && (
                      <div className="text-[0.75rem] text-ink-500">
                        {[
                          m.nextAt ? F.next.replace("{when}", fmtDateTime(m.nextAt, tz, locale)) : "",
                          (m.owed ?? 0) > 0 ? F.owes.replace("{amount}", fmtMoney(m.owed!, currency, locale)) : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                    {m.phone && !m.isContact && (
                      <button
                        type="button"
                        onClick={() => makeContact(m.id, m.name)}
                        disabled={pending}
                        className="mt-0.5 text-[0.75rem] font-semibold text-brand-700 hover:underline disabled:opacity-50"
                        data-family-make-contact
                      >
                        {F.makeContact}
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canBook && (
                      <Link
                        href={`/c/${slug}/calendar?patient=${m.id}`}
                        className={buttonClass({ variant: "ghost", size: "sm", className: "max-sm:min-h-10" })}
                        aria-label={`${F.book} · ${m.name}`}
                        data-family-book={m.id}
                      >
                        <CalendarPlus className="h-4 w-4" />
                        <span className="max-sm:hidden">{F.book}</span>
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => setRemoving({ id: m.id, name: m.name })}
                      aria-label={F.remove}
                      title={F.remove}
                      className="grid h-8 w-8 place-items-center rounded-full text-ink-400 hover:bg-sunken hover:text-danger max-sm:h-10 max-sm:w-10"
                      data-family-remove={m.id}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/*
          What they owe together, and one payment toward all of it. Kept
          mounted once paid off: the payment hides itself at nothing owed but
          stays to offer the receipts of what it settled, as the balance card's does.
        */}
        {canPay && members.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 empty:hidden" data-family-owed={owedTotal}>
            {owedTotal > 0 && (
              <span className="text-[0.8125rem] font-semibold text-st-pending tnum">{F.familyOwes.replace("{amount}", fmtMoney(owedTotal, currency, locale))}</span>
            )}
            <TakePayment slug={slug} patientId={patientId} balance={owedTotal} currency={currency} tz={tz} family />
          </div>
        )}
      </Card>

      {adding && (
        <AddMember
          slug={slug}
          patientId={patientId}
          patientName={patientName}
          memberIds={new Set(members.map((m) => m.id))}
          onClose={() => setAdding(false)}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={F.remove}
        body={removing ? F.removeBody.replace("{name}", removing.name) : ""}
        confirmLabel={F.remove}
        cancelLabel={t.common.back}
        loading={pending}
        onConfirm={() => {
          const r = removing;
          if (!r) return;
          start(async () => {
            const x = await removeFamilyMemberAction(slug, patientId, r.id);
            setRemoving(null);
            if (x.error) toast(t.common.genericError, "error");
            else toast(F.removed);
          });
        }}
      />
    </div>
  );
}

function AddMember({
  slug,
  patientId,
  patientName,
  memberIds,
  onClose,
}: {
  slug: string;
  patientId: string;
  patientName: string;
  memberIds: Set<string>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const F = t.family;
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"new" | "file">("new");
  const [other, setOther] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [gender, setGender] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [role, setRole] = useState<FamilyRole>("child");

  const ready = mode === "new" ? name.trim().length > 0 : !!other && other.id !== patientId && !memberIds.has(other.id);
  const save = () =>
    start(async () => {
      const r = await addFamilyMemberAction(
        slug,
        patientId,
        mode === "new"
          ? { newMember: { fullName: name.trim(), gender: gender || null, birthDate: birthDate || null }, role }
          : { otherId: other!.id, role }
      );
      if (r.error) {
        toast(r.error === "name_required" ? F.nameRequired : t.common.genericError, "error");
        return;
      }
      toast(F.added);
      onClose();
    });

  return (
    <Modal open onClose={onClose} title={F.addTitle.replace("{name}", patientName)}>
      <div className="grid gap-4" data-family-form>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1" role="tablist">
          {(["new", "file"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => setMode(k)}
              className={`min-h-10 rounded-md text-[0.8125rem] font-semibold ${mode === k ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"}`}
              data-family-mode={k}
            >
              {k === "new" ? F.newOne : F.onFile}
            </button>
          ))}
        </div>

        {mode === "new" ? (
          <>
            <p className="text-[0.75rem] text-ink-500">{F.newHint}</p>
            <Field label={t.patients.fullName} required>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus data-family-name />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.patients.gender}>
                <Select value={gender} onChange={(e) => setGender(e.target.value)} data-family-gender>
                  <option value="">—</option>
                  <option value="male">{t.patients.male}</option>
                  <option value="female">{t.patients.female}</option>
                </Select>
              </Field>
              <Field label={t.patients.birthDate}>
                <Input type="date" dir="ltr" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} data-family-birth />
              </Field>
            </div>
          </>
        ) : other ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
            <Avatar name={other.name} size={28} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{other.name}</span>
            <button type="button" onClick={() => setOther(null)} aria-label={t.common.delete} className="text-ink-400 hover:text-danger">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <PatientPicker slug={slug} onPick={setOther} autoFocus />
        )}

        <Field label={F.role}>
          <Select value={role} onChange={(e) => setRole(e.target.value as FamilyRole)} data-family-role-select>
            {FAMILY_ROLES.map((r) => (
              <option key={r} value={r}>
                {F[r]}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={save} loading={pending} disabled={!ready} data-family-save>
            {F.add}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
