"use client";
import { useEffect, useRef } from "react";
import { mountCheckout, type CheckoutOptions } from "./browser.js";

export type { CheckoutOptions };

/** Drop-in checkout. Remounts when `order` changes; other props are read once on mount. */
export function GlyphPayCheckout({ className, ...options }: CheckoutOptions & { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const orderKey = JSON.stringify(options.order);
  // ponytail: keyed on order only, so inline appearance/returnUrl objects don't remount Stripe every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => mountCheckout(ref.current!, options), [orderKey]);
  return <div ref={ref} className={className} />;
}
