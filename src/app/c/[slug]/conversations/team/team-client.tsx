"use client";

/*
  The team chat: the room everybody is in, private threads, groups.

  Laid out like the patient inbox beside it, so a receptionist moving between
  the two finds things where they were: the list on the start side, the thread
  beside it, and on a phone one at a time.

  A message shows the moment it is sent and is confirmed when the server
  answers, carrying the id the browser gave it, so a retry is the same message
  rather than a second one.

  And it behaves like the chat apps on everybody's phone (Yamen, 2026-11-07):
  reply to a message, react to it, forward it, pin it, correct it for a short
  while, @mention a colleague, see who is typing and who has seen it, search
  every thread, pin a thread to the top, mark one unread, paste or drop a photo.
*/

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  Bell,
  BellOff,
  Copy,
  CornerUpLeft,
  Forward,
  LogOut,
  MessageSquareDot,
  MoreVertical,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Avatar } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { VoiceRecorder } from "@/components/voice-recorder";
import { useRealtime, useRealtimeRefresh } from "@/lib/use-realtime";
import { useFillHeight } from "@/lib/use-fill-height";
import { teamView } from "@/lib/team-view";
import { EDIT_MINUTES, QUICK_REACTIONS, shortName } from "@/lib/team-chat-shared";
import { ConversationsSwitch } from "../conversations-switch";
import { Bubble, QuoteLine, type Local } from "./team-message";
import type { TeamHit, TeamMessage, TeamPerson, TeamQuote, TeamThread } from "@/lib/team-chat";

const MAX_FILE = 16 * 1024 * 1024;
/** How long "… is typing" stays without being said again. */
const TYPING_MS = 5000;

