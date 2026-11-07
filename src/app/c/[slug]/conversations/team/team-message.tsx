"use client";

/*
  One message of the team chat, as the chat apps everybody knows draw it: the
  message it answers quoted above it, "forwarded" when it was, @mentions picked
  out, links that open, "edited", the ticks that turn blue when it was seen, and
  the reactions hanging off its edge.

  A pointer gets a small toolbar on hover (react, reply, more); a finger holds
  the message down for the same choices in a sheet, as on a phone's own apps.
*/

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CheckCheck, CornerUpLeft, Forward, MoreVertical, Paperclip, SmilePlus } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { VoiceNote } from "@/components/voice-note";
import { QUICK_REACTIONS } from "@/lib/team-chat-shared";
import type { TeamMessage, TeamQuote } from "@/lib/team-chat";

export type Local = TeamMessage & { pending?: boolean; failed?: boolean; retry?: () => void };

const LINK = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"])/g;

/** Words with their @mentions picked out and their links made links. */
export function MessageBody({ text, mentions, mine }: { text: string; mentions: { name: string; me: boolean }[]; mine: boolean }) {
  const names = mentions.filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
  const parts: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const pushText = (s: string) => {
    for (const [i, bit] of s.split(LINK).entries()) {
      if (!bit) continue;
      parts.push(
        i % 2 === 1 ? (
          <a key={key++} href={bit} target="_blank" rel="noreferrer noopener" className="break-all underline underline-offset-2" dir="ltr">
            {bit}
          </a>
        ) : (
          <Fragment key={key++}>{bit}</Fragment>
        )
      );
    }
  };
  while (rest) {
    let at = -1;
    let who: { name: string; me: boolean } | null = null;
    for (const n of names) {
      const i = rest.indexOf(`@${n.name}`);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        who = n;
      }
    }
    if (!who || at < 0) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, at));
    parts.push(
      <span
        key={key++}
        className={`rounded px-0.5 font-semibold ${who.me ? (mine ? "bg-surface/25" : "bg-brand-100 text-brand-700") : mine ? "underline underline-offset-2" : "text-brand-700"}`}
      >
        @{who.name}
      </span>
    );
    rest = rest.slice(at + who.name.length + 1);
  }
  return <>{parts}</>;
}

