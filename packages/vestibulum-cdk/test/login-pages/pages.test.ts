/**
 * Login pages (browser scripts) — DOM tests. dot-notes
 * doc/topics/passwordless-sign-in-aws/02-spec.md:
 *
 *   signin_redeem_requires_user_gesture   loading the link page sends nothing; redemption is a POST on a click
 *   signin_secret_in_fragment_only        the token is scrubbed from the URL and held in memory only
 *   signin_link_bound_…                    nothing the page can read (storage, DOM, request) carries the Cognito session
 *
 * The page scripts run in jsdom with a stubbed `fetch`. These are unit tests of
 * the scripts' own behaviour; a real-browser check (cookie delivery with
 * SameSite=Strict from a mail client, prerender) is a live check and is NOT
 * claimed here.
 */

import { createHash, webcrypto } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../login-pages");
const read = (f: string) => fs.readFileSync(path.join(PAGES, f), "utf8");

const ORIGIN = "https://app.example.com";
const TOKEN = "TOKEN-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit & { headers: Record<string, string> };
}

interface Harness {
  readonly dom: JSDOM;
  readonly window: JSDOM["window"];
  readonly fetchCalls: FetchCall[];
  /** jsdom "Not implemented" errors — navigation shows up here. */
  readonly jsdomErrors: string[];
  readonly $: (id: string) => HTMLElement;
}

function load(
  page: "callback" | "login",
  opts: {
    hash?: string;
    prerendering?: boolean;
    respond?: (call: FetchCall) => { status: number; ok: boolean };
  } = {},
): Harness {
  const html = read(page === "callback" ? "login-callback.html" : "login.html");
  const script = read(page === "callback" ? "login-callback.js" : "login.js");
  const jsdomErrors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => jsdomErrors.push(String(e.message)));

  const url = `${ORIGIN}/${page === "callback" ? "login/callback" : "login"}${opts.hash ?? ""}`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only", virtualConsole });
  const w = dom.window as unknown as Record<string, unknown> & JSDOM["window"];

  const fetchCalls: FetchCall[] = [];
  w["fetch"] = (u: string, init: FetchCall["init"]) => {
    const call = { url: u, init };
    fetchCalls.push(call);
    const r = opts.respond?.(call) ?? { status: 200, ok: true };
    return Promise.resolve(r as unknown as Response);
  };
  Object.defineProperty(w, "crypto", { value: webcrypto, configurable: true });
  w["TextEncoder"] = TextEncoder;
  if (opts.prerendering === true) {
    Object.defineProperty(w.document, "prerendering", { value: true, configurable: true });
  }

  // The scripts are plain page scripts; run them in the page's own global.
  (w as unknown as { eval: (s: string) => unknown }).eval(script);

  return {
    dom,
    window: dom.window,
    fetchCalls,
    jsdomErrors,
    $: (id) => dom.window.document.getElementById(id)!,
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const click = (h: Harness, id: string) =>
  h.$(id).dispatchEvent(new h.window.Event("click", { bubbles: true }));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("callback page — signin_redeem_requires_user_gesture", () => {
  it("sends NOTHING on load, even after waiting", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    await tick(150);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.jsdomErrors).toEqual([]); // and did not navigate
  });

  it("offers a button (and hides the spinner) when a token is present", () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    expect(h.$("confirm").hidden).toBe(false);
    expect(h.$("spinner").hidden).toBe(true);
    expect(h.$("sign-in").tagName).toBe("BUTTON");
  });

  it("does not even read the fragment while the page is being prerendered", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}`, prerendering: true });
    await tick(150);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.$("confirm").hidden).toBe(true); // no button yet
    expect(h.window.location.hash).toContain(TOKEN); // fragment untouched until shown
  });

  it("after the prerendered page is activated it shows the button — and still sends nothing", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}`, prerendering: true });
    Object.defineProperty(h.window.document, "prerendering", { value: false, configurable: true });
    h.window.document.dispatchEvent(new h.window.Event("prerenderingchange"));
    await tick(100);
    expect(h.$("confirm").hidden).toBe(false);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("a click sends exactly one POST to /auth-verify with ONLY { answer } as the body", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    click(h, "sign-in");
    await tick();
    expect(h.fetchCalls).toHaveLength(1);
    const { url, init } = h.fetchCalls[0]!;
    expect(url).toBe("/auth-verify");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = init.body as string;
    expect(Object.keys(JSON.parse(body) as object)).toEqual(["answer"]);
    expect(JSON.parse(body)).toEqual({ answer: TOKEN });
    // CloudFront OAC needs the payload hash for a POST to a Function URL.
    expect(init.headers["x-amz-content-sha256"]).toBe(sha256(body));
  });

  it("a double click redeems once (the in-memory token is spent on the first)", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    click(h, "sign-in");
    click(h, "sign-in");
    click(h, "sign-in");
    await tick(50);
    expect(h.fetchCalls).toHaveLength(1);
  });

  it("on success it navigates to /", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    click(h, "sign-in");
    await tick(50);
    expect(h.jsdomErrors.join(" ")).toMatch(/navigation/i);
  });

  it("on 401 it explains (incl. 'different browser'), links to /login and does not navigate", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}`, respond: () => ({ status: 401, ok: false }) });
    click(h, "sign-in");
    await tick(50);
    expect(h.$("message").textContent).toMatch(/different browser/i);
    expect(h.$("message").querySelector("a")?.getAttribute("href")).toBe("/login");
    expect(h.$("confirm").hidden).toBe(true);
    expect(h.jsdomErrors).toEqual([]);
  });

  it("a network failure is reported generically", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    (h.window as unknown as Record<string, unknown>)["fetch"] = () => Promise.reject(new Error("offline"));
    click(h, "sign-in");
    await tick(50);
    expect(h.$("message").textContent).toMatch(/went wrong/i);
  });

  it.each(["", "#", "#token=", "#other=1", "#token"])(
    "with no token in the fragment (%j) it shows the invalid-link message and offers no button",
    async (hash) => {
      const h = load("callback", { hash });
      await tick(30);
      expect(h.$("message").textContent).toMatch(/invalid or has expired/i);
      expect(h.$("confirm").hidden).toBe(true);
      expect(h.fetchCalls).toHaveLength(0);
    },
  );
});

describe("callback page — signin_secret_in_fragment_only", () => {
  it("scrubs the token from the address bar and history immediately", () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    expect(h.window.location.href).toBe(`${ORIGIN}/login/callback`);
    expect(h.window.location.hash).toBe("");
    expect(h.window.location.search).toBe("");
  });

  it("holds the token only in memory: not in storage, not in the DOM, not in a cookie", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    await tick(30);
    expect(h.window.localStorage.length).toBe(0);
    expect(h.window.sessionStorage.length).toBe(0);
    expect(h.window.document.cookie).toBe("");
    expect(h.dom.serialize()).not.toContain(TOKEN);
  });

  it("the token appears in no request URL or header — only the POST body", async () => {
    const h = load("callback", { hash: `#token=${TOKEN}` });
    click(h, "sign-in");
    await tick();
    const { url, init } = h.fetchCalls[0]!;
    expect(url).not.toContain(TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain(TOKEN);
  });

  it("sets a no-referrer policy on the page", () => {
    expect(read("login-callback.html")).toContain('<meta name="referrer" content="no-referrer" />');
  });
});

