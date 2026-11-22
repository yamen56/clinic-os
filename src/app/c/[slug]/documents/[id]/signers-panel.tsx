"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Menu, MenuItem } from "@/components/ui/menu";
import { buttonClass } from "@/components/ui/button-class";
import { useToast } from "@/components/ui/toast";
import { assignStaffSignerAction, copyLinkAction, revokeLinkAction, sendToSignerAction } from "../actions";
import { Bell, Check, CheckCircle2, Clock, Copy, Eye, Link2, MessageCircle, MoreHorizontal, PenTool, Share2, Users, Wand2, XCircle } from "lucide-react";

export type PanelSigner = {
  id: string;
  role_key: string;
  role_label: string | null;
  role_label_ar: string | null;
  is_staff: boolean;
  is_required: boolean;
  display_name: string;
  phone_e164: string | null;
  user_id: string | null;
  relationship: string | null;
  status: string;
  link_opened_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  decline_reason: string | null;
  signed_in_person: boolean;
  signed_automatically?: boolean;
};

export type StaffOption = { user_id: string; full_name: string; role: string; auto: boolean };

/**
 * Copies text that is still on its way from the server.
 *
 * Safari only lets a page write to the clipboard inside the tap itself, and the
 * link exists only after a round trip. A ClipboardItem built from a promise is
 * written during the tap and filled when the link arrives; where that is not
 * supported the text is written once it is here, and the link is shown on
 * screen either way so it can always be copied by hand.
 */
function copyWhenReady(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      return navigator.clipboard
        .write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
        .then(() => true)
        .catch(() => text.then((t) => navigator.clipboard.writeText(t)).then(() => true).catch(() => false));
    }
  } catch {
    /* fall through */
  }
  return text.then((t) => navigator.clipboard.writeText(t)).then(() => true).catch(() => false);
}

/**
 * Who signs this document, how far each of them has got, and how to reach
 * them — on top of the page, not in a tab (2026-11-21: "not organised and
 * hard to understand the first time").
 *
 * Everyone signs at the same time now, so there is no "turn": each line has
 * its own way in. An outside signer gets a link — copy it and send it however
 * you like, or send it on WhatsApp — and a staff signer is asked in the app,
 * or signed for automatically if they turned that on. A staff line with
 * nobody on it asks who.
 */
