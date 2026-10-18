"use client";

/*
  Lab work, across the clinic's patients.

  Out: at a lab now, what is late first. Back: what came back this month.
  To pay: an outside lab's work not paid for yet, lab by lab — ticked and
  paid in one go, which records one expense (category Lab) for those cases.
  Received and Mark paid answer the tap at once and are put back if the
  server says no.
*/

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { FlaskConical, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney } from "@/lib/dates";
import { useToast } from "@/components/ui/toast";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { EmptyState, Tabs } from "@/components/ui/misc";
import { isOverdue, type LabCase, type LabRow } from "@/lib/charts/dental/labs";
import { markLabCasesPaidAction } from "./actions";

export type LabWork = LabCase & { patientId: string; patientName: string; label: string; site: string };

type Tab = "out" | "back" | "pay";

export function LabsClient({
  slug,
  currency,
  today,
  labs,
  work: initial,
  canPay,
}: {
  slug: string;
  currency: string;
  today: string;
  labs: LabRow[];
  work: LabWork[];
  canPay: boolean;
}) {
  const { t, locale } = useI18n();
  const L = t.labs;
  const { toast } = useToast();
  const [work, setWork] = useState<LabWork[]>(initial);
  const [tab, setTab] = useState<Tab>("out");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState("transfer");
  const [pending, start] = useTransition();
  const money = (n: number) => fmtMoney(n, currency, locale);
  const labOf = useMemo(() => new Map(labs.map((l) => [l.id, l])), [labs]);

  const out = work.filter((w) => w.status === "sent").sort((a, b) => Number(isOverdue(b, today)) - Number(isOverdue(a, today)));
  const back = work.filter((w) => w.status === "received");
  const toPay = work.filter((w) => w.status !== "cancelled" && !w.paid && !labOf.get(w.labId)?.inHouse);
  const byLab = [...new Set(toPay.map((w) => w.labId))].map((id) => ({ lab: labOf.get(id)!, cases: toPay.filter((w) => w.labId === id) }));

  const received = async (w: LabWork) => {
    setWork((prev) => prev.map((x) => (x.id === w.id ? { ...x, status: "received", receivedAt: new Date().toISOString() } : x)));
    const res = await fetch(`/api/c/${slug}/patients/${w.patientId}/dental/labs/${w.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "received" }),
    }).catch(() => null);
    if (!res?.ok) {
      setWork((prev) => prev.map((x) => (x.id === w.id ? w : x)));
      toast(t.common.genericError, "error");
    }
  };

  const pay = (labId: string) =>
    start(async () => {
      const ids = toPay.filter((w) => w.labId === labId && ticked.has(w.id)).map((w) => w.id);
      if (!ids.length) return;
      const r = await markLabCasesPaidAction(slug, { caseIds: ids, method });
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      setWork((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, paid: true } : x)));
      setTicked(new Set());
      toast(L.paidSaved.replace("{amount}", money(r.amount ?? 0)));
    });

  const row = (w: LabWork, action?: React.ReactNode) => {
    const late = isOverdue(w, today);
    const lab = labOf.get(w.labId);
    return (
      <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3" data-lab-work={w.id} data-overdue={late ? "yes" : "no"}>
        <div className="min-w-[12rem] flex-1">
          <Link href={`/c/${slug}/patients/${w.patientId}?tab=dental`} className="text-[14px] font-semibold text-ink-900 hover:underline">
            {w.patientName}
          </Link>
          <div className="text-[12.5px] text-ink-500">
            <bdi>{w.label}</bdi> · {/^[1-8][1-8]$/.test(w.site) ? L.tooth.replace("{n}", w.site) : w.site} · {lab?.name ?? "—"}
            {lab?.inHouse ? ` · ${L.inHouse}` : ""}
          </div>
        </div>
        <div className="text-[12.5px] text-ink-500 tnum">
          {L.sentOn.replace("{date}", fmtDateOnly(w.sentOn, locale))}
          {w.status === "sent" && w.dueOn && (
            <span className={late ? "ms-2 font-semibold text-danger" : "ms-2"}>
              {(late ? L.lateSince : L.dueOn).replace("{date}", fmtDateOnly(w.dueOn, locale))}
            </span>
          )}
          {w.status === "received" && w.receivedAt && <span className="ms-2">{L.backOn.replace("{date}", fmtDateOnly(w.receivedAt.slice(0, 10), locale))}</span>}
        </div>
        <div className="w-24 text-end text-[13px] font-semibold tnum">{money(w.cost)}</div>
        {action}
      </li>
    );
  };

  return (
    <>
      <PageHeader title={L.title} sub={L.sub} />
      <Card>
        <div className="px-2 pt-1">
          <Tabs
            tabs={[
              { key: "out", label: L.out, count: out.length },
              { key: "back", label: L.back },
              ...(canPay ? [{ key: "pay", label: L.toPay, count: toPay.length }] : []),
            ]}
            active={tab}
            onChange={(k) => setTab(k as Tab)}
          />
        </div>
        {tab === "out" &&
          (out.length ? (
            <ul className="divide-y divide-line" data-lab-out>
              {out.map((w) =>
                row(
                  w,
                  <Button size="sm" variant="soft" onClick={() => void received(w)} data-lab-received={w.id}>
                    <Check className="h-4 w-4" />
                    {L.received}
                  </Button>
                )
              )}
            </ul>
          ) : (
            <EmptyState icon={<FlaskConical className="h-6 w-6" />} title={L.noneOut} body={L.noneOutBody} />
          ))}
        {tab === "back" &&
          (back.length ? (
            <ul className="divide-y divide-line" data-lab-back>
              {back.map((w) => row(w))}
            </ul>
          ) : (
            <EmptyState icon={<FlaskConical className="h-6 w-6" />} title={L.noneBack} />
          ))}
        {tab === "pay" &&
          canPay &&
          (byLab.length ? (
            <div className="grid gap-4 p-4" data-lab-pay>
              {byLab.map(({ lab, cases }) => {
                const mine = cases.filter((w) => ticked.has(w.id));
                const total = mine.reduce((s, w) => s + w.cost, 0);
                return (
                  <section key={lab.id} className="rounded-card border border-line" data-lab-pay-group={lab.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                      <h3 className="text-[15px] font-semibold">{lab.name}</h3>
                      <span className="text-[13px] text-ink-500 tnum">{L.owed.replace("{amount}", money(cases.reduce((s, w) => s + w.cost, 0)))}</span>
                    </div>
                    <ul className="divide-y divide-line">
                      {cases.map((w) =>
                        row(
                          w,
                          <input
                            type="checkbox"
                            className="h-5 w-5"
                            aria-label={L.tick}
                            checked={ticked.has(w.id)}
                            onChange={(e) =>
                              setTicked((prev) => {
                                const n = new Set(prev);
                                if (e.target.checked) n.add(w.id);
                                else n.delete(w.id);
                                return n;
                              })
                            }
                            data-lab-tick={w.id}
                          />
                        )
                      )}
                    </ul>
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
                      <button
                        type="button"
                        className="me-auto text-[12.5px] font-semibold text-brand-700 hover:underline"
                        onClick={() => setTicked((prev) => new Set([...prev, ...cases.map((w) => w.id)]))}
                      >
                        {L.tickAll}
                      </button>
                      <Select value={method} onChange={(e) => setMethod(e.target.value)} aria-label={t.invoices.method} className="w-36">
                        {Object.entries(t.expenses.methods).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </Select>
                      <Button onClick={() => pay(lab.id)} loading={pending} disabled={!mine.length} data-lab-pay-button={lab.id}>
                        {mine.length ? L.payN.replace("{amount}", money(total)) : L.pay}
                      </Button>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={<FlaskConical className="h-6 w-6" />} title={L.nothingOwed} />
          ))}
      </Card>
    </>
  );
}
