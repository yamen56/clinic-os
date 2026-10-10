"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AudioWaveform, FlaskConical, Gauge, HeartPulse, Microscope, ScanEye, Ban, Box, Camera, Check, Copy, Cpu, FolderOpen, KeyRound, Network, Pencil, Plus, Radiation, ScanLine, ScanText, Settings2, Terminal } from "lucide-react";
import { BRIDGE_VERSION } from "@/lib/imaging/bridge-version";
import { ConnectWizard } from "./connect-wizard";
import { bridgeOffline } from "@/lib/imaging/offline";
import { orderedKinds, type DeviceKind } from "@/lib/imaging/kinds";
import { useI18n } from "@/lib/i18n/client";
import { fmtRelative } from "@/lib/dates";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState, Tabs } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";

/** What the Clinicti Bridge last said about itself (its heartbeat). */
export type BridgeReport = {
  version?: string;
  host?: string;
  lan?: string[];
  folders?: { path: string; ok: boolean; error?: string }[];
  dicom?: { enabled: boolean; port: number; aet: string; listening: boolean; error: string | null; lastEcho: number | null; lastStore: number | null };
  queued?: number;
  failed?: number;
  at?: string;
};

export type DeviceRow = {
  id: string;
  name: string;
  kind: Kind;
  match_by: MatchBy;
  method: "bridge" | "api";
  key_hint: string;
  created_at: string;
  last_seen_at: string | null;
  images_received: number;
  revoked_at: string | null;
  paired_at: string | null;
  pair_expires_at: string | null;
  bridge: BridgeReport | null;
};

export type Kind = DeviceKind;
const MATCH = ["none", "clinicti", "national_id"] as const;
type MatchBy = (typeof MATCH)[number];

const KIND_ICON: Record<Kind, typeof Radiation> = {
  xray: Radiation,
  opg: ScanLine,
  cbct: Box,
  camera: Camera,
  scanner: ScanText,
  ultrasound: AudioWaveform,
  ecg: HeartPulse,
  endoscope: Microscope,
  eye: ScanEye,
  monitor: Gauge,
  lab: FlaskConical,
  other: Cpu,
};

/** "1.0.0" < "1.2.0", numerically. */
function older(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** What to paste where, with this device's key already in it. */
function snippets(base: string, key: string) {
  return {
    orthanc: `{
  "DicomWeb": {
    "Enable": true,
    "Servers": {
      "clinicti": {
        "Url": "${base}/api/devices/v1/dicomweb/",
        "HttpHeaders": { "Authorization": "Bearer ${key}" }
      }
    }
  },
  "StableAge": 5,
  "LuaScripts": ["clinicti.lua"]
}`,
    lua: `-- clinicti.lua: forward every series the machine sends to Clinicti
function OnStableSeries(seriesId, tags, metadata)
  RestApiPost('/dicom-web/servers/clinicti/stow',
              '{"Resources":["' .. seriesId .. '"]}')
end`,
    curl: `curl -H "Authorization: Bearer ${key}" \\
     -F file=@image.dcm -F patient=1042 \\
     ${base}/api/devices/v1/images

# Is the key right?
curl -H "Authorization: Bearer ${key}" ${base}/api/devices/v1/me`,
  };
}

function Code({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3" dir="ltr">
      {label && <div className="mb-1 font-mono text-[11px] font-semibold text-ink-500">{label}</div>}
      {/* The button's own class positions it `relative`, so the corner is held by a wrapper. */}
      <div className="relative">
        <pre className="max-w-full overflow-x-auto rounded-lg border border-line bg-ink-900/4 p-3 pe-24 font-mono text-[12px] leading-relaxed text-ink-900">
          {text}
        </pre>
        <span className="absolute end-2 top-2">
          <button
            type="button"
            className={buttonClass({ variant: "outline", size: "sm", className: "bg-surface" })}
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t.devices.copied : t.devices.copy}
          </button>
        </span>
      </div>
    </div>
  );
}

