"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { TAXPAYER_TYPES, type EinvoiceSettingsView } from "@/lib/einvoice/settings";
import { Landmark, ShieldCheck, TriangleAlert } from "lucide-react";

/**
 * A clinic's registration with ISTD.
 *
 * Everything here comes off the JoFotara portal, which is a place the clinic has
 * already had to visit — so the screen's job is mostly to say which field on
 * that site each box wants, in the words the portal uses.
 */
export function EinvoicingForm({
  slug,
  isOwner,
  settings,
  missing,
  stats,
}: {
  slug: string;
  isOwner: boolean;
  settings: EinvoiceSettingsView;
  missing: string[];
  stats: { submitted: number; pending: number; failed: number };
}) {
  const { t } = useI18n();
  const { patch, state } = useAutosave({
    url: `/api/c/${slug}/einvoicing`,
    entityKey: `einv:${slug}`,
  });
  const ro = !isOwner;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [fileByDefault, setFileByDefault] = useState(settings.fileByDefault);
  const [taxpayerType, setTaxpayerType] = useState(settings.taxpayerType);
  const E = t.einvoicing;

  const ready = enabled && missing.length === 0;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Landmark className="h-4 w-4 text-ink-400" />
              {E.title}
            </span>
          }
          sub={E.sub}
          action={<SaveIndicator state={state} />}
        />

        <div className="grid gap-4 p-5">
          <div className="flex items-start gap-3 rounded-lg border border-line bg-sunken p-3.5">
            <Toggle
              checked={enabled}
              disabled={ro}
              label={E.enable}
              onChange={(v) => {
                setEnabled(v);
                patch({ enabled: v });
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{E.enable}</div>
              <p className="mt-0.5 text-[13px] text-ink-500">{E.enableHint}</p>
            </div>
          </div>

          {/*
            Switched on but not usable. Said plainly and early, because the
            alternative is a clinic believing it is filing while every invoice
            quietly stays unreported.
          */}
          {enabled && missing.length > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {E.incomplete}{" "}
                {missing.map((m) => (E.fields as Record<string, string>)[m] ?? m).join("، ")}
              </span>
            </p>
          )}
          {ready && (
            <p className="flex items-center gap-2 rounded-md bg-brand-100 px-3 py-2 text-[13px] text-brand-700">
              <ShieldCheck className="h-4 w-4 shrink-0" />
              {E.ready}
            </p>
          )}

          {/*
            Everything, or one at a time. Shown only once filing is on, because
            until then it is a preference about something that is not happening.
            Either way the invoice itself carries the final answer — this only
            decides which way a new one starts.
          */}
          {enabled && (
            <div className="flex items-start gap-3 rounded-lg border border-line bg-sunken p-3.5">
              <Toggle
                checked={fileByDefault}
                disabled={ro}
                label={E.fileByDefault}
                onChange={(v) => {
                  setFileByDefault(v);
                  patch({ file_by_default: v });
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{E.fileByDefault}</div>
                <p className="mt-0.5 text-[13px] text-ink-500">
                  {fileByDefault ? E.fileByDefaultOnHint : E.fileByDefaultOffHint}
                </p>
              </div>
            </div>
          )}

          <Field label={E.taxpayerType} hint={E.taxpayerTypeHint}>
            <Select
              value={taxpayerType}
              disabled={ro}
              onChange={(e) => {
                const v = e.target.value as (typeof TAXPAYER_TYPES)[number];
                setTaxpayerType(v);
                patch({ taxpayer_type: v });
              }}
            >
              {TAXPAYER_TYPES.map((k) => (
                <option key={k} value={k}>
                  {E.taxpayerTypes[k]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={E.registeredName} hint={E.registeredNameHint}>
              <Input
                defaultValue={settings.registeredName}
                disabled={ro}
                onChange={(e) => patch({ registered_name: e.target.value })}
              />
            </Field>
            <Field label={E.taxNumber}>
              <Input
                dir="ltr"
                defaultValue={settings.taxNumber}
                disabled={ro}
                onChange={(e) => patch({ tax_number: e.target.value })}
              />
            </Field>
          </div>

          {/* Only a sales-tax taxpayer has one; an income taxpayer's portal does
              not even show the field. */}
          {taxpayerType === "general" && (
            <Field label={E.incomeSourceSequence} hint={E.incomeSourceSequenceHint}>
              <Input
                dir="ltr"
                defaultValue={settings.incomeSourceSequence}
                disabled={ro}
                onChange={(e) => patch({ income_source_sequence: e.target.value })}
              />
            </Field>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={E.credentials} sub={E.credentialsHint} />
        <div className="grid gap-4 p-5">
          <Field label={E.clientId}>
            <Input
              dir="ltr"
              defaultValue={settings.clientId}
              disabled={ro}
              onChange={(e) => patch({ client_id: e.target.value })}
            />
          </Field>
          {/*
            Never rendered back. The box is blank whether or not a key is stored,
            and leaving it blank changes nothing — so editing the field above it
            cannot wipe the credential by accident.
          */}
          <Field
            label={E.secretKey}
            hint={settings.hasSecret ? E.secretStored : E.secretHint}
          >
            <Input
              type="password"
              dir="ltr"
              autoComplete="off"
              placeholder={settings.hasSecret ? "••••••••••••" : ""}
              disabled={ro}
              onChange={(e) => patch({ secret_key: e.target.value })}
            />
          </Field>
          <Field label={E.environment} hint={E.environmentHint}>
            <Select
              defaultValue={settings.environment}
              disabled={ro}
              onChange={(e) => patch({ environment: e.target.value })}
            >
              <option value="production">{E.environments.production}</option>
              <option value="sandbox">{E.environments.sandbox}</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={E.activity} />
        <div className="flex flex-wrap gap-4 px-5 py-4 text-sm">
          <span className="flex items-center gap-2">
            <Badge status="confirmed">{stats.submitted}</Badge>
            {E.filed}
          </span>
          <span className="flex items-center gap-2">
            <Badge status="pending">{stats.pending}</Badge>
            {E.inFlight}
          </span>
          <span className="flex items-center gap-2">
            <Badge status={stats.failed > 0 ? "danger" : "neutral"}>{stats.failed}</Badge>
            {E.failed}
          </span>
        </div>
        {settings.lastError && (
          <p className="border-t border-line px-5 py-3 text-[13px] text-danger">
            {E.lastError}: {settings.lastError}
          </p>
        )}
      </Card>
    </div>
  );
}
