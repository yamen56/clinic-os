"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { fmtRelative, fmtTime, fmtDate, fmtMoney, fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toggle, Input, Field, Textarea } from "@/components/ui/input";
import { Avatar, EmptyState, Spinner } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  addQuickReplyAction,
  deleteQuickReplyAction,
  createPatientFromConversationAction,
} from "./actions";
import {
  MessageCircle,
  Send,
  Paperclip,
  Zap,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Sparkles,
  UserRound,
  CalendarPlus,
  ReceiptText,
  X,
  Trash2,
  Search,
} from "lucide-react";

type ConvRow = {
  id: string;
  phone_e164: string;
  status: string;
  assigned_to: string | null;
  assigned_name: string | null;
  ai_enabled: boolean;
  ai_paused_until: string | null;
  unread_count: number;
  flagged: boolean;
  flag_reason: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_direction: string | null;
  patient_id: string | null;
  identifier_kind: string;
  patient_name: string | null;
  patient_status: string | null;
  whatsapp_name: string | null;
};

type Msg = {
  id: string;
  direction: "in" | "out";
  sender_kind: string;
  msg_type: string;
  body: string;
  media_path: string | null;
  media_mime: string | null;
  media_name: string | null;
  status: string;
  error: string | null;
  created_at: string;
  sender_name: string | null;
};

type PatientPanel = {
  id: string;
  full_name: string;
  phone_e164: string | null;
  tags: string[];
  status: string;
  notes_summary: string;
  next_appointment: string | null;
  balance_due: string;
};

type QuickReply = { id: string; title: string; body: string };

