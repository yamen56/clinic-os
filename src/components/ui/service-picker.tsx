"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Input, Select } from "@/components/ui/input";
import {
  groupBySection,
  serviceLabel,
  type SectionLike,
  type SectionRow,
  type ServiceLike,
  type ServiceRow,
} from "@/lib/services";
import { Plus, Search } from "lucide-react";

/**
 * Picking a service, in the three shapes the app actually needs.
 *
 * There were six hand-rolled service pickers before this, no two alike, and the
 * label expression `locale === "ar" ? name_ar || name : name` was written out in
 * four of them. That is why sections reached some screens and not others: there
 * was no one place to add them to.
 *
 * All three degrade to a flat list when the clinic has no sections, which is
 * the invariant 0047 set and `qa-service-sections` checks first.
 */

type Common = {
  services: ServiceLike[];
  sections: SectionLike[];
};

/** A grouped `<select>`. The calendar, the appointment panel and the waitlist. */
export function ServiceSelect({
  services,
  sections,
  value,
  onChange,
  emptyLabel,
  id,
}: Common & {
  value: string;
  onChange: (serviceId: string) => void;
  /** The "no service" option. Omit it to require a choice. */
  emptyLabel?: string;
  id?: string;
}) {
  const { t, locale } = useI18n();
  const groups = useMemo(() => groupBySection(services, sections), [services, sections]);

  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {/*
        One <optgroup> wrapped around everything is a heading that separates
        nothing, so a clinic with no sections gets bare options.
      */}
      {groups.length === 1 && groups[0].section === null
        ? groups[0].services.map((s) => (
            <option key={s.id} value={s.id}>
              {serviceLabel(s, locale)}
            </option>
          ))
        : groups.map((g) => (
            <optgroup key={g.section?.id ?? "__unfiled"} label={g.section ? serviceLabel(g.section, locale) : t.sections.unfiled}>
              {g.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {serviceLabel(s, locale)}
                </option>
              ))}
            </optgroup>
          ))}
    </Select>
  );
}

/**
 * A multi-select of services, grouped under section headings.
 *
 * The booking link's "only these services", the booking question's "only for
 * these", and a document template's attached services — all three were the same
 * flat row of chips.
 */
export function ServiceChips({
  services,
  sections,
  selected,
  onToggle,
}: Common & {
  selected: string[];
  onToggle: (serviceId: string) => void;
}) {
  const { t, locale } = useI18n();
  const groups = useMemo(() => groupBySection(services, sections), [services, sections]);
  const on = useMemo(() => new Set(selected), [selected]);

  return (
    <div className="grid gap-2.5">
      {groups.map((g) => (
        <div key={g.section?.id ?? "__unfiled"}>
          {g.section !== null && (
            <div className="mb-1.5 flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: g.section.color }}
              />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                {serviceLabel(g.section, locale)}
              </span>
            </div>
          )}
          {g.section === null && groups.length > 1 && (
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
              {t.sections.unfiled}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {g.services.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onToggle(s.id)}
                className={`rounded-full border px-3 py-1 text-[12px] font-medium transition ${
                  on.has(s.id)
                    ? "border-brand-400 bg-brand-50 text-brand-700"
                    : "border-line-strong text-ink-500 hover:border-brand-400"
                }`}
              >
                {serviceLabel(s, locale)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Add-a-line, for the invoice builder.
 *
 * This replaces `services.slice(0, 6)` rendered as chips, which is the reason
 * it exists: a clinic with more than six services could not reach the seventh
 * except by typing it free-hand, and a free-typed line carries no `service_id`
 * — so that money then disappeared from the revenue-by-service and
 * revenue-by-section charts. Every service is reachable here, and the search
 * appears only when there are enough of them to need it.
 */
export function ServiceAddMenu({
  services,
  sections,
  onPick,
  onCustom,
  currency,
}: {
  /* The full row here, unlike the two pickers above: this one shows the price,
     and seeds a line with it. */
  services: ServiceRow[];
  sections: SectionRow[];
  onPick: (service: ServiceRow) => void;
  onCustom: () => void;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return services;
    return services.filter((s) =>
      `${s.name} ${s.name_ar ?? ""}`.toLowerCase().includes(needle)
    );
  }, [services, q]);
  const groups = useMemo(() => groupBySection(filtered, sections), [filtered, sections]);

  return (
    <div className="grid gap-2">
      {services.length > 8 && (
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.invoices.searchServices}
            className="ps-8"
          />
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-ink-400">{t.common.noResults}</p>
        ) : (
          groups.map((g) => (
            <div key={g.section?.id ?? "__unfiled"}>
              {(g.section !== null || groups.length > 1) && (
                <div className="sticky top-0 flex items-center gap-1.5 border-b border-line bg-sunken px-3 py-1.5">
                  {g.section && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: g.section.color }}
                    />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    {g.section ? serviceLabel(g.section, locale) : t.sections.unfiled}
                  </span>
                </div>
              )}
              {g.services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-[13px] hover:bg-sunken"
                >
                  <span className="truncate">{serviceLabel(s, locale)}</span>
                  <span className="shrink-0 tabular-nums text-[12px] text-ink-400">
                    {Number(s.price).toFixed(2)} {currency}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      <button
        type="button"
        onClick={onCustom}
        className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong px-3 py-2 text-[12px] font-medium text-ink-500 hover:border-brand-400"
      >
        <Plus className="h-3 w-3" />
        {t.invoices.freeItem}
      </button>
    </div>
  );
}
