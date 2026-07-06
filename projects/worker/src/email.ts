import type { Env } from "./types";

export interface EmailSender { sendMagicLink(email: string, link: string): Promise<void>; }

export function emailIsDevMode(env: Env): boolean { return !env.RESEND_API_KEY; }

export function makeEmailSender(env: Env): EmailSender {
  return {
    async sendMagicLink(email, link) {
      if (!env.RESEND_API_KEY) {
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
