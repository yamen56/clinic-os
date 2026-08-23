"use client";

import { useRef, useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  SYSTEM_MESSAGES,
  type SystemMessageKey,
  type SystemMessageState,
} from "@/lib/system-messages";
import { saveSystemMessageAction } from "./actions";
import { Lock, Pencil, MessageSquare } from "lucide-react";

/**
 * The messages the platform sends by itself, on the page that claims to list
 * what goes out automatically.
 *
 * Reading them is most of the point. A clinic that has never seen its own
 * booking confirmation cannot tell you whether it is right, and until this
 * existed there was no screen anywhere that showed it.
 */
export function SystemMessagesCard({
  slug,
  messages,
}: {
  slug: string;
  messages: Record<string, SystemMessageState>;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [, start] = useTransition();
  const [editing, setEditing] = useState<SystemMessageKey | null>(null);

  // Optimistic in the plain sense: the row answers the switch immediately and
  // the server write follows. See the Toggle component for why that matters.
  const [state, setState] = useState(messages);
  const patch = (key: string, next: Partial<SystemMessageState>) =>
    setState((s) => ({ ...s, [key]: { ...s[key], ...next } }));

  const save = (key: string, next: SystemMessageState, quiet?: boolean) => {
    patch(key, next);
    start(async () => {
      const r = await saveSystemMessageAction(slug, { key, ...next });
      if (r.error) toast(t.common.genericError, "error");
      else if (!quiet) toast(t.automations.messageSaved);
    });
  };

  const groups = ["booking", "waitlist", "documents", "billing"] as const;

  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-ink-400" />
              {t.automations.systemMessages}
            </span>
          }
          sub={t.automations.systemMessagesSub}
        />
        <div className="divide-y divide-line">
          {groups.map((g) => {
            const defs = SYSTEM_MESSAGES.filter((m) => m.group === g);
            if (!defs.length) return null;
            return (
              <div key={g}>
                <div className="bg-sunken px-5 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-500">
                  {t.automations.messageGroups[g]}
                </div>
                <ul className="divide-y divide-line">
                  {defs.map((def) => {
                    const cur = state[def.key];
                    if (!cur) return null;
                    return (
                      <li key={def.key} className="flex items-center gap-3 px-5 py-3.5">
                        {def.canDisable ? (
                          <Toggle
                            checked={cur.enabled}
                            label={t.automations.enable}
                            onChange={(v) => save(def.key, { ...cur, enabled: v }, true)}
                          />
                        ) : (
                          /* Editable, never silenceable — see canDisable. */
                          <span
                            title={t.automations.alwaysOnHint}
                            className="flex h-5.5 w-10 shrink-0 items-center justify-center rounded-full bg-ink-900/5 text-ink-400"
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing(def.key)}
                          className="min-w-0 flex-1 text-start"
                        >
                          {/* min-w-0 + truncate: without the floor the longest
                              line here sets the card's width and the phone
                              scrolls sideways. */}
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate text-sm font-semibold">
                              {t.automations.messageNames[def.key]}
                            </span>
                            {!def.canDisable && (
                              <Badge status="neutral">{t.automations.alwaysOn}</Badge>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-[13px] text-ink-500">
                            {t.automations.messageWhen[def.key]}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(def.key)}
                          aria-label={t.automations.editMessage}
                          className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-900/5 hover:text-ink-700"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>

      {editing && (
        <MessageEditor
          messageKey={editing}
          value={state[editing]}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            save(editing, next);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function MessageEditor({
  messageKey,
  value,
  onClose,
  onSave,
}: {
  messageKey: SystemMessageKey;
  value: SystemMessageState;
  onClose: () => void;
  onSave: (v: SystemMessageState) => void;
}) {
  const { t } = useI18n();
  const def = SYSTEM_MESSAGES.find((m) => m.key === messageKey)!;
  const [ar, setAr] = useState(value.ar);
  const [en, setEn] = useState(value.en);
  const arRef = useRef<HTMLTextAreaElement>(null);
  const enRef = useRef<HTMLTextAreaElement>(null);
  /*
    Which box a variable chip drops into. Without this the chips have to guess,
    and guessing wrongly puts {{patient.first_name}} into the English message
    while the clinic was writing the Arabic one.
  */
  const [focused, setFocused] = useState<"ar" | "en">("ar");

  const insert = (name: string) => {
    const ref = focused === "ar" ? arRef : enRef;
    const setter = focused === "ar" ? setAr : setEn;
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) return setter((s) => s + token);
    const at = el.selectionStart ?? el.value.length;
    setter(el.value.slice(0, at) + token + el.value.slice(el.selectionEnd ?? at));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.automations.messageNames[messageKey]}
      footer={
        <>
          <Button variant="ghost" onClick={() => { setAr(def.ar); setEn(def.en); }}>
            {t.automations.restoreDefault}
          </Button>
          <Button onClick={() => onSave({ ...value, ar, en })}>{t.common.save}</Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-500">{t.automations.messageWhen[messageKey]}</p>

      <div className="mb-3 rounded-md bg-sunken px-3 py-2">
        <div className="mb-1.5 text-[12px] font-semibold text-ink-500">
          {t.automations.insertVariable}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {def.vars.map((v) => (
            <button
              key={v}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(v)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink-700 hover:border-brand-600 hover:text-brand-700"
              dir="ltr"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-ink-500">{t.automations.emptyLineNote}</p>
      </div>

      <label className="mb-1.5 block text-[13px] font-semibold text-ink-900">
        {t.automations.arabicText}
      </label>
      <Textarea
        ref={arRef}
        dir="rtl"
        rows={7}
        value={ar}
        onFocus={() => setFocused("ar")}
        onChange={(e) => setAr(e.target.value)}
      />

      <label className="mb-1.5 mt-4 block text-[13px] font-semibold text-ink-900">
        {t.automations.englishText}
      </label>
      <Textarea
        ref={enRef}
        dir="ltr"
        rows={7}
        value={en}
        onFocus={() => setFocused("en")}
        onChange={(e) => setEn(e.target.value)}
      />
      <p className="mt-2 text-[12px] text-ink-500">{t.automations.languageHint}</p>

      {!def.canDisable && (
        <p className="mt-3 rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-500">
          {t.automations.alwaysOnHint}
        </p>
      )}
    </Modal>
  );
}
