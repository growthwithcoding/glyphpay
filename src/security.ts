/**
 * Browser-side URL safety helpers. Kept separate from the Stripe loader so the
 * rules can be tested without a DOM.
 */

/** Resolve a post-payment return URL, rejecting cross-origin targets unless explicitly allowed. */
export function resolveReturnUrl(returnUrl: string, baseHref: string, allowCrossOrigin = false): string {
  const base = new URL(baseHref);
  const target = new URL(returnUrl, base);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("returnUrl must be an http(s) URL.");
  }
  if (!allowCrossOrigin && target.origin !== base.origin) {
    throw new Error("returnUrl must use this site's origin.");
  }
  return target.href;
}
