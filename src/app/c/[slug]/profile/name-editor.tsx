"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Pencil } from "lucide-react";
import { updateMyNameAction } from "./actions";

/**
 * The name on this account, as a heading you can edit.
 *
 * A field sitting permanently open under the heading would print the name
 * twice, so the heading itself is the control: it reads as text until the
 * pencil is pressed. The badges beside it are passed in rather than rendered
 * here — they belong to the row, not to the name, and they are hidden while the
 * input is open so a phone gets the whole width for typing.
 */
export function NameEditor({
  slug,
  name,
  title,
  children,
}: {
  slug: string;
  name: string;
  /** The honorific stored on the membership ("د."), shown but not edited here. */
  title: string | null;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();

  const close = () => {
    // Reopening must not resume an abandoned edit.
    setValue(name);
    setOpen(false);
  };

  const save = () =>
    start(async () => {
      const r = await updateMyNameAction(slug, value);
      if (r.error) {
        toast(t.profile.nameTooShort, "error");
        return;
      }
      toast(t.common.saved);
      setOpen(false);
      router.refresh();
    });

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[17px] font-semibold">
          {title ? `${title} ` : ""}
          {name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label={t.profile.editName}
          title={t.profile.editName}
        >
          <Pencil className="h-4 w-4 text-ink-400" />
        </Button>
        {children}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <Input
        autoFocus
        value={value}
        maxLength={80}
        aria-label={t.staff.fullName}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") close();
        }}
      />
      <p className="text-[12px] leading-relaxed text-ink-500">{t.profile.nameHint}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" loading={pending} disabled={value.trim().length < 2} onClick={save}>
          {t.common.save}
        </Button>
        <Button size="sm" variant="ghost" onClick={close}>
          {t.common.cancel}
        </Button>
      </div>
    </div>
  );
}
