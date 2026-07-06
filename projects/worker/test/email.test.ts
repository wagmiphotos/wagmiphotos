import { it, expect, vi, afterEach } from "vitest";
import { makeEmailSender, emailIsDevMode } from "../src/email";

afterEach(() => vi.unstubAllGlobals());

it("dev mode when RESEND_API_KEY unset: logs, does not fetch", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  expect(emailIsDevMode({} as any)).toBe(true);
  await makeEmailSender({} as any).sendMagicLink("a@b.co", "https://x/link");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
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
