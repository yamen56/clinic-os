"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import QRCode from "qrcode";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { fmtRelative } from "@/lib/dates";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { whatsappControlAction } from "./actions";
import { MessageCircle, ShieldCheck, Smartphone } from "lucide-react";

type Status = {
  status: "disconnected" | "connecting" | "qr" | "connected" | "logged_out";
  qr: string | null;
  phone_number: string | null;
  display_name: string | null;
  connected_at: string | null;
  last_seen_at: string | null;
  error: string | null;
  outbound_today: number;
  paused_until: string | null;
  daily_outbound_cap: number;
};

const badge: Record<Status["status"], StatusKey> = {
  connected: "confirmed",
  connecting: "pending",
  qr: "pending",
  disconnected: "no_show",
  logged_out: "no_show",
};

export function WhatsappClient({
  slug,
  canEdit,
  canSetCap,
}: {
  slug: string;
  canEdit: boolean;
  /** The cap is clinic configuration, which is a separate capability. */
  canSetCap: boolean;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [st, setSt] = useState<Status | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, start] = useTransition();
  const [savingCap, setSavingCap] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/whatsapp/status`);
    if (res.ok) setSt(await res.json());
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // QR rotates and connection state changes — poll fast while pairing, slow otherwise
  useEffect(() => {
    const fast = st?.status === "qr" || st?.status === "connecting";
    const iv = setInterval(() => void refresh(), fast ? 2500 : 15000);
    return () => clearInterval(iv);
  }, [st?.status, refresh]);

  useRealtime(slug, ["whatsapp_sessions"], () => void refresh());

  useEffect(() => {
    if (st?.qr) {
      QRCode.toDataURL(st.qr, { width: 280, margin: 1 }).then(setQrUrl).catch(() => setQrUrl(null));
    } else {
      setQrUrl(null);
    }
  }, [st?.qr]);

  /*
    Saved on blur rather than behind a Save button: it is one number in a card
    of read-only rails, and a lone button there reads as saving the whole card.
  */
  const saveCap = async (n: number) => {
    if (!Number.isInteger(n) || n < 10 || n > 5000 || n === st?.daily_outbound_cap) return;
    setSavingCap(true);
    try {
      const res = await fetch(`/api/c/${slug}/clinic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { daily_outbound_cap: n } }),
      });
      if (!res.ok) throw new Error();
      toast(t.common.saved);
      await refresh();
    } catch {
      toast(t.common.genericError, "error");
    } finally {
      setSavingCap(false);
    }
  };

  const control = (op: "connect" | "disconnect") =>
    start(async () => {
      const r = await whatsappControlAction(slug, op);
      if (r.error) {
        toast(r.error === "worker_down" ? t.wa.workerDown : t.common.genericError, "error");
        return;
      }
      await refresh();
    });

  const statusLabel: Record<Status["status"], string> = {
    connected: t.wa.connected,
    connecting: t.wa.connecting,
    qr: t.wa.qrReady,
    disconnected: t.wa.disconnected,
    logged_out: t.wa.loggedOut,
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title={t.wa.title}
          sub={t.wa.sub}
          action={
            st && (
              <Badge status={badge[st.status]} dot>
                {statusLabel[st.status]}
              </Badge>
            )
          }
        />
        <div className="p-5">
          {!st ? null : st.status === "connected" ? (
            <div className="flex flex-wrap items-center gap-5">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <Smartphone className="h-7 w-7" />
              </span>
              <div className="flex-1">
                <div className="text-lg font-semibold tnum" dir="ltr">
                  {st.phone_number}
                </div>
                <div className="text-[13px] text-ink-500">
                  {st.display_name ? `${st.display_name} · ` : ""}
                  {t.wa.lastSeen}:{" "}
                  {st.last_seen_at ? fmtRelative(st.last_seen_at, locale) : "—"}
                </div>
              </div>
              {canEdit && (
                <Button variant="outline" onClick={() => setConfirmOpen(true)} loading={pending}>
                  {t.wa.disconnect}
                </Button>
              )}
            </div>
          ) : st.status === "qr" && qrUrl ? (
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrUrl} alt="WhatsApp QR" className="h-64 w-64 rounded-xl border border-line" />
              <div className="max-w-sm">
                <p className="text-sm leading-6 text-ink-700">{t.wa.qrHint}</p>
                {canEdit && (
                  <Button variant="ghost" className="mt-3" onClick={() => control("disconnect")}>
                    {t.common.cancel}
                  </Button>
                )}
              </div>
            </div>
          ) : st.status === "connecting" ? (
            <div className="flex items-center gap-3 text-sm text-ink-500">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-st-pending" />
              {t.wa.connecting}
              {st.error && <span className="text-ink-400">({st.error})</span>}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <MessageCircle className="h-10 w-10 text-ink-300" />
              {st.error && <p className="text-[13px] text-danger">{st.error}</p>}
              {canEdit && (
                <Button size="lg" onClick={() => control("connect")} loading={pending}>
                  {t.wa.connect}
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t.wa.railsTitle} sub={t.wa.railsBody} />
        {st && (
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-end gap-8 text-sm">
              <div>
                <label
                  htmlFor="daily-cap"
                  className="mb-1 block text-[12px] text-ink-500"
                >
                  {t.wa.dailyCap}
                </label>
                {canSetCap ? (
                  <input
                    id="daily-cap"
                    type="number"
                    min={10}
                    max={5000}
                    step={50}
                    defaultValue={st.daily_outbound_cap}
                    disabled={savingCap}
                    onBlur={(e) => saveCap(Number(e.target.value))}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    className="h-9 w-28 rounded-ctl border border-line bg-transparent px-3 text-sm font-semibold tabular-nums outline-none focus:border-brand-400"
                  />
                ) : (
                  <div className="font-semibold tnum">{st.daily_outbound_cap}</div>
                )}
              </div>
              <div>
                <div className="text-[12px] text-ink-500">{t.wa.sentToday}</div>
                <div className="font-semibold tnum">{st.outbound_today}</div>
              </div>
              <div className="flex items-center gap-2 pb-1.5 text-brand-700">
                <ShieldCheck className="h-4.5 w-4.5" />
                3–10s
              </div>
            </div>
            {/*
              The cap is the one rail a clinic can raise, so it is the one that
              needs the warning next to it. This is a personal WhatsApp number,
              not a business API: volume to people who never wrote first is what
              gets numbers banned, and a banned number cannot be appealed.
            */}
            <p className="mt-3 max-w-prose rounded-lg bg-sunken p-3 text-[13px] text-ink-600">
              {t.wa.capWarning}
            </p>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t.wa.disconnectConfirm}
        body={t.wa.disconnectBody}
        confirmLabel={t.wa.disconnect}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          setConfirmOpen(false);
          control("disconnect");
        }}
      />
    </div>
  );
}
