import { it, expect, vi, afterEach } from "vitest";
import { makeEmailSender, emailIsDevMode } from "../src/email";

afterEach(() => vi.unstubAllGlobals());

it("dev mode requires DEV_MODE + no RESEND_API_KEY: logs, does not fetch", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  expect(emailIsDevMode({ DEV_MODE: "true" } as any)).toBe(true);
  await makeEmailSender({ DEV_MODE: "true" } as any).sendMagicLink("a@b.co", "https://x/link");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

it("RESEND_API_KEY unset and NOT dev mode: not dev mode, sendMagicLink throws, no fetch", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  expect(emailIsDevMode({} as any)).toBe(false);
  await expect(makeEmailSender({} as any).sendMagicLink("a@b.co", "https://x/link")).rejects.toThrow(/RESEND_API_KEY/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("RESEND_API_KEY set: never dev mode, even with DEV_MODE", async () => {
  expect(emailIsDevMode({ RESEND_API_KEY: "re_x" } as any)).toBe(false);
  expect(emailIsDevMode({ RESEND_API_KEY: "re_x", DEV_MODE: "true" } as any)).toBe(false);
});

it("prod mode posts to Resend with from/to/subject", async () => {
  let captured: any = null;
  vi.stubGlobal("fetch", async (url: string, init: any) => { captured = { url, init }; return new Response("{}", { status: 200 }); });
  await makeEmailSender({ RESEND_API_KEY: "re_x", EMAIL_FROM: "login@wagmi.photos" } as any).sendMagicLink("a@b.co", "https://x/link");
  expect(captured.url).toBe("https://api.resend.com/emails");
  expect(captured.init.headers.Authorization).toBe("Bearer re_x");
  const body = JSON.parse(captured.init.body);
  expect(body.from).toBe("login@wagmi.photos");
  expect(body.to).toBe("a@b.co");
  expect(body.text).toContain("https://x/link");
});

it("prod mode throws on non-2xx", async () => {
  vi.stubGlobal("fetch", async () => new Response("bad", { status: 422 }));
  await expect(makeEmailSender({ RESEND_API_KEY: "re_x", EMAIL_FROM: "f@x" } as any).sendMagicLink("a@b.co", "l")).rejects.toThrow(/Resend failed/);
});