export function TeamClient({
  slug,
  tz,
  meId,
  showPatients,
  initialOpenId,
  initialMessageId = null,
  initialReply = false,
}: {
  slug: string;
  tz: string;
  meId: string;
  /** Whether this person also has the patient inbox, so the switch between the two is offered. */
  showPatients: boolean;
  initialOpenId: string | null;
  /** A message to bring into view, from a notification about it. */
  initialMessageId?: string | null;
  /** Opened from a notification's Reply: the box is ready to type in. */
  initialReply?: boolean;
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
  const [replyTo, setReplyTo] = useState<TeamQuote | null>(null);
  const [editing, setEditing] = useState<Local | null>(null);
  const [menuFor, setMenuFor] = useState<Local | null>(null);
  const [forwarding, setForwarding] = useState<Local | null>(null);
  const [chatMenu, setChatMenu] = useState(false);
  const [picked, setPicked] = useState<{ userId: string; name: string }[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<TeamHit[] | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [divider, setDivider] = useState<Record<string, string | null>>({});
  const [below, setBelow] = useState(0);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const unreadAtOpen = useRef<Record<string, number>>({});
  const firstLoad = useRef<Set<string>>(new Set());
  const lastTyping = useRef(0);
  // As tall as the screen has room for, the box to type in always above the tab bar.
  const frame = useRef<HTMLDivElement>(null);
  useFillHeight(frame);
  const pendingJump = useRef<string | null>(initialMessageId);
  const wantReply = useRef(initialReply);

  // A notification followed while the page is already open changes the prop, and the thread with it.
  useEffect(() => {
    if (initialOpenId) setOpenId(initialOpenId);
  }, [initialOpenId]);
  useEffect(() => {
    if (initialMessageId) pendingJump.current = initialMessageId;
  }, [initialMessageId]);

  // The header's pop-ups stay quiet about the thread in front of you.
  useEffect(() => {
    teamView.openThreadId = openId;
    return () => {
      teamView.openThreadId = null;
    };
  }, [openId]);

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
    if (!openId) return;
    // How much was new when it was opened, for the "new" line; read before loading clears it.
    unreadAtOpen.current[openId] = threads?.find((x) => x.id === openId)?.unread ?? 0;
    void loadThread(openId);
    setReplyTo(null);
    setEditing(null);
    setPicked([]);
    setBelow(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the count is taken once, as the thread opens
  }, [openId, loadThread]);
  useRealtimeRefresh(slug, ["team_messages", "team_thread_members"], () => {
    void loadThreads();
    if (openId) void loadThread(openId);
  });
  // Back to the tab: what arrived meanwhile is read now that it is seen.
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && openId && void loadThread(openId);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [openId, loadThread]);

  /* ── Typing ──────────────────────────────────────────────────────── */
  useRealtime(slug, ["team_typing"], (e) => {
    const ev = e as (typeof e & { by?: string }) | null;
    if (!ev?.id || !ev.by || ev.by === meId) return;
    setTyping((all) => ({ ...all, [ev.id!]: { ...(all[ev.id!] ?? {}), [ev.by!]: Date.now() + TYPING_MS } }));
  });
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTyping((all) => {
        let changed = false;
        const next: typeof all = {};
        for (const [th, who] of Object.entries(all)) {
          const live = Object.fromEntries(Object.entries(who).filter(([, until]) => until > now));
          if (Object.keys(live).length !== Object.keys(who).length) changed = true;
          if (Object.keys(live).length) next[th] = live;
        }
        return changed ? next : all;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  // A new message from somebody ends their typing at once; one they sent before does not.
  const lastSeen = useRef<Record<string, string | undefined>>({});
  useEffect(() => {
    if (!openId) return;
    const last = messages[openId]?.at(-1);
    if (!last || lastSeen.current[openId] === last.id) return;
    const isNew = lastSeen.current[openId] !== undefined;
    lastSeen.current[openId] = last.id;
    if (isNew && last.senderId) {
      setTyping((all) => {
        if (!all[openId]?.[last.senderId!]) return all;
        const who = { ...all[openId] };
        delete who[last.senderId!];
        return { ...all, [openId]: who };
      });
    }
  }, [messages, openId]);
  const sayTyping = () => {
    if (!openId || Date.now() - lastTyping.current < 3000) return;
    lastTyping.current = Date.now();
    void fetch(`${api}/${openId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "typing" }) }).catch(() => {});
  };

  const open = threads?.find((x) => x.id === openId) ?? null;
  const list = openId ? (messages[openId] ?? null) : null;

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
  const personById = useMemo(() => new Map(people.map((p) => [p.userId, p])), [people]);
  const firstName = (id: string) => shortName(personById.get(id)?.name) || T.formerMember;

  const typingLine = (threadId: string) => {
    const who = Object.keys(typing[threadId] ?? {});
    if (!who.length) return null;
    return who.length === 1 ? T.typing.replace("{name}", firstName(who[0])) : T.typingMany.replace("{n}", String(who.length));
  };

  const fmt = useMemo(() => {
    const loc = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
    const time = new Intl.DateTimeFormat(loc, { hour: "numeric", minute: "2-digit", timeZone: tz });
    const day = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", timeZone: tz });
    const longDay = new Intl.DateTimeFormat(loc, { weekday: "long", day: "numeric", month: "long", timeZone: tz });
    const key = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz });
    const today = () => key.format(new Date());
    const yesterday = () => key.format(new Date(Date.now() - 86_400_000));
    return {
      time: (iso: string) => time.format(new Date(iso)),
      list: (iso: string) => (key.format(new Date(iso)) === today() ? time.format(new Date(iso)) : day.format(new Date(iso))),
      dayKey: (iso: string) => key.format(new Date(iso)),
      dayLabel: (iso: string) => {
        const k = key.format(new Date(iso));
        return k === today() ? T.today : k === yesterday() ? T.yesterday : longDay.format(new Date(iso));
      },
    };
  }, [locale, tz, T]);

  const preview = (th: TeamThread) => {
    const l = th.last;
    if (!l) return T.empty;
    const what = l.deleted ? T.deleted : l.body || (l.fileMime?.startsWith("image/") ? `📷 ${T.photo}` : l.fileMime?.startsWith("audio/") ? `🎤 ${T.voice}` : `📎 ${l.fileName ?? T.file}`);
    const who = l.senderId === meId ? T.you : th.kind === "direct" ? null : shortName(l.senderName);
    return who ? `${who}: ${what}` : what;
  };

  /* ── Scrolling ───────────────────────────────────────────────────── */
  const nearBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };
  const toBottom = (smooth = true) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setBelow(0);
  };
  const lastId = list?.at(-1)?.id;
  useEffect(() => {
    if (!openId || !list) return;
    if (!firstLoad.current.has(openId)) {
      firstLoad.current.add(openId);
      // Opened on what is new: the "new" line in view, not the bottom.
      const n = unreadAtOpen.current[openId] ?? 0;
      const fromOthers = list.filter((m) => m.senderId !== meId);
      const first = n > 0 ? fromOthers.at(-n) : undefined;
      setDivider((d) => ({ ...d, [openId]: first?.id ?? null }));
      requestAnimationFrame(() => {
        const at = first && document.querySelector(`[data-team-message="${first.id}"]`);
        if (at) at.scrollIntoView({ block: "center" });
        else toBottom(false);
      });
      return;
    }
    const last = list.at(-1);
    if (last?.senderId === meId || nearBottom()) requestAnimationFrame(() => toBottom());
    else setBelow((b) => b + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the newest message, not every re-read
  }, [lastId, openId]);

  /** Brings a message into view and lights it up, reaching back through earlier pages if it is not loaded. */
  const jumpTo = useCallback(
    async (id: string) => {
      if (!openId) return;
      for (let i = 0; i < 12; i++) {
        const el = document.querySelector(`[data-team-message="${id}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          setFlash(id);
          setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
          return;
        }
        const have = messages[openId];
        if (!have?.length) return;
        const r = await fetch(`${api}/${openId}?before=${encodeURIComponent(have[0].createdAt)}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { messages: TeamMessage[] };
        if (!d.messages.length) return;
        setMessages((all) => ({ ...all, [openId]: [...d.messages, ...(all[openId] ?? [])] }));
        await new Promise((res) => setTimeout(res, 60));
      }
    },
    [api, messages, openId]
  );
  // From a notification: the message it was about, or the box ready for a reply.
  useEffect(() => {
    if (!list?.length) return;
    if (pendingJump.current) {
      const id = pendingJump.current;
      pendingJump.current = null;
      setTimeout(() => void jumpTo(id), 120);
    }
    if (wantReply.current) {
      wantReply.current = false;
      input.current?.focus();
    }
  }, [list, jumpTo]);

  /* ── Sending ─────────────────────────────────────────────────────── */
  const send = async (threadId: string, body: string, opts: { file?: { blob: Blob; name: string; seconds?: number }; replyTo?: TeamQuote | null; mentions?: string[] } = {}) => {
    const { file, mentions = [] } = opts;
    const quoted = opts.replyTo ?? null;
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
      replyTo: quoted,
      editedAt: null,
      forwarded: false,
      mentions,
      reactions: [],
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
          if (quoted) form.set("replyTo", quoted.id);
          if (mentions.length) form.set("mentions", mentions.join(","));
          res = await fetch(`${api}/${threadId}/messages`, { method: "POST", body: form });
        } else {
          res = await fetch(`${api}/${threadId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, body, replyTo: quoted?.id ?? null, mentions }),
          });
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
        return ts.map((x) => (x.id === threadId ? updated : x));
      });
    };
    await attempt();
  };

  const mentionIds = (body: string) => [...new Set(picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.userId))];

  const submit = async () => {
    if (!openId) return;
    if (editing) {
      const body = text;
      const target = editing;
      if (!body.trim() && !target.file) return;
      setEditing(null);
      setText("");
      setMessages((all) => ({
        ...all,
        [target.threadId]: (all[target.threadId] ?? []).map((x) => (x.id === target.id ? { ...x, body, editedAt: new Date().toISOString() } : x)),
      }));
      const r = await fetch(`${api}/messages/${target.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "edit", body }) });
      if (!r.ok) {
        toast(r.status === 409 ? T.tooLate : t.common.genericError, "error");
        void loadThread(target.threadId);
      }
      return;
    }
    if (!text.trim()) return;
    const body = text;
    const quoted = replyTo;
    const mentions = mentionIds(body);
    setText("");
    setReplyTo(null);
    setPicked([]);
    setMentionQuery(null);
    void send(openId, body, { replyTo: quoted, mentions });
  };

  const attach = (f: File | undefined) => {
    if (!f || !openId) return;
    if (f.size > MAX_FILE) {
      toast(T.tooLarge, "error");
      return;
    }
    const body = text;
    const quoted = replyTo;
    setText("");
    setReplyTo(null);
    void send(openId, body, { file: { blob: f, name: f.name || "photo.png" }, replyTo: quoted, mentions: mentionIds(body) });
  };

  /* ── Doing things to a message ───────────────────────────────────── */
  const patchLocal = (m: Local, change: (x: Local) => Local) =>
    setMessages((all) => ({ ...all, [m.threadId]: (all[m.threadId] ?? []).map((x) => (x.id === m.id ? change(x) : x)) }));

  const react = async (m: Local, emoji: string | null) => {
    patchLocal(m, (x) => {
      const without = x.reactions.map((r) => ({ ...r, userIds: r.userIds.filter((u) => u !== meId) })).filter((r) => r.userIds.length);
      if (!emoji) return { ...x, reactions: without };
      const has = without.find((r) => r.emoji === emoji);
      return { ...x, reactions: has ? without.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, meId] } : r)) : [...without, { emoji, userIds: [meId] }] };
    });
    const r = await fetch(`${api}/messages/${m.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "react", emoji }) });
    if (!r.ok) {
      toast(t.common.genericError, "error");
      void loadThread(m.threadId);
    }
  };

  const removeMessage = async (m: Local) => {
    patchLocal(m, (x) => ({ ...x, deleted: true, body: "", file: null, reactions: [] }));
    const r = await fetch(`${api}/messages/${m.id}`, { method: "DELETE" });
    if (!r.ok) {
      toast(t.common.genericError, "error");
      if (openId) void loadThread(openId);
    }
  };

  const pinMessage = async (m: Local, pinned: boolean) => {
    const r = await fetch(`${api}/messages/${m.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "pin", pinned }) });
    if (!r.ok) return toast(t.common.genericError, "error");
    await loadThreads();
  };

  const quoteOf = (m: Local): TeamQuote => ({ id: m.id, senderId: m.senderId, senderName: m.senderId === meId ? T.you : m.senderName, body: m.body, fileMime: m.file?.mime ?? null, fileName: m.file?.name ?? null, deleted: false });

  const startReply = (m: Local) => {
    setEditing(null);
    setReplyTo(quoteOf(m));
    input.current?.focus();
  };
  const startEdit = (m: Local) => {
    setReplyTo(null);
    setEditing(m);
    setText(m.body);
    requestAnimationFrame(() => input.current?.focus());
  };

  const forwardTo = async (target: TeamThread) => {
    const m = forwarding;
    if (!m) return;
    setForwarding(null);
    const r = await fetch(`${api}/${target.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), forwardOf: m.id }),
    });
    if (!r.ok) return toast(t.common.genericError, "error");
    toast(T.forwardedTo.replace("{name}", nameOf(target)), "success");
    void loadThreads();
  };

  const earlier = async () => {
    if (!openId || !list?.length) return;
    const el = scroller.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const r = await fetch(`${api}/${openId}?before=${encodeURIComponent(list[0].createdAt)}`, { cache: "no-store" });
    if (!r.ok) return;
    const d = (await r.json()) as { messages: TeamMessage[] };
    if (d.messages.length === 0) setEarlierDone((x) => ({ ...x, [openId]: true }));
    setMessages((all) => ({ ...all, [openId]: [...d.messages, ...(all[openId] ?? [])] }));
    // Stay on the message that was at the top, rather than jumping.
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - fromBottom));
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

  /* ── Search ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    const timer = setTimeout(async () => {
      const r = await fetch(`${api}?q=${encodeURIComponent(term)}`, { cache: "no-store" });
      if (r.ok) setHits(((await r.json()) as { hits: TeamHit[] }).hits);
    }, 250);
    return () => clearTimeout(timer);
  }, [q, api]);
  const shownThreads = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!threads || !term) return threads;
    return threads.filter((th) => nameOf(th).toLowerCase().includes(term));
  }, [threads, q, nameOf]);

  /* ── @mentions ───────────────────────────────────────────────────── */
  const canMention = open && open.kind !== "direct";
  const mentionChoices = useMemo(() => {
    if (mentionQuery === null || !open) return [];
    const term = mentionQuery.toLowerCase();
    return open.members.filter((p) => p.userId !== meId && p.name.toLowerCase().includes(term)).slice(0, 6);
  }, [mentionQuery, open, meId]);
  const onText = (value: string, caret: number) => {
    setText(value);
    if (value.trim() && !editing) sayTyping();
    if (!canMention) return;
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    setMentionQuery(m ? m[1] : null);
  };
  const chooseMention = (p: TeamPerson) => {
    const el = input.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${p.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setPicked((xs) => (xs.some((x) => x.userId === p.userId) ? xs : [...xs, { userId: p.userId, name: p.name }]));
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  /* ── Seen ────────────────────────────────────────────────────────── */
  const seenOf = (m: Local): "sent" | "some" | "all" | null => {
    if (!open || m.senderId !== meId || m.pending || m.failed) return null;
    const others = open.members.filter((p) => p.userId !== meId);
    if (!others.length) return "sent";
    const n = others.filter((p) => p.lastReadAt && p.lastReadAt >= m.createdAt).length;
    return n === 0 ? "sent" : n === others.length ? "all" : "some";
  };
  const seenBy = (m: Local) => (open?.members ?? []).filter((p) => p.userId !== meId && p.lastReadAt && p.lastReadAt >= m.createdAt);

  const fileUrl = (m: TeamMessage) => `${api}/messages/${m.id}`;
  const mentionsFor = (m: Local) =>
    m.mentions.map((id) => ({ name: personById.get(id)?.name ?? "", me: id === meId }));
  const reactionNames = (ids: string[]) => ids.map((id) => (id === meId ? T.you : (personById.get(id)?.name ?? T.formerMember))).join("، ");
  const canEdit = (m: Local) => m.senderId === meId && !m.deleted && Date.now() - new Date(m.createdAt).getTime() < EDIT_MINUTES * 60_000;
  const typingNow = openId ? typingLine(openId) : null;

  return (
    <div ref={frame} className="flex h-[calc(100dvh_-_11.5rem_-_env(safe-area-inset-top))] overflow-hidden rounded-card border border-line bg-surface shadow-card md:h-[calc(100dvh-5rem)]" data-team>
      {/* ------ List pane ------ */}
      <div className={`flex w-full flex-col border-e border-line lg:w-[17rem] xl:w-80 ${openId ? "hidden lg:flex" : ""}`}>
        <div className="grid gap-2 border-b border-line p-3">
          <div className="flex items-center gap-2">
            {showPatients ? <ConversationsSwitch slug={slug} active="team" /> : <h1 className="flex-1 text-[15px] font-semibold">{T.title}</h1>}
            <Button size="sm" variant="outline" onClick={() => setSheet("new")} className="ms-auto min-h-9" data-team-new>
              <Plus className="h-4 w-4" />
              {T.newChat}
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={T.search}
              className="h-9 w-full rounded-full border border-line bg-sunken pe-8 ps-9 text-[16px] outline-none focus:border-brand-400 sm:text-sm"
              dir="auto"
              data-team-search
            />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label={T.cancel} className="absolute end-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-ink-400 hover:bg-surface">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto" data-team-threads>
          {threads === null && <li className="p-4 text-[13px] text-ink-500">…</li>}
          {shownThreads?.map((th) => {
            const other = th.kind === "direct" ? otherOf(th) : null;
            const typingHere = typingLine(th.id);
            return (
              <li key={th.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(th.id)}
                  className={`flex w-full touch-manipulation items-center gap-3 px-3 py-3 text-start transition-colors hover:bg-sunken ${th.id === openId ? "bg-sunken" : ""}`}
                  data-team-thread={th.kind === "clinic" ? "room" : th.id}
                >
                  {th.kind === "direct" ? (
                    <Avatar name={other?.name ?? "?"} size={42} src={photo(other)} color={other?.color ?? undefined} />
                  ) : (
                    <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                      <Users className="h-5 w-5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={`truncate text-[14px] ${th.unread ? "font-semibold" : "font-medium"}`} dir="auto">
                        {nameOf(th)}
                      </span>
                      {th.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-label={T.muted} />}
                      {th.lastMessageAt && <span className={`ms-auto shrink-0 text-[11.5px] tnum ${th.unread ? "font-semibold text-brand-700" : "text-ink-400"}`}>{fmt.list(th.lastMessageAt)}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      {typingHere ? (
                        <span className="truncate text-[12.5px] font-medium italic text-brand-700" data-team-typing-list>
                          {typingHere}
                        </span>
                      ) : (
                        <span className="truncate text-[12.5px] text-ink-500" dir="auto">
                          {preview(th)}
                        </span>
                      )}
                      <span className="ms-auto flex shrink-0 items-center gap-1">
                        {th.pinned && <Pin className="h-3.5 w-3.5 rotate-45 text-ink-400" aria-label={T.pinnedChat} data-team-pinned-chat />}
                        {th.unread > 0 && (
                          <span className="min-w-[20px] rounded-full bg-brand-600 px-1.5 text-center text-[11px] font-semibold leading-5 text-on-brand tnum" data-team-unread={th.unread}>
                            {th.unread > 99 ? "99+" : th.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {hits && (
            <li className="bg-sunken/60 px-3 py-2 text-[12px] font-semibold text-ink-500" data-team-hits={hits.length}>
              {T.search}
            </li>
          )}
          {hits?.length === 0 && <li className="px-3 py-3 text-[13px] text-ink-500">{T.searchEmpty}</li>}
          {hits?.map((h) => {
            const th = threads?.find((x) => x.id === h.threadId);
            return (
              <li key={h.messageId}>
                <button
                  type="button"
                  onClick={() => {
                    pendingJump.current = h.messageId;
                    if (openId === h.threadId) void jumpTo(h.messageId);
                    setOpenId(h.threadId);
                  }}
                  className="block w-full px-3 py-2.5 text-start hover:bg-sunken"
                  data-team-hit={h.messageId}
                >
                  <span className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="truncate font-semibold" dir="auto">
                      {th ? nameOf(th) : ""}
                    </span>
                    <span className="ms-auto shrink-0 text-[11px] text-ink-400 tnum">{fmt.list(h.createdAt)}</span>
                  </span>
                  <span className="line-clamp-2 text-[13px] text-ink-700" dir="auto">
                    {h.senderName ? `${shortName(h.senderName)}: ` : ""}
                    {h.body}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ------ Thread pane ------ */}
      <div
        className={`relative min-w-0 flex-1 flex-col ${openId ? "flex" : "hidden lg:flex"}`}
        onDragOver={(e) => {
          if (!open || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          if (!open) return;
          e.preventDefault();
          setDragging(false);
          attach(e.dataTransfer.files?.[0]);
        }}
      >
        {!open ? (
          <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-ink-500">{threads?.length ? T.pick : "…"}</div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-line px-2 py-2 sm:px-3">
              <button type="button" onClick={() => setOpenId(null)} aria-label={T.back} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken lg:hidden">
                <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
              </button>
              {open.kind === "direct" ? (
                <Avatar name={otherOf(open)?.name ?? "?"} size={38} src={photo(otherOf(open))} color={otherOf(open)?.color ?? undefined} />
              ) : (
                <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                  <Users className="h-[18px] w-[18px]" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold" dir="auto" data-team-title>
                  {nameOf(open)}
                </div>
                {typingNow ? (
                  <div className="truncate text-[12px] font-medium italic text-brand-700" data-team-typing>
                    {typingNow}
                  </div>
                ) : (
                  open.kind !== "direct" && <div className="truncate text-[12px] text-ink-500">{T.members.replace("{n}", String(open.members.length))}</div>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setChatMenu((x) => !x)}
                  aria-label={T.chatOptions}
                  aria-expanded={chatMenu}
                  className="grid h-10 w-10 place-items-center rounded-full text-ink-500 hover:bg-sunken"
                  data-team-chat-menu
                >
                  <MoreVertical className="h-[18px] w-[18px]" />
                </button>
                {chatMenu && (
                  <>
                    <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-20 cursor-default" onClick={() => setChatMenu(false)} />
                    <div className="absolute end-0 top-11 z-30 grid w-56 overflow-hidden rounded-card border border-line bg-surface py-1 shadow-pop" role="menu">
                      <MenuItem
                        icon={open.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                        label={open.pinned ? T.unpinChat : T.pinChat}
                        onClick={() => (setChatMenu(false), void act({ op: "pin", pinned: !open.pinned }))}
                        data="pin"
                      />
                      <MenuItem
                        icon={open.muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                        label={open.muted ? T.unmute : T.mute}
                        onClick={() => (setChatMenu(false), void act({ op: "mute", muted: !open.muted }))}
                        data="mute"
                      />
                      <MenuItem
                        icon={<MessageSquareDot className="h-4 w-4" />}
                        label={T.markUnread}
                        onClick={async () => {
                          setChatMenu(false);
                          const id = open.id;
                          setOpenId(null);
                          await fetch(`${api}/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "unread" }) });
                          await loadThreads();
                        }}
                        data="unread"
                      />
                      {open.kind === "group" && <MenuItem icon={<Users className="h-4 w-4" />} label={T.settings} onClick={() => (setChatMenu(false), setSheet("settings"))} data="settings" />}
                    </div>
                  </>
                )}
              </div>
            </div>

            {open.pinnedMessage && (
              <div className="flex items-center gap-2 border-b border-line bg-sunken/60 px-3 py-1.5" data-team-pinned={open.pinnedMessage.id}>
                <Pin className="h-4 w-4 shrink-0 rotate-45 text-brand-700" />
                <button type="button" onClick={() => void jumpTo(open.pinnedMessage!.id)} className="min-w-0 flex-1 text-start">
                  <span className="block text-[11.5px] font-semibold text-brand-700">{T.pinned}</span>
                  <span className="block truncate text-[13px] text-ink-700" dir="auto">
                    {open.pinnedMessage.body || (open.pinnedMessage.fileMime?.startsWith("image/") ? `📷 ${T.photo}` : `📎 ${open.pinnedMessage.fileName ?? T.file}`)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void pinMessage({ id: open.pinnedMessage!.id, threadId: open.id } as Local, false)}
                  aria-label={T.unpin}
                  className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-surface"
                  data-team-unpin
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            <div ref={scroller} onScroll={() => nearBottom() && below && setBelow(0)} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-team-messages>
              {list && list.length >= 60 && !earlierDone[open.id] && (
                <div className="mb-3 text-center">
                  <button type="button" onClick={() => void earlier()} className="text-[12.5px] font-semibold text-brand-700 hover:underline">
                    {T.earlier}
                  </button>
                </div>
              )}
              {list?.length === 0 && <p className="py-10 text-center text-[13px] text-ink-500">{T.empty}</p>}
              <ul className="grid gap-1">
                {list?.map((m, i) => {
                  const prev = list[i - 1];
                  const mine = m.senderId === meId;
                  const newDay = !prev || fmt.dayKey(prev.createdAt) !== fmt.dayKey(m.createdAt);
                  const run = !newDay && prev?.senderId === m.senderId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
                  const isDivider = divider[open.id] === m.id;
                  return (
                    <Fragment key={m.id}>
                      {newDay && (
                        <li className="sticky top-0 z-10 my-2 flex justify-center" aria-hidden>
                          <span className="rounded-full bg-surface/95 px-3 py-0.5 text-[11.5px] font-semibold text-ink-500 shadow-card">{fmt.dayLabel(m.createdAt)}</span>
                        </li>
                      )}
                      {isDivider && (
                        <li className="my-2 flex items-center gap-2 text-[11.5px] font-semibold text-brand-700" data-team-new-line>
                          <span className="h-px flex-1 bg-brand-200" />
                          {T.newMessages.replace("{n}", String(unreadAtOpen.current[open.id] ?? ""))}
                          <span className="h-px flex-1 bg-brand-200" />
                        </li>
                      )}
                      <li className={`flex ${mine ? "justify-end" : "justify-start"} ${run ? "" : "mt-1.5"}`} data-team-message={m.id}>
                        <Bubble
                          m={m}
                          mine={mine}
                          showSender={!mine && open.kind !== "direct" && !run}
                          senderColor={m.senderId ? (personById.get(m.senderId)?.color ?? null) : null}
                          mentions={mentionsFor(m)}
                          reactionNames={reactionNames}
                          meId={meId}
                          time={fmt.time(m.createdAt)}
                          fileUrl={fileUrl(m)}
                          seen={seenOf(m)}
                          flash={flash === m.id}
                          onReact={(e) => void react(m, e)}
                          onReply={() => startReply(m)}
                          onMenu={() => setMenuFor(m)}
                          onJump={(id) => void jumpTo(id)}
                        />
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
              {typingNow && (
                <div className="mt-2 flex" aria-live="polite">
                  <span className="flex items-center gap-1 rounded-2xl rounded-es-md bg-sunken px-3 py-2.5" aria-label={typingNow}>
                    {[0, 1, 2].map((d) => (
                      <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400" style={{ animationDelay: `${d * 140}ms` }} />
                    ))}
                  </span>
                </div>
              )}
            </div>

            {below > 0 && (
              <button
                type="button"
                onClick={() => toBottom()}
                className="absolute bottom-20 end-4 z-10 flex h-10 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[12.5px] font-semibold text-brand-700 shadow-pop"
                data-team-below={below}
              >
                <ArrowDown className="h-4 w-4" />
                {below}
              </button>
            )}

            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-brand-600/10 text-[15px] font-semibold text-brand-700 ring-2 ring-inset ring-brand-400">
                {T.dropHere}
              </div>
            )}

            <div className="border-t border-line p-2.5">
              {(replyTo || editing) && (
                <div className="mb-2 flex items-start gap-2" data-team-composing={editing ? "edit" : "reply"}>
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <div className="rounded-lg border-s-[3px] border-brand-600 bg-sunken px-2 py-1">
                        <span className="block text-[12px] font-semibold text-brand-700">{T.editing}</span>
                        <span className="block truncate text-[12.5px] text-ink-500" dir="auto">
                          {editing.body}
                        </span>
                      </div>
                    ) : (
                      replyTo && (
                        <>
                          <span className="mb-0.5 block text-[11.5px] font-semibold text-ink-500">{T.replyingTo.replace("{name}", replyTo.senderName ?? T.formerMember)}</span>
                          <QuoteLine q={replyTo} label={{ photo: T.photo, voice: T.voice, file: T.file, deleted: T.deleted, you: T.you }} />
                        </>
                      )
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (editing) setText("");
                      setReplyTo(null);
                      setEditing(null);
                    }}
                    aria-label={T.cancel}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken"
                    data-team-compose-cancel
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              {mentionChoices.length > 0 && (
                <ul className="mb-2 overflow-hidden rounded-card border border-line bg-surface shadow-pop" data-team-mentions>
                  {mentionChoices.map((p) => (
                    <li key={p.userId}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => chooseMention(p)}
                        className="flex min-h-11 w-full items-center gap-2.5 px-3 text-start hover:bg-sunken"
                        data-team-mention={p.userId}
                      >
                        <Avatar name={p.name} size={28} src={photo(p)} color={p.color ?? undefined} />
                        <span className="text-[14px]" dir="auto">
                          {p.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-end gap-1.5">
                <input ref={fileInput} type="file" className="hidden" onChange={(e) => (attach(e.target.files?.[0]), (e.target.value = ""))} data-team-file />
                {!editing && (
                  <button type="button" onClick={() => fileInput.current?.click()} aria-label={T.attach} title={T.attach} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken">
                    <Paperclip className="h-5 w-5" />
                  </button>
                )}
                <textarea
                  ref={input}
                  value={text}
                  onChange={(e) => onText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                  onKeyDown={(e) => {
                    if (mentionChoices.length && (e.key === "Enter" || e.key === "Tab")) {
                      e.preventDefault();
                      chooseMention(mentionChoices[0]);
                      return;
                    }
                    if (e.key === "Escape") {
                      setMentionQuery(null);
                      if (replyTo || editing) {
                        if (editing) setText("");
                        setReplyTo(null);
                        setEditing(null);
                      }
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  onPaste={(e) => {
                    const f = e.clipboardData.files?.[0];
                    if (f) {
                      e.preventDefault();
                      attach(f);
                    }
                  }}
                  rows={1}
                  maxLength={4000}
                  // The @ list opens as soon as someone types @; said in the hint, it no longer fitted a phone.
                  placeholder={T.write}
                  title={canMention ? T.mentionHint : undefined}
                  dir="auto"
                  className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-line bg-sunken px-3 py-2 text-[16px] outline-none focus:border-brand-400 sm:text-[14px]"
                  data-team-input
                />
                {text.trim() || editing ? (
                  <button type="button" onClick={() => void submit()} aria-label={editing ? T.save : T.send} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-on-brand" data-team-send>
                    {editing ? <Pencil className="h-[17px] w-[17px]" /> : <Send className="h-[18px] w-[18px] rtl:rotate-180" />}
                  </button>
                ) : (
                  <VoiceRecorder
                    immediate
                    onReady={(rec) => {
                      if (!rec || !openId) return;
                      const ext = rec.blob.type.includes("mp4") ? "m4a" : rec.blob.type.includes("ogg") ? "ogg" : "webm";
                      const quoted = replyTo;
                      setReplyTo(null);
                      void send(openId, "", { file: { blob: rec.blob, name: `voice-note.${ext}`, seconds: rec.seconds }, replyTo: quoted });
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

      {menuFor && open && (
        <MessageSheet
          m={menuFor}
          mine={menuFor.senderId === meId}
          pinned={open.pinnedMessage?.id === menuFor.id}
          canEdit={canEdit(menuFor)}
          seenBy={open.kind !== "direct" && menuFor.senderId === meId ? seenBy(menuFor) : null}
          onClose={() => setMenuFor(null)}
          onReact={(e) => (setMenuFor(null), void react(menuFor, e))}
          onReply={() => (setMenuFor(null), startReply(menuFor))}
          onCopy={async () => {
            setMenuFor(null);
            try {
              await navigator.clipboard.writeText(menuFor.body);
              toast(T.copied, "success");
            } catch {
              toast(t.common.genericError, "error");
            }
          }}
          onForward={() => (setForwarding(menuFor), setMenuFor(null))}
          onPin={() => (setMenuFor(null), void pinMessage(menuFor, open.pinnedMessage?.id !== menuFor.id))}
          onEdit={() => (setMenuFor(null), startEdit(menuFor))}
          onDelete={() => (setMenuFor(null), void removeMessage(menuFor))}
          meId={meId}
        />
      )}
      {forwarding && threads && (
        <Modal open onClose={() => setForwarding(null)} title={T.forwardTo}>
          <ul className="divide-y divide-line" data-team-forward-list>
            {threads.map((th) => (
              <li key={th.id}>
                <button type="button" onClick={() => void forwardTo(th)} className="flex min-h-12 w-full items-center gap-3 py-1.5 text-start hover:bg-sunken" data-team-forward-to={th.kind === "clinic" ? "room" : th.id}>
                  {th.kind === "direct" ? (
                    <Avatar name={otherOf(th)?.name ?? "?"} size={32} src={photo(otherOf(th))} color={otherOf(th)?.color ?? undefined} />
                  ) : (
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-100 text-brand-700">
                      <Users className="h-4 w-4" />
                    </span>
                  )}
                  <span className="text-[14px]" dir="auto">
                    {nameOf(th)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
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

function MenuItem({ icon, label, onClick, data, danger }: { icon: React.ReactNode; label: string; onClick: () => void; data: string; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex min-h-11 w-full items-center gap-3 px-3.5 text-start text-[14px] hover:bg-sunken ${danger ? "text-st-cancelled" : "text-ink-900"}`}
      data-team-action={data}
    >
      <span className="text-ink-500">{icon}</span>
      {label}
    </button>
  );
}

/** Everything that can be done to one message: a sheet from a long press or the ⋯ beside it. */
function MessageSheet({
  m,
  mine,
  pinned,
  canEdit,
  seenBy,
  meId,
  onClose,
  onReact,
  onReply,
  onCopy,
  onForward,
  onPin,
  onEdit,
  onDelete,
}: {
  m: Local;
  mine: boolean;
  pinned: boolean;
  canEdit: boolean;
  seenBy: TeamPerson[] | null;
  meId: string;
  onClose: () => void;
  onReact: (emoji: string | null) => void;
  onReply: () => void;
  onCopy: () => void;
  onForward: () => void;
  onPin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const T = t.team;
  const current = m.reactions.find((r) => r.userIds.includes(meId))?.emoji ?? null;
  return (
    <Modal open onClose={onClose} title={T.options}>
      <div className="grid gap-3" data-team-sheet={m.id}>
        <div className="flex justify-between gap-1 rounded-full bg-sunken p-1.5">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onReact(current === e ? null : e)}
              className={`grid h-11 w-11 place-items-center rounded-full text-[24px] transition-transform active:scale-110 ${current === e ? "bg-brand-100" : "hover:bg-surface"}`}
              aria-pressed={current === e}
              data-team-sheet-react={e}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="grid divide-y divide-line overflow-hidden rounded-card border border-line">
          <MenuItem icon={<CornerUpLeft className="h-4 w-4 rtl:-scale-x-100" />} label={T.reply} onClick={onReply} data="reply" />
          {m.body && <MenuItem icon={<Copy className="h-4 w-4" />} label={T.copy} onClick={onCopy} data="copy" />}
          <MenuItem icon={<Forward className="h-4 w-4" />} label={T.forward} onClick={onForward} data="forward" />
          <MenuItem icon={pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />} label={pinned ? T.unpin : T.pin} onClick={onPin} data="pin-message" />
          {mine && canEdit && <MenuItem icon={<Pencil className="h-4 w-4" />} label={T.edit} onClick={onEdit} data="edit" />}
          {mine && <MenuItem icon={<Trash2 className="h-4 w-4" />} label={T.delete} onClick={onDelete} data="delete" danger />}
        </div>
        {seenBy && (
          <div data-team-seen-by={seenBy.length}>
            <div className="mb-1 text-[12.5px] font-semibold text-ink-500">{T.seenBy.replace("{n}", String(seenBy.length))}</div>
            <p className="text-[13px] text-ink-700" dir="auto">
              {seenBy.map((p) => p.name).join("، ") || "—"}
            </p>
          </div>
        )}
      </div>
    </Modal>
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
