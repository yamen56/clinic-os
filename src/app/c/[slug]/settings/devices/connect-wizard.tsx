"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Camera, Circle, CircleCheck, Download, FolderOpen, LoaderCircle, ScanLine, ScanText, Usb } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { orderedKinds } from "@/lib/imaging/kinds";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { BridgeReport, DeviceRow, Kind } from "./devices-client";

/**
 * "Connect a machine": the doctor's way in, start to finish, with no IT
 * person. Pick what kind of machine; name it; install the Bridge on the
 * computer beside it and type the code it asks for; point the machine (or
 * the Bridge) at the right place; take a test picture. Each step turns green
 * by itself as the Bridge reports in, so the doctor always knows which step
 * they are on and whether it worked.
 */

type Choice = "folder" | "dicom" | "files";
type LastImage = { at: string; file_name: string; patient: string | null; inbox: boolean } | null;

/*
  Which machine types each way of connecting usually means, in order; the
  first one the clinic's specialties name is the default. A cardiology clinic
  choosing "software that saves files" starts on ECG, a dental one on x-ray.
*/
const TYPICAL: Record<Choice, Kind[]> = {
  folder: ["xray", "ecg", "eye", "ultrasound", "endoscope", "monitor", "lab", "scanner", "camera"],
  dicom: ["opg", "cbct", "xray", "ultrasound", "eye", "ecg"],
  files: ["scanner", "monitor", "lab", "endoscope", "other"],
};
const defaultKind = (c: Choice, usual: readonly Kind[]): Kind => TYPICAL[c].find((k) => usual.includes(k)) ?? TYPICAL[c][0];

export function choiceFor(d: DeviceRow): Choice {
  return d.kind === "opg" || d.kind === "cbct" || d.bridge?.dicom?.lastEcho || d.bridge?.dicom?.lastStore
    ? "dicom"
    : d.kind === "scanner" || d.kind === "monitor" || d.kind === "lab" || d.kind === "other"
      ? "files"
      : "folder";
}