function Setup({ slug, base, keyText }: { slug: string; base: string; keyText: string }) {
  const { t } = useI18n();
  const T = t.devices;
  const [tab, setTab] = useState("folder");
  const s = snippets(base, keyText);
  return (
    <div data-device-setup>
      <Tabs
        tabs={[
          { key: "folder", label: T.setupFolderTitle },
          { key: "dicom", label: T.setupDicomTitle },
          { key: "api", label: T.setupApiTitle },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="pt-3 text-sm text-ink-700">
        {tab === "folder" && (
          <>
            <p>{T.setupFolderBody}</p>
            <Link href={`/c/${slug}/devices`} className={buttonClass({ variant: "soft", size: "sm", className: "mt-3" })}>
              <FolderOpen className="h-4 w-4" />
              {T.openImaging}
            </Link>
          </>
        )}
        {tab === "dicom" && (
          <>
            <p>{T.setupDicomBody}</p>
            <Code label="orthanc.json" text={s.orthanc} />
            <Code label="clinicti.lua" text={s.lua} />
          </>
        )}
        {tab === "api" && (
          <>
            <p>{T.setupApiBody}</p>
            <Code text={s.curl} />
          </>
        )}
      </div>
    </div>
  );
}

export function DevicesClient({ slug, base, initial, usual }: { slug: string; base: string; initial: DeviceRow[]; usual: DeviceKind[] }) {
  const { t, locale } = useI18n();
  const T = t.devices;
  const { toast } = useToast();
  // The clock, read in the browser only: "offline" decided on the server would disagree with the page.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const [devices, setDevices] = useState(initial);
  const [form, setForm] = useState<{ id: string | null; name: string; kind: Kind; matchBy: MatchBy } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const [confirm, setConfirm] = useState<{ op: "rekey" | "revoke"; device: DeviceRow } | null>(null);
  const [wizard, setWizard] = useState<{ existing: DeviceRow | null } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const openApiForm = () => {
    setWizard(null);
    setAdvanced(true);
    setForm({ id: null, name: "", kind: usual[0] ?? "other", matchBy: "none" });
  };

  async function call(url: string, method: string, body: unknown) {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { device?: DeviceRow; key?: string; error?: string } | null;
    if (!res.ok || !json?.device) throw new Error(json?.error ?? "failed");
    return json as { device: DeviceRow; key?: string };
  }

  function put(d: DeviceRow) {
    setDevices((prev) => (prev.some((x) => x.id === d.id) ? prev.map((x) => (x.id === d.id ? d : x)) : [...prev, d]));
  }

  async function save() {
    if (!form || !form.name.trim()) return;
    setBusy(true);
    try {
      if (form.id) {
        const r = await call(`/api/c/${slug}/devices/${form.id}`, "PATCH", { op: "update", name: form.name, matchBy: form.matchBy });
        put(r.device);
      } else {
        const r = await call(`/api/c/${slug}/devices`, "POST", { name: form.name, kind: form.kind, matchBy: form.matchBy });
        put(r.device);
        if (r.key) setShown({ name: r.device.name, key: r.key });
      }
      setForm(null);
    } catch (e) {
      toast((e as Error).message === "too_many" ? T.tooMany : T.failed, "error");
    } finally {
      setBusy(false);
    }
  }

  async function act() {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await call(`/api/c/${slug}/devices/${confirm.device.id}`, "PATCH", { op: confirm.op });
      put(r.device);
      if (r.key) setShown({ name: r.device.name, key: r.key });
      setConfirm(null);
    } catch {
      toast(T.failed, "error");
    } finally {
      setBusy(false);
    }
  }

  const active = devices.filter((d) => !d.revoked_at);
  const revoked = devices.filter((d) => d.revoked_at);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={T.title}
          sub={T.sub}
          action={
            <Button size="sm" onClick={() => setWizard({ existing: null })} data-connect-machine>
              <Plus className="h-4 w-4" />
              {T.connect}
            </Button>
          }
        />
        {devices.length === 0 ? (
          <EmptyState bare icon={<Network />} title={T.empty} />
        ) : (
          <ul className="divide-y divide-line" data-devices>
            {[...active, ...revoked].map((d) => {
              const Icon = KIND_ICON[d.kind] ?? Cpu;
              return (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5" data-device={d.id} data-revoked={d.revoked_at ? "" : undefined}>
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${d.revoked_at ? "bg-ink-900/4 text-ink-400" : "bg-brand-100 text-brand-700"}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${d.revoked_at ? "text-ink-500 line-through" : "text-ink-900"}`}>{d.name}</span>
                      <span className="text-xs text-ink-500">{T.kinds[d.kind]}</span>
                      {d.revoked_at ? (
                        <Badge status="danger">{T.revoked}</Badge>
                      ) : bridgeOffline(d, now) ? (
                        <Badge status="danger" dot>
                          <span data-device-offline>{T.bridgeOffline.replace("{t}", fmtRelative(d.last_seen_at!, locale))}</span>
                        </Badge>
                      ) : d.last_seen_at ? (
                        <Badge status="ok" dot>
                          {/* A clock-relative phrase: the server's second and the browser's differ. */}
                          <span suppressHydrationWarning>{T.lastSeen.replace("{t}", fmtRelative(d.last_seen_at, locale))}</span>
                        </Badge>
                      ) : (
                        <Badge status="pending">{T.neverSeen}</Badge>
                      )}
                    </div>
                    {d.method === "bridge" ? (
                      <BridgeLine d={d} />
                    ) : (
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-500">
                        <span>{T.apiKey}</span>
                        <span>{T.matchByOptions[d.match_by]}</span>
                        <span dir="ltr">{T.keyHint.replace("{hint}", d.key_hint)}</span>
                        <span>{T.received.replace("{n}", String(d.images_received))}</span>
                      </div>
                    )}
                  </div>
                  {!d.revoked_at && (
                    <div className="flex flex-wrap gap-1.5">
                      {d.method === "bridge" && (
                        <Button size="sm" variant="outline" onClick={() => setWizard({ existing: d })} data-device-setup-open>
                          <Settings2 className="h-4 w-4" />
                          {T.setupAgain}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setForm({ id: d.id, name: d.name, kind: d.kind, matchBy: d.match_by })}>
                        <Pencil className="h-4 w-4" />
                        {T.edit}
                      </Button>
                      {d.method === "api" && (
                        <Button size="sm" variant="ghost" onClick={() => setConfirm({ op: "rekey", device: d })} data-rekey>
                          <KeyRound className="h-4 w-4" />
                          {T.rekey}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setConfirm({ op: "revoke", device: d })} data-revoke>
                        <Ban className="h-4 w-4" />
                        {T.revoke}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* The engineer's routes — Orthanc, a PACS, a script — out of the doctor's way. */}
      <Card>
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex w-full items-center justify-between px-5 py-4 text-start" aria-expanded={advanced} data-advanced>
          <span className="font-display text-base font-semibold text-ink-900">{T.advancedTitle}</span>
          <span className="text-ink-400">{advanced ? "−" : "+"}</span>
        </button>
        {advanced && (
          <div className="border-t border-line px-5 py-4">
            <Setup slug={slug} base={base} keyText="<device key>" />
            <Button size="sm" variant="outline" className="mt-4" onClick={openApiForm} data-add-device>
              <KeyRound className="h-4 w-4" />
              {T.add} · {T.apiKey}
            </Button>
          </div>
        )}
      </Card>

      {wizard && (
        <ConnectWizard
          usual={usual}
          slug={slug}
          base={base}
          existing={wizard.existing}
          onDevice={put}
          onClose={() => setWizard(null)}
          onApi={openApiForm}
        />
      )}

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? T.edit : T.add}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setForm(null)}>
              {T.cancel}
            </Button>
            <Button onClick={save} loading={busy} disabled={!form?.name.trim()} data-save-device>
              {form?.id ? T.save : T.create}
            </Button>
          </div>
        }
      >
        {form && (
          <div className="space-y-4" data-device-form>
            <Field label={T.name} required>
              <Input
                value={form.name}
                maxLength={60}
                placeholder={T.namePlaceholder}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-device-name
              />
            </Field>
            {!form.id && (
              <Field label={T.kind}>
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })} data-device-kind>
                  {orderedKinds(usual).map((k) => (
                    <option key={k} value={k}>
                      {T.kinds[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={T.matchBy} hint={T.matchByHelp[form.matchBy]}>
              <Select value={form.matchBy} onChange={(e) => setForm({ ...form, matchBy: e.target.value as MatchBy })} data-device-match>
                {MATCH.map((m) => (
                  <option key={m} value={m}>
                    {T.matchByOptions[m]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={!!shown}
        onClose={() => setShown(null)}
        wide
        title={shown ? T.keyTitle.replace("{name}", shown.name) : ""}
        footer={
          <div className="flex justify-end">
            <Button onClick={() => setShown(null)} data-key-done>
              {T.done}
            </Button>
          </div>
        }
      >
        {shown && (
          <div className="space-y-4">
            <p className="flex items-start gap-2 rounded-lg bg-st-pending-soft px-3 py-2 text-sm text-ink-900">
              <Terminal className="mt-0.5 h-4 w-4 shrink-0" />
              {T.keyOnce}
            </p>
            <div data-device-key={shown.key}>
              <Code text={shown.key} />
            </div>
            <Setup slug={slug} base={base} keyText={shown.key} />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={act}
        loading={busy}
        title={confirm ? (confirm.op === "rekey" ? T.rekey : T.revoke) : ""}
        body={confirm ? (confirm.op === "rekey" ? T.rekeyConfirm : T.revokeConfirm).replace("{name}", confirm.device.name) : ""}
        confirmLabel={confirm?.op === "rekey" ? T.rekey : T.revoke}
        cancelLabel={T.cancel}
        danger={confirm?.op === "revoke"}
      />
    </div>
  );
}

/** A Bridge device, in one line: where it runs, what it is doing, whether it needs anything. */
function BridgeLine({ d }: { d: DeviceRow }) {
  const { t } = useI18n();
  const T = t.devices;
  const b = d.bridge;
  if (!d.paired_at) return <div className="mt-0.5 text-xs text-ink-500">{T.bridgeNotPaired}</div>;
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500" data-bridge-line>
      <span>{T.bridgeOn.replace("{host}", b?.host || "—")}</span>
      {b?.folders?.some((f) => f.ok) && <span>{T.folderWatched}</span>}
      {b?.dicom?.enabled && b.dicom.listening && (
        <span dir="ltr">{T.dicomAt.replace("{ip}", b.lan?.[0] ?? "—").replace("{port}", String(b.dicom.port))}</span>
      )}
      {!!b?.queued && <span className="font-semibold text-warning">{T.bridgeQueued.replace("{n}", String(b.queued))}</span>}
      {older(b?.version, BRIDGE_VERSION) && <span className="font-semibold text-brand-700">{T.bridgeUpdate}</span>}
      <span>{T.received.replace("{n}", String(d.images_received))}</span>
    </div>
  );
}

