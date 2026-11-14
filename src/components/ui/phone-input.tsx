"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18nSafe } from "@/lib/i18n/client";
import { COUNTRY_LIST, dialCode, normalizePhone, splitE164, toAsciiDigits, type CountryCode } from "@/lib/phone";

/** A local number as people write it there, for the field's hint when it is not the clinic's own country. */
const EXAMPLE: Partial<Record<CountryCode, string>> = {
  JO: "079 000 0000",
  PS: "059 000 0000",
  SA: "050 000 0000",
  AE: "050 000 0000",
  EG: "010 0000 0000",
  KW: "5000 0000",
  QA: "3300 0000",
  IQ: "0770 000 0000",
  SY: "093 000 0000",
  LB: "03 000 000",
};

/**
 * A phone field that does not require knowing what E.164 is.
 *
 * The country sits in its own control showing the flag and the dialling code,
 * and the number box holds only the local part — the form people actually know
 * theirs in. Tapping the country opens the phone's own picker, listing every
 * country by name: a flag alone is not enough, because Windows and many
 * Android phones draw 🇵🇸 as the letters "PS", and a receptionist looking for
 * Palestine in a column of "+9…" codes did not find it (2026-11-14).
 *
 * The country defaults to the clinic's own and is changeable per number, since
 * a Jordanian clinic has Saudi and Palestinian patients. A number pasted with
 * its code — "+970 59…", "00970 59…" — moves the picker to its country.
 *
 * Both halves are `dir="ltr"` *and* isolated. Direction alone is not enough: in
 * an Arabic page an LTR run still takes part in the surrounding bidi order, so
 * a leading `+` gets pushed to the far end and the number reads backwards. The
 * `.num` class sets `unicode-bidi: isolate`, which is the part that actually
 * fixes it.
 *
 * Works outside the app's language provider too (the public booking page),
 * given `locale`.
 */
