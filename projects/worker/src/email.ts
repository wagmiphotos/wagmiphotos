import type { Env } from "./types";
import { isDevMode } from "./config";

export interface EmailSender { sendMagicLink(email: string, link: string): Promise<void>; }

// Dev email mode (console-logged magic links, dev_link in the login response)
// requires the explicit DEV_MODE opt-in; a missing RESEND_API_KEY alone is a
// misconfiguration, not dev mode.
export function emailIsDevMode(env: Env): boolean { return !env.RESEND_API_KEY && isDevMode(env); }

export function makeEmailSender(env: Env): EmailSender {
  return {
    async sendMagicLink(email, link) {
      if (!env.RESEND_API_KEY) {
        if (!isDevMode(env)) {
          // Fail closed: never silently swallow magic links in production.
          throw new Error("RESEND_API_KEY is not configured and DEV_MODE is off; cannot send magic link");
        }
        console.log(`[dev] magic link for ${email}: ${link}`);
        return;
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: email,
          subject: "Your wagmi.photos login link",
          text: `Log in to wagmi.photos:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
          html: `<p>Log in to wagmi.photos:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
        }),
      });
      if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
    },
  };
}