/** The message a reply answers, or the one pinned: who, and its first words. */
export function QuoteLine({ q, label, onClick, mine }: { q: TeamQuote; label: { photo: string; voice: string; file: string; deleted: string; you: string }; onClick?: () => void; mine?: boolean }) {
  const what = q.deleted ? label.deleted : q.body || (q.fileMime?.startsWith("image/") ? `📷 ${label.photo}` : q.fileMime?.startsWith("audio/") ? `🎤 ${label.voice}` : `📎 ${q.fileName ?? label.file}`);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 block w-full min-w-0 rounded-lg border-s-[3px] px-2 py-1 text-start ${mine ? "border-surface/70 bg-surface/15" : "border-brand-600 bg-ink-900/5"}`}
      data-team-quote={q.id}
    >
      <span className="block truncate text-[12px] font-semibold opacity-90" dir="auto">
        {q.senderName ?? label.you}
      </span>
      <span className="line-clamp-2 block text-[12.5px] opacity-80" dir="auto">
        {what}
      </span>
    </button>
  );
}

export function Bubble({
  m,
  mine,
  showSender,
  senderColor,
  mentions,
  reactionNames,
  meId,
  time,
  fileUrl,
  seen,
  flash,
  onReact,
  onReply,
  onMenu,
  onJump,
}: {
  m: Local;
  mine: boolean;
  showSender: boolean;
  senderColor: string | null;
  mentions: { name: string; me: boolean }[];
  /** Names for a reaction's people, for its tooltip. */
  reactionNames: (ids: string[]) => string;
  meId: string;
  time: string;
  fileUrl: string;
  /** For the sender's own: sent, seen by some, seen by everybody. */
  seen: "sent" | "some" | "all" | null;
  flash: boolean;
  onReact: (emoji: string | null) => void;
  onReply: () => void;
  onMenu: () => void;
  onJump: (id: string) => void;
}) {
  const { t } = useI18n();
  const T = t.team;
  const [picking, setPicking] = useState(false);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number }>({ timer: null, x: 0, y: 0 });
  useEffect(() => () => void (hold.current.timer && clearTimeout(hold.current.timer)), []);
  const mineReaction = m.reactions.find((r) => r.userIds.includes(meId))?.emoji ?? null;
  const live = !m.deleted && !m.pending && !m.failed;
  const labels = { photo: T.photo, voice: T.voice, file: T.file, deleted: T.deleted, you: T.you };

  return (
    <div className={`group relative flex max-w-[86%] items-center gap-1 sm:max-w-[78%] ${mine ? "flex-row-reverse" : ""}`}>
      <div
        className={`relative min-w-0 rounded-2xl px-3 py-2 transition-shadow duration-300 [@media(pointer:coarse)]:select-none [-webkit-touch-callout:none] ${
          mine ? "rounded-ee-md bg-brand-600 text-on-brand" : "rounded-es-md bg-sunken text-ink-900"
        } ${m.failed ? "opacity-70" : ""} ${flash ? "ring-2 ring-brand-400 ring-offset-2 ring-offset-surface" : ""} ${m.reactions.length ? "mb-3" : ""}`}
        onContextMenu={(e) => {
          if (!live) return;
          e.preventDefault();
          onMenu();
        }}
        onPointerDown={(e) => {
          if (!live || e.pointerType === "mouse") return;
          hold.current.x = e.clientX;
          hold.current.y = e.clientY;
          hold.current.timer = setTimeout(() => {
            hold.current.timer = null;
            navigator.vibrate?.(12);
            onMenu();
          }, 420);
        }}
        onPointerMove={(e) => {
          if (hold.current.timer && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > 8) {
            clearTimeout(hold.current.timer);
            hold.current.timer = null;
          }
        }}
        onPointerUp={() => {
          if (hold.current.timer) clearTimeout(hold.current.timer);
          hold.current.timer = null;
        }}
        onPointerCancel={() => {
          if (hold.current.timer) clearTimeout(hold.current.timer);
          hold.current.timer = null;
        }}
        data-team-bubble={m.id}
      >
        {showSender && (
          <div className="mb-0.5 text-[12px] font-semibold" style={senderColor ? { color: senderColor } : undefined} dir="auto">
            {m.senderName ?? T.formerMember}
          </div>
        )}
        {m.deleted ? (
          <span className="text-[13px] italic opacity-70">{T.deleted}</span>
        ) : (
          <>
            {m.forwarded && (
              <div className="mb-0.5 flex items-center gap-1 text-[11.5px] italic opacity-75" data-team-forwarded>
                <Forward className="h-3 w-3" />
                {T.forwarded}
              </div>
            )}
            {m.replyTo && <QuoteLine q={m.replyTo} label={labels} mine={mine} onClick={() => onJump(m.replyTo!.id)} />}
            {m.file &&
              (m.pending ? (
                <span className="block text-[13px] opacity-80">{m.file.name}…</span>
              ) : m.file.mime.startsWith("image/") ? (
                <a href={fileUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind a session, not something Next can optimise */}
                  <img src={fileUrl} alt={T.photo} loading="lazy" className="mb-1 max-h-64 rounded-lg object-contain" />
                </a>
              ) : m.file.mime.startsWith("audio/") ? (
                <div className="mb-1">
                  <VoiceNote src={fileUrl} seconds={m.file.seconds} label={T.voice} />
                </div>
              ) : (
                <a href={fileUrl} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold underline">
                  <Paperclip className="h-3.5 w-3.5" />
                  <span className="truncate" dir="auto">
                    {m.file.name}
                  </span>
                </a>
              ))}
            {m.body && (
              <p className="whitespace-pre-wrap break-words text-[14px] leading-snug" dir="auto">
                <MessageBody text={m.body} mentions={mentions} mine={mine} />
              </p>
            )}
          </>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10.5px] opacity-75">
          {m.editedAt && <span className="italic" data-team-edited>{T.edited}</span>}
          {m.failed ? (
            <button type="button" onClick={m.retry} className="font-semibold underline">
              {T.retry}
            </button>
          ) : (
            <span className="tnum">{m.pending ? "…" : time}</span>
          )}
          {mine && seen && !m.deleted && (
            <span data-team-seen={seen} aria-label={seen === "all" ? T.seen : T.sent} className="inline-flex">
              {seen === "sent" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <CheckCheck className={`h-3.5 w-3.5 ${seen === "all" ? "text-sky-300" : ""}`} />
              )}
            </span>
          )}
        </div>

        {m.reactions.length > 0 && (
          <div className={`absolute -bottom-3.5 flex gap-0.5 ${mine ? "end-2" : "start-2"}`}>
            {m.reactions.map((r) => {
              const me = r.userIds.includes(meId);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => onReact(me ? null : r.emoji)}
                  title={reactionNames(r.userIds)}
                  className={`flex h-6 items-center gap-0.5 rounded-full border bg-surface px-1.5 text-[12.5px] leading-none text-ink-700 shadow-card ${me ? "border-brand-400" : "border-line"}`}
                  data-team-reaction={r.emoji}
                  aria-pressed={me}
                >
                  <span>{r.emoji}</span>
                  {r.userIds.length > 1 && <span className="text-[11px] font-semibold tnum">{r.userIds.length}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* A pointer's quick tools, beside the message on hover. */}
      {live && (
        <div className="relative hidden shrink-0 items-center gap-0.5 [@media(hover:hover)]:group-hover:flex [@media(hover:hover)]:group-focus-within:flex">
          <button type="button" onClick={() => setPicking((p) => !p)} aria-label={T.react} title={T.react} className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-sunken" data-team-react-open>
            <SmilePlus className="h-4 w-4" />
          </button>
          <button type="button" onClick={onReply} aria-label={T.reply} title={T.reply} className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-sunken" data-team-reply>
            <CornerUpLeft className="h-4 w-4 rtl:-scale-x-100" />
          </button>
          <button type="button" onClick={onMenu} aria-label={T.options} title={T.options} className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-sunken" data-team-more>
            <MoreVertical className="h-4 w-4" />
          </button>
          {picking && (
            <div
              className={`absolute bottom-9 z-20 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-pop ${mine ? "end-0" : "start-0"}`}
              onMouseLeave={() => setPicking(false)}
            >
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    setPicking(false);
                    onReact(mineReaction === e ? null : e);
                  }}
                  className={`grid h-9 w-9 place-items-center rounded-full text-[20px] transition-transform hover:scale-125 ${mineReaction === e ? "bg-brand-100" : ""}`}
                  data-team-react={e}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
