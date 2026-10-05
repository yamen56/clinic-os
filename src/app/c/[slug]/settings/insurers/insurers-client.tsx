"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { saveInsurerAction, deleteInsurerAction } from "./actions";
import { ShieldCheck, Plus, Trash2 } from "lucide-react";

type Insurer = {
  id: string;
  name: string;
  code: string;
  notes: string;
  active: boolean;
  coverage_percent: string | null;
  coverage_cap: string | null;
  patients: number;
  open_claims: number;
};

/** "80% · up to 100 JOD", or nothing when the clinic set no rule. */
function ruleText(i: Insurer, t: ReturnType<typeof useI18n>["t"]): string {
  if (!i.coverage_percent || Number(i.coverage_percent) <= 0) return "";
  const pct = t.insurers.ruleCovers.replace("{pct}", String(Number(i.coverage_percent)));
  return i.coverage_cap !== null && i.coverage_cap !== ""
    ? `${pct} · ${t.insurers.ruleUpTo.replace("{cap}", String(Number(i.coverage_cap)))}`
    : pct;
}

export function InsurersClient({ slug, initial }: { slug: string; initial: Insurer[] }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Insurer | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  // Kept as typed text: an emptied box means "no rule", which a number cannot say.
  const [percent, setPercent] = useState("");
  const [cap, setCap] = useState("");
  const [pending, start] = useTransition();

  const openNew = () => {
    setEditing(null);
    setName("");
    setCode("");
    setPercent("");
    setCap("");
    setOpen(true);
  };
  const openEdit = (i: Insurer) => {
    setEditing(i);
    setName(i.name);
    setCode(i.code);
    setPercent(i.coverage_percent === null ? "" : String(Number(i.coverage_percent)));
    setCap(i.coverage_cap === null ? "" : String(Number(i.coverage_cap)));
    setOpen(true);
  };

  return (
    <>
      <Card>
        <CardHeader
          title={t.insurers.title}
          sub={t.insurers.sub}
          action={
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4" />
              {t.insurers.add}
            </Button>
          }
        />
        {initial.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<ShieldCheck />}
              title={t.insurers.emptyTitle}
              body={t.insurers.emptyBody}
              action={
                <Button onClick={openNew}>
                  <Plus className="h-4 w-4" />
                  {t.insurers.add}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {initial.map((i) => (
              <li
                key={i.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5 ${
                  i.active ? "" : "opacity-60"
                }`}
              >
                <button
                  className="min-w-0 flex-1 text-start hover:underline"
                  onClick={() => openEdit(i)}
                >
                  <span className="block truncate text-sm font-semibold">{i.name}</span>
                  {i.code && (
                    <span className="block truncate text-[13px] text-ink-500" dir="ltr">
                      {i.code}
                    </span>
                  )}
                  {ruleText(i, t) && (
                    <span className="block truncate text-[13px] text-brand-700">{ruleText(i, t)}</span>
                  )}
                </button>
                {i.open_claims > 0 && (
                  <Badge status="pending">
                    {i.open_claims} {t.insurers.openClaims}
                  </Badge>
                )}
                <span className="text-[13px] text-ink-400">
                  {i.patients} {t.insurers.patients}
                </span>
                {!i.active && <Badge status="neutral">{t.insurers.inactive}</Badge>}
                <button
                  aria-label={t.common.delete}
                  className="text-ink-300 hover:text-danger"
                  onClick={() =>
                    start(async () => {
                      await deleteInsurerAction(slug, i.id);
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t.insurers.edit : t.insurers.add}
      >
        <div className="grid gap-4">
          <Field label={t.insurers.name} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          {/* The string reception types into the insurer's own portal, which is
              almost never the same as the display name. */}
          <Field label={t.insurers.code} hint={t.insurers.codeHint}>
            <Input value={code} dir="ltr" onChange={(e) => setCode(e.target.value)} />
          </Field>
          {/*
            The company's standing terms. With them, an insured patient's invoice
            fills in what the company pays; left empty, reception types it as
            before. Two plain boxes, because "80% up to 100" is how a clinic is
            told its terms and how it will want to type them.
          */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t.insurers.coveragePercent} hint={t.insurers.coveragePercentHint}>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step={1}
                dir="ltr"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
            </Field>
            <Field label={t.insurers.coverageCap} hint={t.insurers.coverageCapHint}>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                dir="ltr"
                value={cap}
                disabled={!percent}
                onChange={(e) => setCap(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={pending}
              disabled={!name.trim()}
              onClick={() =>
                start(async () => {
                  const r = await saveInsurerAction(slug, {
                    id: editing?.id,
                    name,
                    code,
                    active: true,
                    coveragePercent: percent.trim() === "" ? null : Number(percent),
                    coverageCap: percent.trim() === "" || cap.trim() === "" ? null : Number(cap),
                  });
                  if (r.error) {
                    return toast(r.error === "invalid_coverage" ? t.insurers.invalidCoverage : t.common.required, "error");
                  }
                  setOpen(false);
                })
              }
            >
              {t.common.save}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
