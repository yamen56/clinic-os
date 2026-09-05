"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import type { Dict } from "@/lib/i18n";

/**
 * "Prove it is still you" — the password, again, before something irreversible
 * or wholesale.
 *
 * Being signed in means somebody authenticated on this device sometime in the
 * last week. That is the right question for the whole product except the few
 * places where one click produces every record the clinic holds; there, an
 * unattended laptop and a legitimate owner look identical, and the password is
 * the only thing that tells them apart.
 *
 * Driven by the server rather than by the button: the caller fires its request
 * as normal, and only if the endpoint answers `reauth_required` does this
 * appear. That ordering matters — it means a new dangerous endpoint is
 * protected the moment it returns that code, without anybody remembering to add
 * a prompt to the screen in front of it, and it means the prompt can never be
 * the *only* thing standing in the way.
 */
export function ReauthPrompt({
  open,
  onClose,
  onVerified,
  t,
  body,
}: {
  open: boolean;
  onClose: () => void;
  /** Called once the password has been accepted; retry the original request here. */
  onVerified: () => void;
  t: Dict;
  /** Overrides the default explanation, for a caller that is not the export. */
  body?: string;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    // Never leave a typed password sitting in state behind a closed modal.
    setPassword("");
    setError(null);
    setBusy(false);
    onClose();
  };

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setPassword("");
        setBusy(false);
        onClose();
        onVerified();
        return;
      }
      setError(res.status === 429 ? t.auth.reauthTooMany : t.auth.reauthWrong);
    } catch {
      setError(t.auth.reauthWrong);
    }
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t.auth.reauthTitle}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            {t.common.cancel}
          </Button>
          <Button onClick={submit} disabled={!password || busy}>
            {t.auth.reauthConfirm}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] leading-relaxed text-ink-600">{body ?? t.auth.reauthBody}</p>
      <Field label={t.auth.reauthPassword}>
        <Input
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          // Enter submits: this is a one-field form and reaching for the mouse
          // to confirm a password is the kind of friction that gets a control
          // switched off.
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </Field>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
    </Modal>
  );
}