export function ConnectWizard({
  slug,
  base,
  existing,
  existingCode,
  onDevice,
  onClose,
  onApi,
  usual,
}: {
  slug: string;
  /** The machines the clinic's specialties usually connect, offered first. */
  usual: Kind[];
  base: string;
  /** Reopened from a device's Setup button, at its checklist. */
  existing: DeviceRow | null;
  existingCode?: string | null;
  onDevice: (d: DeviceRow) => void;
  onClose: () => void;
  onApi: () => void;
}) {
  const { t } = useI18n();
  const T = t.devices;
  const { toast } = useToast();
  const [step, setStep] = useState<"choose" | "camera" | "name" | "checklist">(existing ? "checklist" : "choose");
  const [choice, setChoice] = useState<Choice>(existing ? choiceFor(existing) : "folder");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("xray");
  const [device, setDevice] = useState<DeviceRow | null>(existing);
  const [code, setCode] = useState<string | null>(existingCode ?? null);
  const [lastImage, setLastImage] = useState<LastImage>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The Bridge reports every few seconds; so does this screen.
  useEffect(() => {
    if (step !== "checklist" || !device) return;
    let stop = false;
    const look = async () => {
      try {
        const res = await fetch(`/api/c/${slug}/devices/${device.id}`, { cache: "no-store" });
        const body = (await res.json()) as { device?: DeviceRow; lastImage?: LastImage };
        if (stop || !body.device) return;
        setDevice(body.device);
        setLastImage(body.lastImage ?? null);
        onDevice(body.device);
      } catch {
        // next look
      }
    };
    void look();
    const id = setInterval(look, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, device?.id, slug]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const pick = (c: Choice) => {
    setChoice(c);
    const k = defaultKind(c, usual);
    setKind(k);
    setName(T.kinds[k]);
    setStep("name");
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/devices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind, method: "bridge" }),
      });
      const body = (await res.json()) as { device?: DeviceRow; pairCode?: string; error?: string };
      if (!res.ok || !body.device) throw new Error(body.error ?? "failed");
      setDevice(body.device);
      setCode(body.pairCode ?? null);
      setNow(Date.now());
      onDevice(body.device);
      setStep("checklist");
    } catch (e) {
      toast((e as Error).message === "too_many" ? T.tooMany : T.failed, "error");
    } finally {
      setBusy(false);
    }
  };

  const newCode = async () => {
    if (!device) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/devices/${device.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "pair" }),
      });
      const body = (await res.json()) as { device?: DeviceRow; pairCode?: string };
      if (!res.ok || !body.device) throw new Error("failed");
      setDevice(body.device);
      setCode(body.pairCode ?? null);
      setNow(Date.now());
      onDevice(body.device);
    } catch {
      toast(T.failed, "error");
    } finally {
      setBusy(false);
    }
  };

  const b: BridgeReport | null = device?.bridge ?? null;
  // Paired since the code was made — an older pairing does not count while a new code is waiting.
  const paired = !!device?.paired_at && !(code && device.pair_expires_at);
  const minutesLeft = device?.pair_expires_at ? Math.max(0, Math.round((Date.parse(device.pair_expires_at) - now) / 60_000)) : 0;
  const folderOk = !!b?.folders?.some((f) => f.ok);
  const machineOk = !!(b?.dicom?.lastEcho || b?.dicom?.lastStore);
  const pointed = choice === "dicom" ? machineOk : folderOk;
  const pictured = !!lastImage;
  const pageUrl = `${base}/c/${slug}/settings/devices`;

  const title =
    step === "choose" ? T.connect : step === "camera" ? T.cameraTitle : step === "name" ? T.nameTitle : device ? device.name : T.connect;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={title}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          {step === "name" || step === "camera" ? (
            <Button variant="ghost" onClick={() => setStep("choose")}>
              <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
              {T.back}
            </Button>
          ) : (
            <span />
          )}
          {step === "name" ? (
            <Button onClick={create} loading={busy} disabled={!name.trim()} data-wizard-create>
              {T.next}
            </Button>
          ) : (
            <Button variant={step === "checklist" && paired && pointed && pictured ? "primary" : "outline"} onClick={onClose} data-wizard-close>
              {step === "checklist" && paired && pointed && pictured ? t.devices.done : T.close}
            </Button>
          )}
        </div>
      }
    >
      <div data-connect-wizard data-step={step}>
        {step === "choose" && (
          <div>
            <p className="mb-3 text-sm text-ink-700">{T.whatTitle}</p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Tile icon={<Usb />} title={T.choiceCamera} body={T.choiceCameraBody} onClick={() => setStep("camera")} id="camera" />
              <Tile icon={<FolderOpen />} title={T.choiceFolder} body={T.choiceFolderBody} onClick={() => pick("folder")} id="folder" />
              <Tile icon={<ScanLine />} title={T.choiceDicom} body={T.choiceDicomBody} onClick={() => pick("dicom")} id="dicom" />
              <Tile icon={<ScanText />} title={T.choiceFiles} body={T.choiceFilesBody} onClick={() => pick("files")} id="files" />
            </div>
            <button type="button" onClick={onApi} className="mt-4 text-[13px] text-ink-500 underline hover:text-ink-700">
              {T.orApi}
            </button>
          </div>
        )}

        {step === "camera" && (
          <ol className="grid gap-3">
            {[T.cameraStep1, T.cameraStep2, T.cameraStep3].map((s, i) => (
              <li key={i} className="flex gap-3 text-sm text-ink-900">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-100 text-[13px] font-bold text-brand-700">{i + 1}</span>
                <span className="pt-0.5">{s}</span>
              </li>
            ))}
            <li className="mt-2 flex items-center gap-2 text-[13px] text-ink-500">
              <Camera className="h-4 w-4" />
              {T.choiceCameraBody}
            </li>
          </ol>
        )}

        {step === "name" && (
          <div className="grid gap-4">
            <Field label={T.name} hint={T.nameHelp} required>
              <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus data-wizard-name />
            </Field>
            <Field label={T.kind}>
              <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} data-wizard-kind>
                {orderedKinds(usual).map((k) => (
                  <option key={k} value={k}>
                    {T.kinds[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {step === "checklist" && device && (
          <ol className="grid gap-3">
            <Step n={1} done={paired} title={T.stepInstall} hook="install">
              {paired ? (
                <p className="text-sm text-st-confirmed" data-paired-host>
                  {T.pairedOn.replace("{host}", b?.host || "—")}
                </p>
              ) : (
                <div className="grid gap-3 text-sm text-ink-700">
                  <p>
                    {T.installHelp}{" "}
                    <span dir="ltr" className="break-all font-mono text-[12.5px] text-ink-900">
                      {pageUrl}
                    </span>
                  </p>
                  <div>
                    <a href={`/api/c/${slug}/devices/bridge`} className={buttonClass({ variant: "primary", size: "md" })} data-download-bridge>
                      <Download className="h-4 w-4" />
                      {T.download}
                    </a>
                  </div>
                  <p>{T.openFile}</p>
                  <p>{T.typeCode}</p>
                  {code && minutesLeft > 0 ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <span dir="ltr" className="rounded-xl border border-line bg-canvas px-4 py-2 font-mono text-3xl font-bold tracking-[0.2em] text-ink-900" data-pair-code={code}>
                        {code}
                      </span>
                      <span className="text-[13px] text-ink-500">{T.codeExpires.replace("{m}", String(minutesLeft))}</span>
                    </div>
                  ) : (
                    <p className="text-[13px] text-ink-500">{code ? T.codeExpired : ""}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center gap-2 text-[13px] text-ink-500">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      {T.waitingPair}
                    </span>
                    <Button size="sm" variant="ghost" onClick={newCode} loading={busy} data-new-code>
                      {T.newCode}
                    </Button>
                  </div>
                </div>
              )}
            </Step>

            {choice === "dicom" ? (
              <Step n={2} done={machineOk} title={T.stepDicom} hook="dicom" dim={!paired}>
                <div className="grid gap-2.5 text-sm text-ink-700">
                  <p>{T.dicomHelp}</p>
                  {paired && b?.dicom ? (
                    <dl dir="ltr" className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1 rounded-xl bg-canvas px-4 py-3" data-dicom-destination>
                      <dt className="text-ink-500">{T.address}</dt>
                      <dd className="font-mono text-base font-semibold text-ink-900">{b.lan?.length ? b.lan.join("  /  ") : "—"}</dd>
                      <dt className="text-ink-500">{T.port}</dt>
                      <dd className="font-mono text-base font-semibold text-ink-900">{b.dicom.port}</dd>
                      <dt className="text-ink-500">{T.aet}</dt>
                      <dd className="font-mono text-base font-semibold text-ink-900">{b.dicom.aet}</dd>
                    </dl>
                  ) : (
                    <p className="rounded-xl bg-canvas px-4 py-3 text-[13px] text-ink-500">{T.afterPair}</p>
                  )}
                  <p className="text-[13px] text-ink-500">{T.worklistHelp}</p>
                  <p>{T.pressTest}</p>
                  <Status ok={machineOk} hook="echo" text={machineOk ? T.echoOk : T.waitingEcho} />
                  {!machineOk && paired && <p className="text-[13px] text-ink-500">{T.firewallHint}</p>}
                </div>
              </Step>
            ) : (
              <Step n={2} done={folderOk} title={T.stepFolder} hook="folder" dim={!paired}>
                <div className="grid gap-2.5 text-sm text-ink-700">
                  <p>{T.folderHelp}</p>
                  {(b?.folders ?? []).map((f) => (
                    <Status key={f.path} ok={f.ok} hook="watching" text={(f.ok ? T.watching : T.folderMissing).replace("{path}", f.path)} />
                  ))}
                  {!b?.folders?.length && <Status ok={false} hook="watching" text={T.waitingFolder} />}
                  <p className="text-[13px] text-ink-500">
                    {T.noInstall}{" "}
                    <Link href={`/c/${slug}/devices`} className="font-semibold text-brand-700 underline">
                      {T.openImaging}
                    </Link>
                  </p>
                </div>
              </Step>
            )}

            <Step n={3} done={pictured} title={T.stepTest} hook="test" dim={!paired}>
              <div className="grid gap-2.5 text-sm text-ink-700">
                <p>{T.testHelp}</p>
                <Status
                  ok={pictured}
                  hook="arrived"
                  text={
                    lastImage
                      ? (lastImage.inbox ? T.arrivedInbox : T.arrivedPatient).replace("{name}", lastImage.file_name).replace("{patient}", lastImage.patient ?? "")
                      : T.waitingImage
                  }
                />
                {pictured && paired && pointed && <p className="font-semibold text-st-confirmed" data-all-set>{T.allSet}</p>}
              </div>
            </Step>
          </ol>
        )}
      </div>
    </Modal>
  );
}

function Tile({ icon, title, body, onClick, id }: { icon: React.ReactNode; title: string; body: string; onClick: () => void; id: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-start transition-colors duration-140 ease-out hover:border-brand-500 hover:bg-brand-50"
      data-choice={id}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-100 text-brand-700 [&_svg]:h-5 [&_svg]:w-5">{icon}</span>
      <span>
        <span className="block font-semibold text-ink-900">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-500">{body}</span>
      </span>
    </button>
  );
}

function Step({ n, done, title, children, hook, dim }: { n: number; done: boolean; title: string; children: React.ReactNode; hook: string; dim?: boolean }) {
  return (
    <li className={`rounded-xl border p-4 ${done ? "border-st-confirmed/40 bg-st-confirmed-soft/40" : "border-line"} ${dim ? "opacity-60" : ""}`} data-wizard-step={hook} data-done={done ? "" : undefined}>
      <div className="mb-2 flex items-center gap-2.5">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold ${done ? "bg-st-confirmed text-white" : "bg-brand-100 text-brand-700"}`}>
          {done ? <CircleCheck className="h-4.5 w-4.5" /> : n}
        </span>
        <span className="font-semibold text-ink-900">{title}</span>
      </div>
      <div className="ps-9.5">{children}</div>
    </li>
  );
}

function Status({ ok, text, hook }: { ok: boolean; text: string; hook: string }) {
  return (
    <p className={`flex items-start gap-2 text-[13.5px] ${ok ? "font-semibold text-st-confirmed" : "text-ink-500"}`} data-status={hook} data-ok={ok ? "" : undefined}>
      {ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}