describe("login page", () => {
  const submit = async (h: Harness, email = "user@example.com") => {
    (h.$("email") as HTMLInputElement).value = email;
    h.$("login-form").dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick(30);
  };

  it("POSTs { email } to /auth-login, same-origin, with the payload hash", async () => {
    const h = load("login", { respond: () => ({ status: 202, ok: true }) });
    await submit(h);
    expect(h.fetchCalls).toHaveLength(1);
    const { url, init } = h.fetchCalls[0]!;
    expect(url).toBe("/auth-login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["x-amz-content-sha256"]).toBe(sha256(init.body as string));
    expect(JSON.parse(init.body as string)).toEqual({ email: "user@example.com" });
  });

  it("on 202 shows the generic success copy and keeps NOTHING client-side (no session in storage)", async () => {
    const h = load("login", { respond: () => ({ status: 202, ok: true }) });
    await submit(h);
    expect(h.$("success-message").textContent).toMatch(/check your email/i);
    expect(h.$("error-message").textContent).toBe("");
    expect(h.window.sessionStorage.length).toBe(0);
    expect(h.window.localStorage.length).toBe(0);
  });

  it.each([200, 401, 403, 429, 500])("status %i is the same generic error (no failure mode is distinguished)", async (status) => {
    const h = load("login", { respond: () => ({ status, ok: status < 300 }) });
    await submit(h);
    expect(h.$("error-message").textContent).toBe("Something went wrong. Please try again.");
    expect(h.$("success-message").textContent).toBe("");
  });

  it("does not request anything on load", async () => {
    const h = load("login");
    await tick(50);
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe("page scripts reference no client-side session store", () => {
  it.each(["login.js", "login-callback.js"])("%s never touches sessionStorage / localStorage", (f) => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/sessionStorage|localStorage/);
  });
});