export function PhoneInput({
  value,
  defaultCountry = "JO",
  onChange,
  placeholder,
  disabled,
  autoFocus,
  size = "md",
  locale: localeProp,
  countryLabel,
  inputAttrs,
}: {
  /** E.164, or anything previously stored. */
  value: string | null | undefined;
  defaultCountry?: CountryCode;
  /** Called with `+<code><digits>` as the number is typed, or "" when empty. */
  onChange: (value: string) => void;
  /** The hint while the clinic's own country is chosen; another country shows its own example. */
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** `lg`: the public booking page's taller fields. */
  size?: "md" | "lg";
  /** For a page with no language provider. */
  locale?: "ar" | "en";
  /** The country control's accessible name, for a page with no language provider. */
  countryLabel?: string;
  /** Extra attributes for the number box — data hooks for QA, autocomplete. */
  inputAttrs?: React.InputHTMLAttributes<HTMLInputElement> & Record<`data-${string}`, string | undefined>;
}) {
  const i18n = useI18nSafe();
  const locale = localeProp ?? (i18n?.locale === "en" ? "en" : "ar");
  const label = countryLabel ?? i18n?.t.common.country ?? (locale === "ar" ? "الدولة" : "Country");

  /*
    A stored number arrives as E.164 and is split; anything else — what was
    typed into a patient search, "0599 123 456" — is the local part as written,
    in the clinic's country.
  */
  const split = (v: string | null | undefined) =>
    v && !v.trim().startsWith("+") ? { country: defaultCountry, national: v } : splitE164(v, defaultCountry);
  const initial = split(value);
  const [country, setCountry] = useState<CountryCode>(initial.country);
  const [national, setNational] = useState(initial.national);

  /*
    What this field last handed up. A value arriving from outside that differs
    from it — a form reset, a patient picked elsewhere — is taken in; one that
    matches is our own echo and is left alone, or typing a leading 0 (which
    hands up "") would wipe the 0.
  */
  const sent = useRef(value ?? "");
  useEffect(() => {
    const v = value ?? "";
    if (v === sent.current) return;
    sent.current = v;
    const s = split(v);
    setCountry(s.country);
    setNational(s.national);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, defaultCountry]);

  /*
    Handed a local number to start with: say it back with its country at once,
    so the form holds "+970599…" and not a "0599…" the server would have to
    guess the country of — and would guess Saudi.
  */
  useEffect(() => {
    if (value && !value.trim().startsWith("+")) emit(initial.country, initial.national);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    Handed up as `+<cc><digits>` rather than a validated E.164. The server
    normalises and rejects it either way, and stopping a half-typed number from
    reaching the form would make the field feel broken while it is typed.
  */
  const emit = (c: CountryCode, n: string) => {
    const digits = toAsciiDigits(n).replace(/\D/g, "").replace(/^0+/, "");
    const v = digits ? `+${dialCode(c)}${digits}` : "";
    sent.current = v;
    onChange(v);
  };

  const typed = (raw: string) => {
    /*
      Written with its country code: find the country, and keep only the local
      part in the box. Only when the code is one we know — anything else stays
      exactly as typed.
    */
    const ascii = toAsciiDigits(raw.trim());
    if (/^(\+|00)/.test(ascii)) {
      const e164 = normalizePhone(ascii);
      if (e164) {
        const s = splitE164(e164, country);
        if (`+${dialCode(s.country)}${s.national}` === e164) {
          setCountry(s.country);
          setNational(s.national);
          emit(s.country, s.national);
          return;
        }
      }
    }
    setNational(raw);
    emit(country, raw);
  };

  const current = COUNTRY_LIST.find((c) => c.code === country)!;
  const hint = country === defaultCountry && placeholder !== undefined ? placeholder : (EXAMPLE[country] ?? "");
  const lg = size === "lg";
  const box = lg
    ? "h-12 rounded-xl border border-line-strong bg-surface text-[16px] focus-within:border-[var(--bk-text,var(--color-brand-600))]"
    : "h-10 rounded-ctl border border-line bg-surface text-base md:text-sm hover:border-line-strong focus-within:border-brand-600";

  return (
    <div className="flex gap-2" dir="ltr" data-phone-input={country}>
      {/*
        The visible part is drawn; the picker over it is the phone's own,
        invisible until tapped — a long list of countries is exactly what a
        phone's native picker is good at.
      */}
      <div className={`relative flex shrink-0 items-center gap-1.5 px-2.5 text-ink-900 ${box} ${disabled ? "bg-subtle opacity-70" : ""}`}>
        <span aria-hidden className="text-[18px] leading-none">{current.flag}</span>
        <span aria-hidden className="num font-medium tabular-nums">+{current.cc}</span>
        <ChevronDown aria-hidden className="h-3.5 w-3.5 text-ink-400" />
        <select
          value={country}
          disabled={disabled}
          // The name only: a screen reader says the chosen option ("الأردن +962") after it by itself.
          aria-label={label}
          onChange={(e) => {
            const c = e.target.value as CountryCode;
            setCountry(c);
            emit(c, national);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          data-phone-country
        >
          {COUNTRY_LIST.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {locale === "ar" ? c.nameAr : c.name} +{c.cc}
            </option>
          ))}
        </select>
      </div>
      <input
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        dir="ltr"
        autoFocus={autoFocus}
        disabled={disabled}
        value={national}
        placeholder={hint}
        onChange={(e) => typed(e.target.value)}
        {...inputAttrs}
        className={`num w-full min-w-0 text-ink-900 tabular-nums outline-none placeholder:text-ink-500 transition-[border-color,box-shadow] duration-140 ease-out disabled:bg-subtle ${box} ${
          lg ? "scroll-mb-28 px-4" : "px-3 focus:shadow-[0_0_0_3px_rgb(105_137_166/0.30)]"
        }`}
      />
    </div>
  );
}
