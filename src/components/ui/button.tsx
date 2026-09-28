"use client";

import { forwardRef } from "react";
import { buttonClass, type Size, type Variant } from "./button-class";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

/** The look lives in `./button-class`, shared with links that read as buttons. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, className = "", children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, className })}
      {...rest}
    >
      {children}
      {loading && (
        <span className="absolute inset-x-0 bottom-0 h-[1.5px] overflow-hidden bg-black/10">
          <span className="block h-full w-2/5 animate-[slim-progress_1.2s_cubic-bezier(0.65,0,0.35,1)_infinite] bg-current opacity-70" />
        </span>
      )}
    </button>
  );
});
