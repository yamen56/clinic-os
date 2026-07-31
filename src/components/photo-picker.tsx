"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Avatar } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Camera, Trash2 } from "lucide-react";

/**
 * Sets a staff member's photo.
 *
 * The preview is drawn from the chosen file locally before anything is
 * uploaded, so the picture appears the moment it is picked rather than after a
 * round trip — and if the upload then fails the preview is dropped, so what is
 * on screen never claims more than what was saved.
 */
export function PhotoPicker({
  slug,
  memberId,
  name,
  hasPhoto,
  size = 72,
  color,
}: {
  slug: string;
  memberId: string;
  name: string;
  hasPhoto: boolean;
  size?: number;
  color?: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [present, setPresent] = useState(hasPhoto);
  // Bumped after a change so the browser refetches instead of showing the old one.
  const [v, setV] = useState(0);

  const url = present ? `/api/c/${slug}/staff/${memberId}/photo?v=${v}` : null;

  const upload = async (file: File) => {
    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/c/${slug}/staff/${memberId}/photo`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(
          (t.staff.photoErrors as Record<string, string>)[body.error] ?? t.common.genericError,
          "error"
        );
        setPreview(null);
        return;
      }
      setPresent(true);
      setV((n) => n + 1);
      toast(t.staff.photoSaved);
    } catch {
      toast(t.common.genericError, "error");
      setPreview(null);
    } finally {
      setBusy(false);
      URL.revokeObjectURL(localPreview);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/staff/${memberId}/photo`, { method: "DELETE" });
      if (!res.ok) {
        toast(t.common.genericError, "error");
        return;
      }
      setPresent(false);
      setPreview(null);
      setV((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Avatar name={name} size={size} color={color} src={preview ?? url} />
      <div className="grid gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Camera className="h-4 w-4" />
            {present ? t.staff.photoReplace : t.staff.photoAdd}
          </Button>
          {present && (
            <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={busy}>
              <Trash2 className="h-4 w-4 text-danger" />
              {t.common.delete}
            </Button>
          )}
        </div>
        <p className="text-[12px] text-ink-500">{t.staff.photoHint}</p>
      </div>
    </div>
  );
}
