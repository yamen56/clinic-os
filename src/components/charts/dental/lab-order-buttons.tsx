"use client";

/*
  Sending the order to the lab (2026-11-26): on WhatsApp, or printed.

  Clinicti writes the order from the chart. WhatsApp opens a chat with the
  lab's number — Settings → Dental labs — with the order written out and the
  link to its PDF, ready to send from the clinic's phone; Print opens the same
  PDF. It carries the teeth, the work and the patient's name: no phone number,
  no medical history, no money. Shown while the work is at the lab, for the
  trip it is on, so a bridge sent back for its porcelain sends that order.
*/

import { MessageCircle, Printer } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { normalizePhone, type CountryCode } from "@/lib/phone";
import { orderMessage, whatsAppLink, type OrderOf } from "@/lib/charts/dental/lab-message";
import type { LabCase, LabRow } from "@/lib/charts/dental/labs";

export function LabOrderButtons({
  c,
  lab,
  order,
  clinic,
  patient,
  country,
  hint = false,
  labels,
}: {
  c: LabCase;
  lab: LabRow | undefined;
  order: OrderOf;
  clinic: string;
  patient: string;
  country: CountryCode;
  /** Say what the lab is sent: on the chart, where the order is written. */
  hint?: boolean;
  /** The buttons' own words, on a page in the clinic's language; then no notes under them. */
  labels?: { whatsapp: string; print: string };
}) {
  const { t } = useI18n();
  const L = t.dental.lab;
  if (!c.orderUrl || c.status === "cancelled") return null;
  const phone = lab?.phone ? normalizePhone(lab.phone, country) : null;
  const text = orderMessage(c, { ...order, clinic, patient }, L.msg);
  const btn = "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[0.78125rem] font-semibold transition-colors duration-140";
  return (
    <div className="grid gap-1" data-lab-order-send={c.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        <a
          href={whatsAppLink(phone, text)}
          target="_blank"
          rel="noopener noreferrer"
          className={`${btn} border-ok/40 bg-surface text-ink-900 hover:bg-sunken`}
          data-lab-whatsapp={c.id}
          data-lab-whatsapp-to={phone ?? ""}
        >
          <MessageCircle className="h-4 w-4 text-ok" />
          {labels?.whatsapp ?? L.whatsapp}
        </a>
        <a href={c.orderUrl} target="_blank" rel="noopener" className={`${btn} border-line-strong bg-surface text-ink-700 hover:bg-sunken`} data-lab-print={c.id}>
          <Printer className="h-4 w-4" />
          {labels?.print ?? L.printOrder}
        </a>
      </div>
      {!labels && !phone && !lab?.inHouse && (
        <p className="text-[0.75rem] text-ink-500" data-lab-no-phone>
          {L.noPhone}
        </p>
      )}
      {hint && <p className="text-[0.75rem] text-ink-500">{L.orderSentHint}</p>}
    </div>
  );
}
