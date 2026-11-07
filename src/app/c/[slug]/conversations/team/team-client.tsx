"use client";

/*
  The team chat: the room everybody is in, private threads, groups.

  Laid out like the patient inbox beside it, so a receptionist moving between
  the two finds things where they were: the list on the start side, the thread
  beside it, and on a phone one at a time.

  A message shows the moment it is sent and is confirmed when the server
  answers, carrying the id the browser gave it, so a retry is the same message
  rather than a second one.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BellOff, Bell, Paperclip, Plus, Send, Trash2, Users, LogOut, Pencil, UserPlus } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Avatar } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { VoiceRecorder } from "@/components/voice-recorder";
import { VoiceNote } from "@/components/voice-note";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { ConversationsSwitch } from "../conversations-switch";
import type { TeamMessage, TeamPerson, TeamThread } from "@/lib/team-chat";

type Local = TeamMessage & { pending?: boolean; failed?: boolean; retry?: () => void };

const MAX_FILE = 16 * 1024 * 1024;

export function TeamClient({
  slug,
  tz,
  meId,
  showPatients,
  initialOpenId,
}: {
  slug: string;
  tz: string;
  meId: string;
  /** Whether this person also has the patient inbox, so the switch between the two is offered. */
  showPatients: boolean;
  initialOpenId: string | null;
}) {
  const { t, locale } = useI18n();
  const T = t.team;
  const { toast } = useToast();
  const api = `/api/c/${slug}/team`;

  const [threads, setThreads] = useState<TeamThread[] | null>(null);
  const [people, setPeople] = useState<TeamPerson[]>([]);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [messages, setMessages] = useState<Record<string, Local[]>>({});
  const [earlierDone, setEarlierDone] = useState<Record<string, boolean>>({});
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<null | "new" | "settings">(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A notification followed while the page is already open changes the prop, and the thread with it.
  useEffect(() => {
    if (initialOpenId) setOpenId(initialOpenId);
  }, [initialOpenId]);

  const loadThreads = useCallback(async () => {
    const r = await fetch(api, { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as { threads: TeamThread[]; people: TeamPerson[] };
    setThreads(d.threads);
    setPeople(d.people);
  }, [api]);

  const loadThread = useCallback(
    async (id: string) => {
      const r = await fetch(`${api}/${id}`, { cache: "no-store" });
      if (!r.ok) return;
      const d = (await r.json()) as { messages: TeamMessage[] };
      setMessages((all) => {
        const pending = (all[id] ?? []).filter((m) => (m.pending || m.failed) && !d.messages.some((x) => x.id === m.id));
        return { ...all, [id]: [...mergeEarlier(all[id] ?? [], d.messages), ...pending] };
      });
      if (document.visibilityState === "visible") {
        void fetch(`${api}/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "read" }) });
        setThreads((ts) => ts?.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) ?? ts);
      }
    },
    [api]
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);
  useEffect(() => {
    if (openId) void loadThread(openId);
  }, [openId, loadThread]);
  useRealtimeRefresh(slug, ["team_messages", "team_thread_members"], () => {
    void loadThreads();
    if (openId) void loadThread(openId);
  });

  const open = threads?.find((x) => x.id === openId) ?? null;
  const list = openId ? (messages[openId] ?? null) : null;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [list?.length, openId]);

  const nameOf = useCallback(
    (th: TeamThread) => {
      if (th.kind === "clinic") return T.room;
      if (th.kind === "group") return th.name ?? T.newGroup;
      return th.members.find((m) => m.userId !== meId)?.name ?? T.formerMember;
    },
    [T, meId]
  );
  const otherOf = (th: TeamThread) => th.members.find((m) => m.userId !== meId) ?? null;
  const photo = (p: TeamPerson | null) => (p?.hasPhoto && p.memberId ? `/api/c/${slug}/staff/${p.memberId}/photo` : null);

  const clock = useMemo(() => {
    const time = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { hour: "numeric", minute: "2-digit", timeZone: tz });
    const day = new Intl.DateTimeFormat(locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB", { day: "numeric", month: "short", timeZone: tz });
    const today = day.format(new Date());
    return (iso: string) => {
      const d = new Date(iso);
      return day.format(d) === today ? time.format(d) : `${day.format(d)} ${time.format(d)}`;
    };
  }, [locale, tz]);

  const preview = (th: TeamThread) => {
    const l = th.last;
    if (!l) return T.empty;
    const what = l.deleted ? T.deleted : l.body || (l.fileMime?.startsWith("image/") ? T.photo : l.fileMime?.startsWith("audio/") ? T.voice : (l.fileName ?? T.file));
    const who = l.senderId === meId ? T.you : th.kind === "direct" ? null : l.senderName?.split(" ")[0];
    return who ? `${who}: ${what}` : what;
  };

  /* ── Sending ─────────────────────────────────────────────────────── */
  const send = async (threadId: string, body: string, file?: { blob: Blob; name: string; seconds?: number }) => {
    const id = crypto.randomUUID();
    const local: Local = {
      id,
      threadId,
      senderId: meId,
      senderName: null,
      body,
      file: file ? { name: file.name, mime: file.blob.type, size: file.blob.size, seconds: file.seconds ?? null } : null,
      deleted: false,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    const put = (m: Local) => setMessages((all) => ({ ...all, [threadId]: [...(all[threadId] ?? []).filter((x) => x.id !== m.id), m] }));
    put(local);
    const attempt = async () => {
      put({ ...local, pending: true, failed: false });
      let res: Response;
      try {
        if (file) {
          const form = new FormData();
          form.set("id", id);
          form.set("body", body);
          form.set("file", new File([file.blob], file.name, { type: file.blob.type }));
          if (file.seconds) form.set("seconds", String(file.seconds));
          res = await fetch(`${api}/${threadId}/messages`, { method: "POST", body: form });
        } else {
          res = await fetch(`${api}/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, body }) });
        }
      } catch {
        res = new Response(null, { status: 599 });
      }
      if (!res.ok) {
        put({ ...local, pending: false, failed: true, retry: () => void attempt() });
        if (res.status === 413) toast(T.tooLarge, "error");
        return;
      }
      const d = (await res.json()) as { message: TeamMessage };
      put(d.message);
      setThreads((ts) => {
        if (!ts) return ts;
        const th = ts.find((x) => x.id === threadId);
        if (!th) return ts;
        const updated: TeamThread = {
          ...th,
          lastMessageAt: d.message.createdAt,
          last: { senderId: meId, senderName: null, body: d.message.body, fileMime: d.message.file?.mime ?? null, fileName: d.message.file?.name ?? null, deleted: false },
        };
        return [...ts.filter((x) => x.kind === "clinic" && x.id !== threadId), updated, ...ts.filter((x) => x.id !== threadId && x.kind !== "clinic")].sort((a, b) =>
          a.kind === "clinic" ? -1 : b.kind === "clinic" ? 1 : 0
        );
      });
    };
    await attempt();
  };

  const submit = () => {
    if (!openId || !text.trim()) return;
    const body = text;
    setText("");
    void send(openId, body);
  };

  const attach = (f: File | undefined) => {
    if (!f || !openId) return;
    if (f.size > MAX_FILE) {
      toast(T.tooLarge, "error");
      return;
    }
    const body = text;
    setText("");
    void send(openId, body, { blob: f, name: f.name });
  };

  const removeMessage = async (m: Local) => {
    setMessages((all) => ({ ...all, [m.threadId]: (all[m.threadId] ?? []).map((x) => (x.id === m.id ? { ...x, deleted: true, body: "", file: null } : x)) }));
    const r = await fetch(`${api}/messages/${m.id}`, { method: "DELETE" });
    if (!r.ok) {
      toast(t.common.genericError, "error");
      if (openId) void loadThread(openId);
    }
  };

  const earlier = async () => {
    if (!openId || !list?.length) return;
    const r = await fetch(`${api}/${openId}?before=${encodeURIComponent(list[0].createdAt)}`, { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as { messages: TeamMessage[] };
    if (d.messages.length === 0) setEarlierDone((x) => ({ ...x, [openId]: true }));
    setMessages((all) => ({ ...all, [openId]: [...d.messages, ...(all[openId] ?? [])] }));
  };

  const act = async (body: Record<string, unknown>) => {
    if (!openId) return false;
    const r = await fetch(`${api}/${openId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      toast(t.common.genericError, "error");
      return false;
    }
    await loadThreads();
    return true;
  };

  const startDirect = async (userId: string) => {
    const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "direct", userId }) });
    if (!r.ok) return toast(t.common.genericError, "error");
    const { id } = (await r.json()) as { id: string };
    setSheet(null);
    await loadThreads();
    setOpenId(id);
  };
  const startGroup = async (name: string, userIds: string[]) => {
    const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "group", name, userIds }) });
    if (!r.ok) return toast(t.common.genericError, "error");
    const { id } = (await r.json()) as { id: string };
    setSheet(null);
    await loadThreads();
    setOpenId(id);
  };

  const fileUrl = (m: TeamMessage) => `${api}/messages/${m.id}`;

  return (
    <div className="flex h-[calc(100dvh_-_11.5rem_-_env(safe-area-inset-top))] overflow-hidden rounded-card border border-line bg-surface shadow-card md:h-[calc(100dvh-5rem)]" data-team>
      {/* ------ List pane ------ */}
      <div className={`flex w-full flex-col border-e border-line lg:w-[17rem] xl:w-80 ${openId ? "hidden lg:flex" : ""}`}>
        <div className="flex items-center gap-2 border-b border-line p-3">
          {showPatients ? <ConversationsSwitch slug={slug} active="team" /> : <h1 className="flex-1 text-[15px] font-semibold">{T.title}</h1>}
          <Button size="sm" variant="outline" onClick={() => setSheet("new")} className="ms-auto min-h-9" data-team-new>
            <Plus className="h-4 w-4" />
            {T.newChat}
          </Button>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto" data-team-threads>
          {threads === null && <li className="p-4 text-[13px] text-ink-500">…</li>}
          {threads?.map((th) => {
            const other = th.kind === "direct" ? otherOf(th) : null;
            return (
              <li key={th.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(th.id)}
                  className={`flex w-full touch-manipulation items-center gap-3 px-3 py-3 text-start transition-colors hover:bg-sunken ${th.id === openId ? "bg-sunken" : ""}`}
                  data-team-thread={th.kind === "clinic" ? "room" : th.id}
                >
                  {th.kind === "direct" ? (
                    <Avatar name={other?.name ?? "?"} size={38} src={photo(other)} color={other?.color ?? undefined} />
                  ) : (
                    <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                      <Users className="h-[18px] w-[18px]" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`truncate text-[14px] ${th.unread ? "font-semibold" : "font-medium"}`} dir="auto">
                        {nameOf(th)}
                      </span>
                      {th.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-label={T.muted} />}
                      {th.lastMessageAt && <span className="ms-auto shrink-0 text-[11.5px] text-ink-400 tnum">{clock(th.lastMessageAt)}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] text-ink-500" dir="auto">
                        {preview(th)}
                      </span>
                      {th.unread > 0 && (
                        <span className="ms-auto min-w-[20px] shrink-0 rounded-full bg-brand-600 px-1.5 text-center text-[11px] font-semibold leading-5 text-on-brand tnum" data-team-unread={th.unread}>
                          {th.unread > 99 ? "99+" : th.unread}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ------ Thread pane ------ */}
      <div className={`min-w-0 flex-1 flex-col ${openId ? "flex" : "hidden lg:flex"}`}>
        {!open ? (
          <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-ink-500">{threads?.length ? T.pick : "…"}</div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <button type="button" onClick={() => setOpenId(null)} aria-label={T.back} className="grid h-10 w-10 place-items-center rounded-full text-ink-500 hover:bg-sunken lg:hidden">
                <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold" dir="auto" data-team-title>
                  {nameOf(open)}
                </div>
                {open.kind !== "direct" && <div className="text-[12px] text-ink-500">{T.members.replace("{n}", String(open.members.length))}</div>}
              </div>
              <button
                type="button"
                onClick={() => void act({ op: "mute", muted: !open.muted })}
                aria-label={open.muted ? T.unmute : T.mute}
                title={open.muted ? T.unmute : T.mute}
                className="grid h-10 w-10 place-items-center rounded-full text-ink-500 hover:bg-sunken"
                data-team-mute
              >
                {open.muted ? <BellOff className="h-[18px] w-[18px]" /> : <Bell className="h-[18px] w-[18px]" />}
              </button>
              {open.kind === "group" && (
                <button type="button" onClick={() => setSheet("settings")} aria-label={T.settings} className="grid h-10 w-10 place-items-center rounded-full text-ink-500 hover:bg-sunken" data-team-settings>
                  <Users className="h-[18px] w-[18px]" />
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-team-messages>
              {list && list.length >= 60 && !earlierDone[open.id] && (
                <div className="mb-3 text-center">
                  <button type="button" onClick={() => void earlier()} className="text-[12.5px] font-semibold text-brand-700 hover:underline">
                    {T.earlier}
                  </button>
                </div>
              )}
              {list?.length === 0 && <p className="py-10 text-center text-[13px] text-ink-500">{T.empty}</p>}
              <ul className="grid gap-2">
                {list?.map((m) => {
                  const mine = m.senderId === meId;
                  return (
                    <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`} data-team-message={m.id}>
                      <div className={`group max-w-[82%] rounded-2xl px-3 py-2 ${mine ? "bg-brand-600 text-on-brand" : "bg-sunken text-ink-900"} ${m.failed ? "opacity-70" : ""}`}>
                        {!mine && open.kind !== "direct" && <div className="mb-0.5 text-[12px] font-semibold opacity-80" dir="auto">{m.senderName ?? T.formerMember}</div>}
                        {m.deleted ? (
                          <span className="text-[13px] italic opacity-70">{T.deleted}</span>
                        ) : (
                          <>
                            {m.file &&
                              (m.pending ? (
                                <span className="block text-[13px] opacity-80">{m.file.name}…</span>
                              ) : m.file.mime.startsWith("image/") ? (
                                <a href={fileUrl(m)} target="_blank" rel="noreferrer">
                                  {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind a session, not something Next can optimise */}
                                  <img src={fileUrl(m)} alt={T.photo} loading="lazy" className="mb-1 max-h-64 rounded-lg object-contain" />
                                </a>
                              ) : m.file.mime.startsWith("audio/") ? (
                                <div className="mb-1">
                                  <VoiceNote src={fileUrl(m)} seconds={m.file.seconds} label={T.voice} />
                                </div>
                              ) : (
                                <a href={fileUrl(m)} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold underline">
                                  <Paperclip className="h-3.5 w-3.5" />
                                  <span className="truncate" dir="auto">{m.file.name}</span>
                                </a>
                              ))}
                            {m.body && (
                              <p className="whitespace-pre-wrap break-words text-[14px] leading-snug" dir="auto">
                                {m.body}
                              </p>
                            )}
                          </>
                        )}
                        <div className="mt-0.5 flex items-center justify-end gap-2 text-[10.5px] opacity-70">
                          {m.failed ? (
                            <button type="button" onClick={m.retry} className="font-semibold underline">
                              {T.retry}
                            </button>
                          ) : (
                            <span className="tnum">{m.pending ? "…" : clock(m.createdAt)}</span>
                          )}
                          {mine && !m.deleted && !m.pending && !m.failed && (
                            <button type="button" onClick={() => void removeMessage(m)} aria-label={T.delete} className="opacity-60 hover:opacity-100" data-team-delete>
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div ref={bottom} />
            </div>

            <div className="border-t border-line p-2.5">
              <div className="flex items-end gap-1.5">
                <input ref={fileInput} type="file" className="hidden" onChange={(e) => (attach(e.target.files?.[0]), (e.target.value = ""))} data-team-file />
                <button type="button" onClick={() => fileInput.current?.click()} aria-label={T.attach} title={T.attach} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken">
                  <Paperclip className="h-5 w-5" />
                </button>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={1}
                  maxLength={4000}
                  placeholder={T.write}
                  dir="auto"
                  className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-line bg-sunken px-3 py-2 text-[16px] outline-none focus:border-brand-400 sm:text-[14px]"
                  data-team-input
                />
                {text.trim() ? (
                  <button type="button" onClick={submit} aria-label={T.send} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-on-brand" data-team-send>
                    <Send className="h-[18px] w-[18px] rtl:rotate-180" />
                  </button>
                ) : (
                  <VoiceRecorder
                    immediate
                    onReady={(rec) => {
                      if (!rec || !openId) return;
                      const ext = rec.blob.type.includes("mp4") ? "m4a" : rec.blob.type.includes("ogg") ? "ogg" : "webm";
                      void send(openId, "", { blob: rec.blob, name: `voice-note.${ext}`, seconds: rec.seconds });
                    }}
                    labels={{
                      record: T.voice,
                      stop: t.patients.notes.stopRecording,
                      discard: t.common.delete,
                      denied: t.patients.notes.micDenied,
                      unsupported: t.patients.notes.micUnsupported,
                      noMic: t.patients.notes.micNone,
                      insecure: t.patients.notes.micInsecure,
                      retry: t.patients.notes.micRetry,
                    }}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {sheet === "new" && <NewChat people={people.filter((p) => p.userId !== meId)} slug={slug} onClose={() => setSheet(null)} onDirect={startDirect} onGroup={startGroup} />}
      {sheet === "settings" && open?.kind === "group" && (
        <GroupSettings
          thread={open}
          people={people}
          onClose={() => setSheet(null)}
          onRename={async (name) => (await act({ op: "rename", name })) && setSheet(null)}
          onAdd={async (userIds) => (await act({ op: "add", userIds })) && setSheet(null)}
          onLeave={async () => {
            if (await act({ op: "leave" })) {
              setSheet(null);
              setOpenId(null);
            }
          }}
        />
      )}
    </div>
  );
}

/** A newer page replaces what it covers; an earlier page fetched by "earlier" stays in front of it. */
function mergeEarlier(have: Local[], fresh: TeamMessage[]): Local[] {
  if (!fresh.length) return have.filter((m) => !m.pending && !m.failed);
  const from = fresh[0].createdAt;
  const before = have.filter((m) => !m.pending && !m.failed && m.createdAt < from && !fresh.some((f) => f.id === m.id));
  return [...before, ...fresh];
}

function NewChat({
  people,
  slug,
  onClose,
  onDirect,
  onGroup,
}: {
  people: TeamPerson[];
  slug: string;
  onClose: () => void;
  onDirect: (userId: string) => void;
  onGroup: (name: string, userIds: string[]) => void;
}) {
  const { t } = useI18n();
  const T = t.team;
  const [group, setGroup] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? T.newGroup : T.newChat}
      footer={
        group ? (
          <Button onClick={() => onGroup(name.trim(), [...picked])} disabled={!name.trim() || picked.size === 0} data-team-create-group>
            {T.create}
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-3">
        <button type="button" onClick={() => setGroup((g) => !g)} className="flex min-h-10 items-center gap-2 text-[14px] font-semibold text-brand-700" data-team-group-toggle>
          <Users className="h-4 w-4" />
          {group ? T.newChat : T.newGroup}
        </button>
        {group && <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={T.groupName} maxLength={60} dir="auto" data-team-group-name />}
        <ul className="divide-y divide-line">
          {people.map((p) => (
            <li key={p.userId}>
              {group ? (
                <label className="flex min-h-12 items-center gap-3 py-1.5">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={picked.has(p.userId)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(p.userId);
                        else n.delete(p.userId);
                        return n;
                      })
                    }
                    data-team-pick={p.userId}
                  />
                  <Avatar name={p.name} size={32} src={p.hasPhoto && p.memberId ? `/api/c/${slug}/staff/${p.memberId}/photo` : null} color={p.color ?? undefined} />
                  <span className="text-[14px]" dir="auto">{p.name}</span>
                </label>
              ) : (
                <button type="button" onClick={() => onDirect(p.userId)} className="flex min-h-12 w-full items-center gap-3 py-1.5 text-start hover:bg-sunken" data-team-person={p.userId}>
                  <Avatar name={p.name} size={32} src={p.hasPhoto && p.memberId ? `/api/c/${slug}/staff/${p.memberId}/photo` : null} color={p.color ?? undefined} />
                  <span className="text-[14px]" dir="auto">{p.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function GroupSettings({
  thread,
  people,
  onClose,
  onRename,
  onAdd,
  onLeave,
}: {
  thread: TeamThread;
  people: TeamPerson[];
  onClose: () => void;
  onRename: (name: string) => void;
  onAdd: (userIds: string[]) => void;
  onLeave: () => void;
}) {
  const { t } = useI18n();
  const T = t.team;
  const [name, setName] = useState(thread.name ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const outside = people.filter((p) => !thread.members.some((m) => m.userId === p.userId));
  return (
    <Modal open onClose={onClose} title={thread.name ?? T.newGroup}>
      <div className="grid gap-4">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} dir="auto" aria-label={T.groupName} data-team-rename-input />
          </div>
          <Button variant="outline" onClick={() => onRename(name.trim())} disabled={!name.trim() || name.trim() === thread.name} data-team-rename>
            <Pencil className="h-4 w-4" />
            {T.rename}
          </Button>
        </div>
        <div>
          <div className="mb-1 text-[13px] font-semibold">{T.members.replace("{n}", String(thread.members.length))}</div>
          <p className="text-[13px] text-ink-700" dir="auto">{thread.members.map((m) => m.name).join("، ")}</p>
        </div>
        {outside.length > 0 && (
          <div>
            <div className="mb-1 text-[13px] font-semibold">{T.addPeople}</div>
            <ul className="divide-y divide-line">
              {outside.map((p) => (
                <li key={p.userId}>
                  <label className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-600"
                      checked={picked.has(p.userId)}
                      onChange={(e) =>
                        setPicked((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(p.userId);
                          else n.delete(p.userId);
                          return n;
                        })
                      }
                      data-team-add-pick={p.userId}
                    />
                    <span className="text-[14px]" dir="auto">{p.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <Button className="mt-2" variant="outline" onClick={() => onAdd([...picked])} disabled={picked.size === 0} data-team-add>
              <UserPlus className="h-4 w-4" />
              {T.add}
            </Button>
          </div>
        )}
        <Button variant="danger" onClick={onLeave} data-team-leave>
          <LogOut className="h-4 w-4" />
          {T.leave}
        </Button>
      </div>
    </Modal>
  );
}
