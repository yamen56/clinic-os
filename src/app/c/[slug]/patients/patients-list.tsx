"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput, Select, Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Avatar } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { createPatientAction } from "./actions";
import { Users, Plus, Upload } from "lucide-react";

type Row = {
  id: string;
  fullName: string;
  phone: string | null;
  tags: string[];
  source: string;
  status: string;
  lastVisitAt: string | null;
  nextAppointment: string | null;
};

export function PatientsList({
  slug,
  patients,
  total,
  allTags,
  tz,
  initialFilters,
}: {
  slug: string;
  patients: Row[];
  total: number;
  allTags: string[];
  tz: string;
  initialFilters: { q: string; tag: string; source: string; visit: string };
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [f, setF] = useState(initialFilters);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState("");
  const [pending, start] = useTransition();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = (next: typeof f) => {
    setF(next);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const p = new URLSearchParams();
      if (next.q) p.set("q", next.q);
      if (next.tag) p.set("tag", next.tag);
      if (next.source) p.set("source", next.source);
      if (next.visit) p.set("visit", next.visit);
      router.replace(`/c/${slug}/patients${p.size ? `?${p}` : ""}`);
    }, 300);
  };

  useEffect(() => () => debounce.current ? clearTimeout(debounce.current) : undefined, []);

  const submitNew = () =>
    start(async () => {
      setErr("");
      const r = await createPatientAction(slug, { fullName: name, phone });
      if (r.error) {
        setErr(r.error === "invalid_phone" ? t.common.invalidPhone : t.common.required);
        return;
      }
      if (r.existing) toast(t.patients.existingPatient, "info");
      setNewOpen(false);
      setName("");
      setPhone("");
      router.push(`/c/${slug}/patients/${r.id}`);
    });

  const sourceLabel = (s: string) =>
    (t.patients.sources as Record<string, string>)[s] ?? s;

  return (
    <>
      <PageHeader
        title={t.patients.title}
        action={
          <>
            {/* Beside "new patient", because a clinic arriving with a list is
                looking for it on this screen and nowhere else. */}
            <Link href={`/c/${slug}/patients/import`}>
              <Button variant="outline">
                <Upload className="h-4 w-4" />
                {t.import.title}
              </Button>
            </Link>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              {t.patients.newPatient}
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <SearchInput
          className="w-full sm:w-72"
          placeholder={t.patients.searchPlaceholder}
          value={f.q}
          onChange={(e) => apply({ ...f, q: e.target.value })}
        />
        <Select
          className="!w-auto"
          value={f.tag}
          onChange={(e) => apply({ ...f, tag: e.target.value })}
        >
          <option value="">{t.patients.filters.allTags}</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </Select>
        <Select
          className="!w-auto"
          value={f.source}
          onChange={(e) => apply({ ...f, source: e.target.value })}
        >
          <option value="">{t.patients.filters.allSources}</option>
          {Object.entries(t.patients.sources).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select
          className="!w-auto"
          value={f.visit}
          onChange={(e) => apply({ ...f, visit: e.target.value })}
        >
          <option value="">{t.patients.filters.anyVisit}</option>
          <option value="30">{t.patients.filters.noVisit30}</option>
          <option value="90">{t.patients.filters.noVisit90}</option>
          <option value="180">{t.patients.filters.noVisit180}</option>
        </Select>
      </div>

      {/* The query is capped, so say so rather than silently hiding records. */}
      {total > patients.length && (
        <p className="mb-2 text-[13px] text-ink-500">
          {t.patients.showingOf
            .replace("{shown}", String(patients.length))
            .replace("{total}", String(total))}
        </p>
      )}

      {patients.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={f.q || f.tag || f.source ? t.common.noResults : t.patients.noPatients}
          body={f.q || f.tag || f.source ? undefined : t.patients.noPatientsBody}
          action={
            !f.q && !f.tag && !f.source ? (
              <Button onClick={() => setNewOpen(true)}>{t.patients.newPatient}</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <ul className="divide-y divide-line">
            {patients.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/c/${slug}/patients/${p.id}`}
                  className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-sunken"
                >
                  <Avatar name={p.fullName} size={38} color={p.status === "lead" ? "var(--color-st-pending)" : undefined} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{p.fullName}</span>
                      {p.status === "lead" && <Badge status="pending">{t.patients.statusLead}</Badge>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-ink-500">
                      {p.phone && <span className="num tnum">{formatPhone(p.phone)}</span>}
                      <span>{sourceLabel(p.source)}</span>
                      {p.lastVisitAt && (
                        <span>
                          {t.patients.lastVisit}: {fmtDate(p.lastVisitAt, tz, locale)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="hidden flex-wrap justify-end gap-1 sm:flex">
                    {p.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} status="brand">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title={t.patients.newPatient}>
        <div className="grid gap-4">
          <Field label={t.patients.fullName} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t.patients.phone} hint="0790744070" error={err || undefined}>
            <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+962…" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={submitNew} loading={pending} disabled={!name.trim()}>
              {t.common.create}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