export function InboxClient({
  slug,
  tz,
  selfId,
  initialOpenId,
  initialQuickReplies,
}: {
  slug: string;
  tz: string;
  selfId: string;
  initialOpenId: string | null;
  initialQuickReplies: QuickReply[];
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [list, setList] = useState<ConvRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [thread, setThread] = useState<{
    conversation: ConvRow;
    messages: Msg[];
    patient: PatientPanel | null;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [quickReplies, setQuickReplies] = useState(initialQuickReplies);
  const [saveQrOpen, setSaveQrOpen] = useState(false);
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [qrTitle, setQrTitle] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshList = useCallback(async () => {
    const p = new URLSearchParams({ filter });
    if (q.trim()) p.set("q", q.trim());
    const res = await fetch(`/api/c/${slug}/conversations?${p}`);
    if (res.ok) setList((await res.json()).conversations);
  }, [slug, filter, q]);

  const refreshThread = useCallback(
    async (id: string, markRead = false) => {
      const res = await fetch(`/api/c/${slug}/conversations/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setThread(data);
      if (markRead && data.conversation.unread_count > 0) {
        await fetch(`/api/c/${slug}/conversations/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "read" }),
        });
        void refreshList();
      }
    },
    [slug, refreshList]
  );

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (openId) void refreshThread(openId, true);
    else setThread(null);
  }, [openId, refreshThread]);

  useRealtime(slug, ["conversations", "messages"], () => {
    void refreshList();
    if (openId) void refreshThread(openId);
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [thread?.messages.length]);

  const send = async (file?: File) => {
    if (!openId || (!draft.trim() && !file)) return;
    setSending(true);
    try {
      let res: Response;
      if (file) {
        const fd = new FormData();
        fd.set("body", draft.trim());
        fd.set("file", file);
        res = await fetch(`/api/c/${slug}/conversations/${openId}/send`, { method: "POST", body: fd });
      } else {
        res = await fetch(`/api/c/${slug}/conversations/${openId}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: draft.trim() }),
        });
      }
      if (!res.ok) {
        toast(t.common.genericError, "error");
        return;
      }
      setDraft("");
      await refreshThread(openId);
      void refreshList();
    } finally {
      setSending(false);
    }
  };

  const command = async (op: string, extra: Record<string, unknown> = {}) => {
    if (!openId) return;
    await fetch(`/api/c/${slug}/conversations/${openId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...extra }),
    });
    await refreshThread(openId);
    void refreshList();
  };

  const filters = [
    { key: "all", label: t.conversations.all },
    { key: "unassigned", label: t.conversations.unassigned },
    { key: "mine", label: t.conversations.mine },
    { key: "ai", label: t.conversations.aiHandled },
    { key: "flagged", label: t.conversations.flagged },
  ];

  const aiActive = (cv: ConvRow) =>
    cv.ai_enabled && (!cv.ai_paused_until || new Date(cv.ai_paused_until) < new Date());

  /**
   * The title of a thread, which is a *name* when we have one and a phone
   * number when we do not.
   *
   * That distinction has to survive to the markup, because the two need
   * different treatment in Arabic. A name is Arabic text and belongs in the
   * page's own direction. A phone number begins with `+`, which is a neutral
   * character: in a right-to-left paragraph the surrounding text claims it and
   * drags it to the far end, so `+962 79 074 4070` is drawn ending in the plus
   * and reads backwards. Isolating the run is what stops that.
   */
  /*
    Some chats are addressed by a WhatsApp identity rather than a number. The
    digits look like a phone number and are not one, so formatting them as
    "+19 109 180 2390675" invites somebody to dial it. Say what it is instead.
  */
  const displayName = (cv: ConvRow) =>
    cv.patient_name ||
    cv.whatsapp_name ||
    (cv.identifier_kind === "lid" ? t.conversations.whatsappUser : formatPhone(cv.phone_e164));
  const isPhoneTitle = (cv: ConvRow) =>
    !cv.patient_name && !cv.whatsapp_name && cv.identifier_kind !== "lid";

  /** The thread title, isolated when it is really a number. */
  const Title = ({ cv, className = "" }: { cv: ConvRow; className?: string }) => (
    <span className={`${isPhoneTitle(cv) ? "num " : ""}${className}`}>{displayName(cv)}</span>
  );

  /*
    One tick means the socket took it, two that the handset has it, and the
    lit pair that it was opened. They are only worth drawing apart — the whole
    point of a receipt is telling "arrived" from "went nowhere".
  */
  const statusIcon = (m: Msg) => {
    if (m.direction === "in") return null;
    if (m.status === "failed")
      return <AlertCircle className="h-3.5 w-3.5 text-danger" aria-label={t.conversations.failed} />;
    if (m.status === "queued" || m.status === "sending")
      return <Clock className="h-3.5 w-3.5 opacity-60" aria-label={t.conversations.pending} />;
    if (m.status === "read")
      return <CheckCheck className="h-3.5 w-3.5 text-sky-300" aria-label={t.conversations.read} />;
    if (m.status === "delivered")
      return <CheckCheck className="h-3.5 w-3.5 opacity-60" aria-label={t.conversations.delivered} />;
    return <Check className="h-3.5 w-3.5 opacity-60" aria-label={t.conversations.sent} />;
  };

  const cv = thread?.conversation;

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] overflow-hidden rounded-card border border-line bg-surface shadow-card md:h-[calc(100dvh-5rem)]">
      {/* ------ List pane ------ */}
      <div className={`flex w-full flex-col border-e border-line lg:w-[17rem] xl:w-80 ${openId ? "hidden lg:flex" : ""}`}>
        <div className="border-b border-line p-3">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t.common.search}
              className="h-9 w-full rounded-full border border-line bg-sunken ps-9 pe-3 text-sm outline-none focus:border-brand-400"
            />
          </div>
          {/*
            Wraps rather than scrolls sideways. In the narrower list pane a
            tablet gets, the last filter was clipped at the edge — and a control
            half off-screen reads as a broken layout rather than as something
            you can scroll to. Five short chips cost one extra row at worst.
          */}
          <div className="flex flex-wrap gap-1">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                  filter === f.key ? "bg-brand-600 text-white" : "bg-ink-900/4 text-ink-500 hover:bg-ink-900/8"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list === null ? (
            <Spinner />
          ) : list.length === 0 ? (
            <div className="p-4">
              <EmptyState icon={<MessageCircle />} title={t.conversations.empty} body={t.conversations.emptyBody} />
            </div>
          ) : (
            list.map((row) => (
              <button
                key={row.id}
                onClick={() => setOpenId(row.id)}
                className={`flex w-full items-center gap-3 border-b border-line/60 px-3.5 py-3 text-start transition-colors hover:bg-sunken ${
                  openId === row.id ? "bg-brand-50/50" : ""
                }`}
              >
                <Avatar
                  name={displayName(row)}
                  size={40}
                  color={row.patient_status === "lead" ? "var(--color-st-pending)" : undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <Title cv={row} className="truncate text-sm font-semibold" />
                    {row.last_message_at && (
                      <span className="shrink-0 text-[11px] text-ink-400" suppressHydrationWarning>
                        {fmtRelative(row.last_message_at, locale)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {aiActive(row) && <Sparkles className="h-3 w-3 shrink-0 text-brand-500" />}
                    {row.flagged && <AlertCircle className="h-3 w-3 shrink-0 text-st-pending" />}
                    <span className="truncate text-[13px] text-ink-500">
                      {row.last_message_direction === "out" && "↩ "}
                      {row.last_message_preview ?? ""}
                    </span>
                    {row.unread_count > 0 && (
                      <span className="ms-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-bold text-white tnum">
                        {row.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ------ Thread pane ------ */}
      <div className={`flex min-w-0 flex-1 flex-col ${openId ? "" : "hidden lg:flex"}`}>
        {!thread || !cv ? (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-400">
            {t.conversations.selectThread}
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <button className="lg:hidden" onClick={() => setOpenId(null)} aria-label={t.common.back}>
                <X className="h-5 w-5 text-ink-400" />
              </button>
              <Avatar name={displayName(cv)} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold"><Title cv={cv} /></div>
                {/*
                  A LID thread has no phone number. `phone_e164` is holding the
                  WhatsApp identity that stands in for one, and it is fifteen
                  digits with a plus on the front — which read as a real number
                  sitting under the person's name, and got copied onto patient
                  files and dialled. The title above has always been guarded;
                  this line was not.

                  Saying why there is no number is more use than showing
                  nothing: it tells reception to ask for it rather than go
                  looking for where the app hid it.
                */}
                {cv.identifier_kind === "lid" ? (
                  <div className="truncate text-[12px] text-ink-400">
                    {t.conversations.numberNotShared}
                  </div>
                ) : (
                  <div className="text-[12px] text-ink-400 tnum" dir="ltr">
                    {formatPhone(cv.phone_e164)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2.5">
                <label className="flex items-center gap-1.5">
                  <Sparkles className={`h-4 w-4 ${aiActive(cv) ? "text-brand-600" : "text-ink-300"}`} />
                  <Toggle
                    checked={cv.ai_enabled}
                    onChange={(v) => void command("ai", { enabled: v })}
                    label={t.conversations.aiOn}
                  />
                </label>
                {cv.ai_enabled && cv.ai_paused_until && new Date(cv.ai_paused_until) > new Date() && (
                  <Badge status="pending">{t.conversations.aiPaused}</Badge>
                )}
                {cv.assigned_to ? (
                  <Badge status="brand">{cv.assigned_to === selfId ? t.conversations.mine : cv.assigned_name}</Badge>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => void command("assign")}>
                    {t.conversations.assignToMe}
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto bg-subtle px-4 py-4">
              {cv.flagged && cv.flag_reason && (
                <div className="mx-auto mb-2 rounded-full bg-st-pending-soft px-4 py-1.5 text-[12px] font-medium text-st-pending">
                  {cv.flag_reason}
                </div>
              )}
              {thread.messages.map((m) => {
                const out = m.direction === "out";
                const senderLabel =
                  out && m.sender_kind !== "patient"
                    ? m.sender_kind === "staff"
                      ? m.sender_name || t.conversations.sentBy.staff
                      : (t.conversations.sentBy as Record<string, string>)[m.sender_kind] ?? m.sender_kind
                    : null;
                return (
                  <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ${
                        out
                          ? m.sender_kind === "ai"
                            ? "rounded-be-md bg-brand-100 text-brand-900"
                            : "rounded-be-md bg-brand-600 text-white"
                          : "rounded-bs-md border border-line bg-surface"
                      }`}
                    >
                      {senderLabel && (
                        <div className={`mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${out && m.sender_kind !== "ai" ? "text-white/70" : "text-brand-700"}`}>
                          {m.sender_kind === "ai" && <Sparkles className="h-3 w-3" />}
                          {m.sender_kind === "automation" && <Zap className="h-3 w-3" />}
                          {senderLabel}
                        </div>
                      )}
                      {m.msg_type === "image" && m.media_path && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/c/${slug}/wa-media/${m.id}`}
                          alt=""
                          className="mb-1 max-h-64 rounded-lg"
                        />
                      )}
                      {m.msg_type === "audio" && m.media_path && (
                        <audio controls src={`/api/c/${slug}/wa-media/${m.id}`} className="mb-1 max-w-full" />
                      )}
                      {(m.msg_type === "document" || m.msg_type === "video") && m.media_path && (
                        <a
                          href={`/api/c/${slug}/wa-media/${m.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className={`mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] underline ${out ? "bg-white/10" : "bg-sunken"}`}
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                          {m.media_name ?? m.msg_type}
                        </a>
                      )}
                      {m.body && <div className="whitespace-pre-wrap break-words text-sm">{m.body}</div>}
                      <div className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${out && m.sender_kind !== "ai" ? "text-white/60" : "text-ink-400"}`}>
                        {m.status === "failed" && (
                          <span className="font-medium text-danger">
                            {m.error === "no_whatsapp_account"
                              ? t.conversations.noWhatsappAccount
                              : t.conversations.failed}
                          </span>
                        )}
                        <span className="tnum" suppressHydrationWarning>{fmtTime(m.created_at, tz, locale)}</span>
                        {statusIcon(m)}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* Composer */}
            <div className="border-t border-line p-3">
              <div className="flex items-end gap-2">
                <div className="relative flex-1">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={t.conversations.typeMessage}
                    rows={Math.min(draft.split("\n").length, 5)}
                    className="w-full resize-none rounded-2xl border border-line-strong bg-surface px-4 py-2.5 text-sm outline-none focus:border-brand-400"
                  />
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void send(f);
                    e.target.value = "";
                  }}
                />
                <Button variant="ghost" size="icon" aria-label={t.conversations.attach} onClick={() => fileInput.current?.click()}>
                  <Paperclip className="h-4.5 w-4.5" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={t.conversations.quickReplies} onClick={() => setQrOpen(true)}>
                  <Zap className="h-4.5 w-4.5" />
                </Button>
                <Button size="icon" onClick={() => void send()} loading={sending} aria-label="Send" disabled={!draft.trim()}>
                  <Send className="h-4.5 w-4.5 rtl:-scale-x-100" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ------ Patient panel ------ */}
      {thread && (
        <div className="hidden w-72 shrink-0 flex-col border-s border-line xl:flex">
          {thread.patient ? (
            <div className="flex flex-col gap-4 overflow-y-auto p-4">
              <div className="flex flex-col items-center gap-2 text-center">
                <Avatar name={thread.patient.full_name} size={56} />
                <div>
                  <div className="font-semibold">{thread.patient.full_name}</div>
                  <div className="text-[12px] text-ink-400 tnum" dir="ltr">
                    {formatPhone(thread.patient.phone_e164)}
                  </div>
                </div>
                {thread.patient.status === "lead" && (
                  <Badge status="pending">{t.conversations.newPatientLead}</Badge>
                )}
                <div className="flex flex-wrap justify-center gap-1">
                  {thread.patient.tags.map((tag) => (
                    <Badge key={tag} status="brand">{tag}</Badge>
                  ))}
                </div>
              </div>
              <div className="grid gap-2 text-[13px]">
                <div className="flex justify-between rounded-lg bg-sunken px-3 py-2">
                  <span className="text-ink-500">{t.patients.overview.balanceDue}</span>
                  <span className="font-semibold tnum">
                    {fmtMoney(Number(thread.patient.balance_due), "JOD", locale)}
                  </span>
                </div>
                <div className="rounded-lg bg-sunken px-3 py-2">
                  <span className="text-ink-500">{t.patients.overview.upcoming}: </span>
                  <span className="font-medium">
                    {thread.patient.next_appointment
                      ? fmtDateTime(thread.patient.next_appointment, tz, locale)
                      : t.patients.overview.noUpcoming}
                  </span>
                </div>
                {thread.patient.notes_summary && (
                  <p className="rounded-lg bg-sunken px-3 py-2 text-ink-700">{thread.patient.notes_summary}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Link href={`/c/${slug}/patients/${thread.patient.id}`}>
                  <Button variant="outline" className="w-full">
                    <UserRound className="h-4 w-4" />
                    {t.conversations.openPatient}
                  </Button>
                </Link>
                <Link href={`/c/${slug}/calendar?patient=${thread.patient.id}`}>
                  <Button variant="outline" className="w-full">
                    <CalendarPlus className="h-4 w-4" />
                    {t.patients.bookAppointment}
                  </Button>
                </Link>
                <Link href={`/c/${slug}/invoices/new?patient=${thread.patient.id}`}>
                  <Button variant="outline" className="w-full">
                    <ReceiptText className="h-4 w-4" />
                    {t.patients.createInvoice}
                  </Button>
                </Link>
              </div>
            </div>
          ) : (
            /*
              A thread without a file is the normal case now — anyone can text
              the clinic. This is the deliberate step that makes one a patient.
            */
            <div className="grid gap-3 p-4 text-center">
              <p className="text-sm text-ink-400">{t.conversations.noPatient}</p>
              <Button
                variant="outline"
                loading={creatingPatient}
                onClick={() => {
                  if (!cv) return;
                  setCreatingPatient(true);
                  void createPatientFromConversationAction(slug, cv.id)
                    .then((r) => {
                      if (r.error) toast(t.common.genericError, "error");
                      else {
                        toast(t.conversations.patientCreated);
                        void refreshThread(cv.id);
                        void refreshList();
                      }
                    })
                    .finally(() => setCreatingPatient(false));
                }}
              >
                <UserRound className="h-4 w-4" />
                {t.conversations.createPatient}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Quick replies modal */}
      <Modal open={qrOpen} onClose={() => setQrOpen(false)} title={t.conversations.quickReplies}>
        <div className="grid gap-2">
          {quickReplies.map((qr) => (
            <div key={qr.id} className="flex items-start gap-2">
              <button
                onClick={() => {
                  setDraft((d) => (d ? `${d}\n${qr.body}` : qr.body));
                  setQrOpen(false);
                }}
                className="flex-1 rounded-lg border border-line px-3 py-2 text-start hover:bg-sunken"
              >
                <div className="text-[13px] font-semibold">{qr.title}</div>
                <div className="line-clamp-2 text-[12px] text-ink-500">{qr.body}</div>
              </button>
              <button
                aria-label={t.common.delete}
                onClick={async () => {
                  await deleteQuickReplyAction(slug, qr.id);
                  setQuickReplies((xs) => xs.filter((x) => x.id !== qr.id));
                }}
                className="mt-2 text-ink-300 hover:text-danger"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {draft.trim() && (
            <Button variant="soft" onClick={() => { setSaveQrOpen(true); setQrOpen(false); }}>
              {t.conversations.addQuickReply}
            </Button>
          )}
        </div>
      </Modal>

      {/* Save quick reply */}
      <Modal open={saveQrOpen} onClose={() => setSaveQrOpen(false)} title={t.conversations.addQuickReply}>
        <div className="grid gap-3">
          <Field label={t.conversations.quickReplyTitle} required>
            <Input value={qrTitle} onChange={(e) => setQrTitle(e.target.value)} />
          </Field>
          <Field label={t.common.notes}>
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSaveQrOpen(false)}>{t.common.cancel}</Button>
            <Button
              disabled={!qrTitle.trim() || !draft.trim()}
              onClick={async () => {
                const r = await addQuickReplyAction(slug, { title: qrTitle, body: draft });
                if (r.id) {
                  setQuickReplies((xs) => [...xs, { id: r.id!, title: qrTitle, body: draft }]);
                  toast(t.common.saved);
                }
                setSaveQrOpen(false);
                setQrTitle("");
              }}
            >
              {t.common.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
