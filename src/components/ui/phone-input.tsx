"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { COUNTRY_LIST, dialCode, splitE164, type CountryCode } from "@/lib/phone";

/**
 * A phone field that does not require knowing what E.164 is.
 *
 * The country sits in its own control showing the dialling code, and the number
 * box holds only the local part — the form people actually know theirs in.
 * Before this, the field held a raw `+962790744070` and expected staff to type
 * it that way.
 *
 * The country defaults to the clinic's own and is changeable per number, since
 * a Jordanian clinic has Saudi and Palestinian patients.
 *
 * Both halves are `dir="ltr"` *and* isolated. Direction alone is not enough: in
 * an Arabic page an LTR run still takes part in the surrounding bidi order, so
 * a leading `+` gets pushed to the far end and the number reads backwards. The
 * `.num` class sets `unicode-bidi: isolate`, which is the part that actually
 * fixes it.
 */
export function PhoneInput({
  value,
  defaultCountry = "JO",
  onChange,
  placeholder,
  disabled,
  autoFocus,
}: {
  /** E.164, or anything previously stored. */
  value: string | null | undefined;
  defaultCountry?: CountryCode;
  /** Called with E.164 when the number is complete, else the raw local part. */
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { locale } = useI18n();
  const initial = splitE164(value, defaultCountry);
  const [country, setCountry] = useState<CountryCode>(initial.country);
  const [national, setNational] = useState(initial.national);

  /*
    The combined value is handed up as `+<cc><digits>` rather than a validated
    E.164. The server normalises and rejects it either way, and stopping a
    half-typed number from reaching the form would make the field feel broken
    while somebody is still typing it.
  */
  const emit = (c: CountryCode, n: string) => {
    const digits = n.replace(/\D/g, "").replace(/^0+/, "");
    onChange(digits ? `+${dialCode(c)}${digits}` : "");
  };

  return (
    <div className="flex gap-2" dir="ltr">
      <select
        value={country}
        disabled={disabled}
        aria-label="Country"
        onChange={(e) => {
          const c = e.target.value as CountryCode;
          setCountry(c);
          emit(c, national);
        }}
        className="h-9 shrink-0 rounded-ctl border border-line bg-surface px-2 text-sm text-ink-900 transition-colors duration-140 ease-out hover:border-line-strong focus:border-brand-600 focus:outline-none disabled:bg-subtle"
      >
        {COUNTRY_LIST.map((c) => (
          <option key={c.code} value={c.code}>
            {c.flag} +{c.cc}
          </option>
        ))}
      </select>
      <input
        type="tel"
        inputMode="tel"
        dir="ltr"
        autoFocus={autoFocus}
        disabled={disabled}
        value={national}
        placeholder={placeholder ?? (country === "JO" ? "0790744070" : "")}
        onChange={(e) => {
          setNational(e.target.value);
          emit(country, e.target.value);
        }}
        className="num h-9 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink-900 placeholder:text-ink-500 transition-[border-color,box-shadow] duration-140 ease-out hover:border-line-strong focus:border-brand-600 focus:shadow-[0_0_0_3px_rgb(105_137_166/0.30)] focus:outline-none disabled:bg-subtle md:text-sm"
      />
      <span className="sr-only">
        {COUNTRY_LIST.find((c) => c.code === country)?.[locale === "ar" ? "nameAr" : "name"]}
      </span>
    </div>
  );
}

/**
 * A phone number for reading.
 *
 * Exists so no caller has to remember that `dir="ltr"` alone leaves the number
 * reversed in Arabic — the isolation is what matters, and it lives here.
 */
export function PhoneText({
  value,
  className = "",
}: {
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) return null;
  return <span className={`num tnum ${className}`}>{formatForDisplay(value)}</span>;
}

/** Groups the national part for legibility, leaving unknown shapes alone. */
function formatForDisplay(e164: string): string {
  const { country, national } = splitE164(e164, "JO");
  if (!national) return e164;
  const cc = dialCode(country);
  const grouped =
    national.length === 9
      ? `${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`
      : national.length === 10
        ? `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
        : national.length === 8
          ? `${national.slice(0, 4)} ${national.slice(4)}`
          : national;
  return `+${cc} ${grouped}`;
}