export function SignersPanel({
  slug,
  documentId,
  documentTitle,
  status,
  signers,
  staff,
  userId,
  canManage,
  roleName,
  onSignMine,
  onEditSigners,
  tz,
}: {
  slug: string;
  documentId: string;
  documentTitle: string;
  status: string;
  signers: PanelSigner[];
  staff: StaffOption[];
  userId: string;
  canManage: boolean;
  roleName: (s: PanelSigner) => string;
  onSignMine: () => void;
  onEditSigners?: () => void;
  tz: string;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; copied: boolean } | null>(null);

  const terminal = ["completed", "declined", "expired", "voided"].includes(status);
  const signed = signers.filter((s) => s.status === "signed").length;
  const err = (code?: string) => (t.docs.errors as Record<string, string>)[code ?? ""] ?? t.common.genericError;
  const nameOf = (s: PanelSigner) => s.display_name || roleName(s);
  const autoFor = (s: PanelSigner) => !!s.user_id && staff.some((m) => m.user_id === s.user_id && m.auto);

  const copy = (s: PanelSigner) => {
    setBusy(s.id);
    const request = copyLinkAction(slug, documentId, s.id);
    const url = request.then((r) => {
      if (!r.url) throw new Error(r.error ?? "x");
      return r.url;
    });
    const copied = copyWhenReady(url);
    start(async () => {
      const r = await request;
      setBusy(null);
      if (!r.url) {
        toast(err(r.error), "error");
        return;
      }
      const ok = await copied;
      setLink({ id: s.id, url: r.url, copied: ok });
      if (ok) toast(t.docs.linkCopied.replace("{name}", nameOf(s)));
    });
  };

  const send = (s: PanelSigner) =>
    start(async () => {
      setBusy(s.id);
      const r = await sendToSignerAction(slug, documentId, s.id);
      setBusy(null);
      if (r.url) setLink({ id: s.id, url: r.url, copied: false });
      if (r.error) {
        toast(err(r.error), "error");
        return;
      }
      toast(
        r.via === "automatic"
          ? t.docs.signedForAuto.replace("{name}", nameOf(s))
          : r.via === "app"
            ? t.docs.remindedInApp.replace("{name}", nameOf(s))
            : t.docs.sentToSigner.replace("{name}", nameOf(s))
      );
    });

  const assign = (s: PanelSigner, memberUserId: string) =>
    start(async () => {
      if (!memberUserId) return;
      setBusy(s.id);
      const r = await assignStaffSignerAction(slug, documentId, s.id, memberUserId);
      setBusy(null);
      const member = staff.find((m) => m.user_id === memberUserId);
      if (r.error) toast(err(r.error), "error");
      else if (r.via === "automatic") toast(t.docs.signedForAuto.replace("{name}", member?.full_name ?? ""));
      else if (r.via === "app") toast(t.docs.remindedInApp.replace("{name}", member?.full_name ?? ""));
    });

  const revoke = (s: PanelSigner) =>
    start(async () => {
      const r = await revokeLinkAction(slug, documentId, s.id);
      if (link?.id === s.id) setLink(null);
      toast(r.error ? err(r.error) : t.docs.revoked, r.error ? "error" : "success");
    });

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5" data-signers-panel>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold">
            <Users className="h-4 w-4 text-ink-400" />
            {t.docs.whoSigns}
            <span className="rounded-full bg-ink-900/5 px-2 py-0.5 text-[0.75rem] font-semibold text-ink-500 tnum" data-signed-count>
              {t.docs.signedOfN.replace("{n}", String(signed)).replace("{total}", String(signers.length))}
            </span>
          </h2>
          {signers.length > 1 && !terminal && <p className="mt-0.5 text-[0.75rem] text-ink-500">{t.docs.allAtOnce}</p>}
        </div>
        {onEditSigners && (
          <Button variant="outline" size="sm" onClick={onEditSigners}>
            <Users className="h-4 w-4" />
            {t.docs.editSigners}
          </Button>
        )}
      </div>

      <ul className="divide-y divide-line">
        {signers.map((s) => {
          const open = !terminal && s.status !== "signed" && s.status !== "declined";
          const staffLine = s.is_staff || !!s.user_id;
          const unassigned = staffLine && !s.user_id;
          const isMe = !!s.user_id && s.user_id === userId;
          const auto = autoFor(s);
          return (
            <li key={s.id} className="px-5 py-3.5" data-signer={s.role_key} data-signer-status={s.status}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="relative shrink-0">
                  <Avatar name={nameOf(s)} size={36} />
                  <span
                    className={`absolute -bottom-0.5 -end-0.5 grid h-4 w-4 place-items-center rounded-full ring-2 ring-surface ${
                      s.status === "signed" ? "bg-ok text-white" : s.status === "declined" ? "bg-danger text-white" : "bg-st-pending text-white"
                    }`}
                    aria-hidden
                  >
                    {s.status === "signed" ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : s.status === "declined" ? <XCircle className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />}
                  </span>
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-semibold">{unassigned ? t.docs.noOneChosen : nameOf(s)}</span>
                    <span className="text-[0.75rem] text-ink-500">{roleName(s)}</span>
                    {!s.is_required && <span className="text-[length:max(11px,0.6875rem)] text-ink-400">· {t.docs.optionalSigner}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.75rem]">
                    {s.status === "signed" ? (
                      <span className="flex items-center gap-1 text-ok">
                        {s.signed_automatically ? <Wand2 className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                        {t.docs.signed} · {s.signed_at ? fmtDateTime(s.signed_at, tz, locale) : ""} ·{" "}
                        {s.signed_automatically
                          ? t.docs.methods.automatic
                          : s.signed_in_person
                            ? t.docs.methods.in_clinic
                            : s.user_id
                              ? t.docs.methods.staff
                              : t.docs.methods.remote}
                      </span>
                    ) : s.status === "declined" ? (
                      <span className="text-danger">
                        {(t.docs.signerStatuses as Record<string, string>).declined}
                        {s.decline_reason ? ` · ${s.decline_reason}` : ""}
                      </span>
                    ) : auto && open ? (
                      <span className="flex items-center gap-1 text-ink-500">
                        <Wand2 className="h-3 w-3" />
                        {t.docs.signsAutomatically}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-st-pending">
                        {s.status === "viewed" ? <Eye className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                        {(t.docs.signerStatuses as Record<string, string>)[s.status] ?? s.status}
                        {s.link_opened_at && ` · ${fmtDateTime(s.link_opened_at, tz, locale)}`}
                      </span>
                    )}
                    {s.phone_e164 && !s.user_id && (
                      <span dir="ltr" className="text-ink-400 tnum">
                        {formatPhone(s.phone_e164)}
                      </span>
                    )}
                    {s.relationship && <span className="text-ink-400">{s.relationship}</span>}
                  </div>
                </div>

                {open && (
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {isMe && status !== "draft" && (
                      <Button size="sm" onClick={onSignMine} data-sign-mine>
                        <PenTool className="h-4 w-4" />
                        {t.docs.countersign}
                      </Button>
                    )}
                    {canManage && unassigned && (
                      <Select
                        className="!h-9 !w-auto min-w-44"
                        aria-label={t.docs.chooseSigner}
                        value=""
                        disabled={pending && busy === s.id}
                        onChange={(e) => assign(s, e.target.value)}
                        data-choose-signer
                      >
                        <option value="">{t.docs.chooseSigner}</option>
                        {staff.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.full_name}
                          </option>
                        ))}
                      </Select>
                    )}
                    {canManage && !staffLine && (
                      <>
                        <Button variant="outline" size="sm" loading={pending && busy === s.id} onClick={() => copy(s)} data-copy-link>
                          <Copy className="h-4 w-4" />
                          {t.docs.copyLinkShort}
                        </Button>
                        {s.phone_e164 && (
                          <Button variant="outline" size="sm" disabled={pending} onClick={() => send(s)} data-send-whatsapp>
                            <MessageCircle className="h-4 w-4" />
                            {t.docs.whatsapp}
                          </Button>
                        )}
                        <Menu
                          label={t.docs.more}
                          buttonClassName={buttonClass({ variant: "ghost", size: "icon" })}
                          trigger={() => <MoreHorizontal className="h-4 w-4" />}
                        >
                          {(close) => (
                            <MenuItem
                              icon={<Link2 />}
                              onClick={() => {
                                close();
                                revoke(s);
                              }}
                            >
                              {t.docs.revokeLink}
                            </MenuItem>
                          )}
                        </Menu>
                      </>
                    )}
                    {canManage && staffLine && !unassigned && !isMe && status !== "draft" && (
                      <Button variant="outline" size="sm" loading={pending && busy === s.id} onClick={() => send(s)} data-remind>
                        <Bell className="h-4 w-4" />
                        {t.docs.remind}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {link?.id === s.id && open && (
                <div className="mt-3 grid gap-2 rounded-lg border border-line bg-subtle p-3" data-link-box>
                  <p className="text-[0.8125rem] font-medium">
                    {(link.copied ? t.docs.linkCopied : t.docs.linkReady).replace("{name}", nameOf(s))}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input readOnly dir="ltr" className="min-w-0 flex-1 !text-[0.8125rem]" value={link.url} onFocus={(e) => e.currentTarget.select()} data-link-url />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(link.url)
                          .then(() => {
                            setLink({ ...link, copied: true });
                            toast(t.common.copied);
                          })
                          .catch(() => {})
                      }
                    >
                      <Copy className="h-4 w-4" />
                      {t.docs.copyLinkShort}
                    </Button>
                    {typeof navigator !== "undefined" && "share" in navigator && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigator.share({ title: documentTitle, url: link.url }).catch(() => {})}
                      >
                        <Share2 className="h-4 w-4" />
                        {t.docs.share}
                      </Button>
                    )}
                  </div>
                  <p className="text-[0.75rem] text-ink-500">{t.docs.linkOnce}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
