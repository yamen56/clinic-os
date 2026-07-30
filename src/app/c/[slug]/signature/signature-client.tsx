"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { SignaturePad, type SignaturePadHandle } from "@/components/esign/signature-pad";
import { saveMySignatureAction, setKioskPinAction } from "../documents/actions";
import { PenTool, Lock } from "lucide-react";

/**
 * A staff member's own signature and device PIN.
 *
 * Drawn once, stored once, then applied with a single tap on every document they
 * ever sign — that is what makes the countersignature journey two taps rather
 * than a signature pad every time. Each staff member has their own; nothing here
 * lets one person sign as another.
 */
export function SignatureSettings({
  slug,
  currentSignature,
  hasPin,
  myName,
}: {
  slug: string;
  currentSignature: string | null;
  hasPin: boolean;
  myName: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [drawing, setDrawing] = useState(!currentSignature);
  const [hasInk, setHasInk] = useState(false);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const padRef = useRef<SignaturePadHandle>(null);

  const save = () =>
    start(async () => {
      const value = padRef.current?.value();
      if (!value) {
        toast(t.docs.errors.bad_signature, "error");
        return;
      }
      const r = await saveMySignatureAction(slug, value.png, value.svg);
      if (r.error) {
        toast(t.docs.errors.bad_signature, "error");
        return;
      }
      toast(t.mySignature.saved);
      setDrawing(false);
      router.refresh();
    });

  const savePin = () =>
    start(async () => {
      setPinError(null);
      if (!/^\d{4,8}$/.test(pin)) {
        setPinError(t.mySignature.pinTooShort);
        return;
      }
      if (pin !== pin2) {
        setPinError(t.mySignature.pinMismatch);
        return;
      }
      const r = await setKioskPinAction(slug, pin);
      if (r.error) {
        setPinError(t.mySignature.pinTooShort);
        return;
      }
      toast(t.mySignature.pinSet);
      setPin("");
      setPin2("");
      router.refresh();
    });

  return (
    <div className="grid gap-4">
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <PenTool className="h-4 w-4 text-ink-400" />
            {t.mySignature.title}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-500">{t.mySignature.sub}</p>
        </div>
        <div className="p-5">
          {drawing ? (
            <>
              <p className="mb-3 text-[13px] text-ink-500">{t.mySignature.firstTime}</p>
              <SignaturePad
                ref={padRef}
                suggestedName={myName}
                onChange={setHasInk}
                heightClass="h-52"
              />
              <div className="mt-3 flex gap-2">
                <Button onClick={save} loading={pending} disabled={!hasInk}>
                  {t.common.save}
                </Button>
                {currentSignature && (
                  <Button variant="outline" onClick={() => setDrawing(false)}>
                    {t.common.cancel}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <div className="rounded-card border border-line bg-white p-4">
                {currentSignature ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={currentSignature} alt="" className="h-16 max-w-64 object-contain" />
                ) : (
                  <span className="text-[13px] text-ink-400">{t.mySignature.none}</span>
                )}
              </div>
              <Button variant="outline" onClick={() => setDrawing(true)}>
                {t.mySignature.replace}
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Lock className="h-4 w-4 text-ink-400" />
            {t.mySignature.pin}
            {hasPin ? (
              <Badge status="confirmed">{t.mySignature.pinSet}</Badge>
            ) : (
              <Badge status="neutral">{t.mySignature.pinNone}</Badge>
            )}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-500">{t.mySignature.pinSub}</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={hasPin ? t.mySignature.changePin : t.mySignature.setPin} hint={t.mySignature.pinDigits}>
            <Input
              type="tel"
              inputMode="numeric"
              dir="ltr"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label={t.auth.confirmPassword} error={pinError ?? undefined}>
            <Input
              type="tel"
              inputMode="numeric"
              dir="ltr"
              maxLength={8}
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <div className="sm:col-span-2">
            <Button onClick={savePin} loading={pending} disabled={!pin || !pin2}>
              {t.common.save}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
