import { randomBytes } from "node:crypto";
import { renderPage } from "./views/layout";

export const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } });

export const go = (to: string, kind: "error" | "notice", msg: string) =>
  redirect(`${to}${to.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}`);

export function page(title: string, body: string): Response {
  const nonce = randomBytes(16).toString("base64");
  const html = renderPage(title, body, nonce);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Ticket text is untrusted: only our nonce'd script runs, no external loads, forms post only here.
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "X-Content-Type-Options": "nosniff",
      // "no-referrer" makes browsers send `Origin: null` on our own form posts.
      "Referrer-Policy": "same-origin",
    },
  });
}
