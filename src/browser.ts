/**
 * GlyphPay connector, browser half. Framework-free: works on any site.
 * Talks only to the site's own checkout route; the service credential never reaches the browser.
 */
import { loadStripe, type Appearance } from "@stripe/stripe-js";
import { resolveReturnUrl } from "./security.js";

export interface CheckoutOptions {
  /** JSON posted to your checkout route, e.g. `{ cartId }`. Your server prices it; never send a trusted amount. */
  order: unknown;
  /** Where Stripe sends the shopper after paying. Must stay on this site unless `allowCrossOriginReturn` is set. */
  returnUrl: string;
  /** Allow an absolute return URL on another origin. Off by default. */
  allowCrossOriginReturn?: boolean;
  /** Your site's checkout route. Default `/api/glyphpay/checkout`. */
  endpoint?: string;
  /** Stripe Elements appearance (theme, colors, fonts). */
  appearance?: Appearance;
  buttonText?: string;
}

/**
 * Renders `<form class="glyphpay">` (Stripe Payment Element + submit button + `role=alert` message)
 * into `container`. Style it with `.glyphpay button { … }`. Returns an unmount function.
 */
export function mountCheckout(container: HTMLElement, options: CheckoutOptions): () => void {
  let unmounted = false;
  const form = document.createElement("form");
  form.className = "glyphpay";
  const slot = document.createElement("div");
  const button = document.createElement("button");
  button.type = "submit";
  button.disabled = true;
  button.textContent = options.buttonText ?? "Pay now";
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  form.append(slot, button, message);
  container.append(form);

  (async () => {
    const res = await fetch(options.endpoint ?? "/api/glyphpay/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.order ?? null),
    });
    const session = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(session.error ?? "Checkout is unavailable right now.");
    const stripe = await loadStripe(session.publishableKey, { stripeAccount: session.stripeAccount });
    if (!stripe) throw new Error("Could not load the payment form.");
    if (unmounted) return;

    const elements = stripe.elements({ clientSecret: session.clientSecret, appearance: options.appearance });
    const payment = elements.create("payment");
    payment.on("ready", () => { button.disabled = false; });
    payment.mount(slot);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      message.textContent = "";
      try {
        // On success Stripe always redirects to returnUrl (adds payment_intent & redirect_status params).
        const returnUrl = resolveReturnUrl(options.returnUrl, location.href, !!options.allowCrossOriginReturn);
        const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl } });
        message.textContent = error.message ?? "Payment failed. Please try again.";
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "Payment failed. Please try again.";
      } finally {
        button.disabled = false;
      }
    });
  })().catch((error: Error) => { message.textContent = error.message; });

  return () => { unmounted = true; form.remove(); };
}
