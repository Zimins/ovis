/** A short-lived Chrome window on this PC for an authenticated device to finish a sign-in. */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";

const WIDTH = 1000;
const HEIGHT = 760;
const IDLE_MS = 20 * 60_000;
const MAX_TEXT = 2048;

export class HostBrowserError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export function hostBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new HostBrowserError("invalid_url", "URL is required", 400);
  let url: URL;
  try { url = new URL(value); } catch { throw new HostBrowserError("invalid_url", "URL is invalid", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new HostBrowserError("invalid_url", "Use an HTTP or HTTPS URL without embedded credentials", 400);
  }
  return url.href;
}

function chromePath(): string | null {
  const configured = process.env["OVIS_HOST_BROWSER_CHROME"];
  if (configured) return existsSync(configured) ? configured : null;
  if (process.platform === "darwin") {
    for (const path of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(process.env["HOME"] ?? "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]) {
      if (existsSync(path)) return path;
    }
    return null;
  }
  if (process.platform === "win32") {
    for (const root of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]) {
      if (!root) continue;
      const path = join(root, "Google", "Chrome", "Application", "chrome.exe");
      if (existsSync(path)) return path;
    }
    return null;
  }
  return Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chromium-browser");
}

export type HostBrowserInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; delta_y: number }
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

const KEYS = new Set(["Enter", "Tab", "Shift+Tab", "SelectAll", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function validateHostBrowserInput(value: unknown): HostBrowserInput {
  if (typeof value !== "object" || value === null || !("kind" in value)) throw new HostBrowserError("invalid_input", "Input is invalid", 400);
  const input = value as Record<string, unknown>;
  if (input.kind === "text" && typeof input.text === "string" && input.text.length > 0 && input.text.length <= MAX_TEXT) return { kind: "text", text: input.text };
  if (input.kind === "key" && typeof input.key === "string" && KEYS.has(input.key)) return { kind: "key", key: input.key };
  const coordinate = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
  if (input.kind === "click" && coordinate(input.x, WIDTH) && coordinate(input.y, HEIGHT)) return { kind: "click", x: input.x, y: input.y };
  if (input.kind === "scroll" && coordinate(input.x, WIDTH) && coordinate(input.y, HEIGHT) && typeof input.delta_y === "number" && Number.isFinite(input.delta_y) && Math.abs(input.delta_y) <= 2000) {
    return { kind: "scroll", x: input.x, y: input.y, delta_y: input.delta_y };
  }
  throw new HostBrowserError("invalid_input", "Input is invalid", 400);
}

export interface HostBrowserController {
  start(address: unknown, owner: string | null): Promise<{ id: string; width: number; height: number }>;
  frame(id: unknown, owner: string | null): Promise<{ origin: string; image_base64: string; width: number; height: number }>;
  input(id: unknown, owner: string | null, value: unknown): Promise<void>;
  stop(id: unknown, owner: string | null): Promise<void>;
  close(): void;
}

/** One browser per Ovis server. The random ID is held only by the tab that opened it. */
export class HostBrowser implements HostBrowserController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private id: string | null = null;
  private owner: string | null = null;
  private lastUsed = 0;
  private starting = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly stateDir: string, private readonly launch: { headless?: boolean; executablePath?: string } = {}) {
    this.timer = setInterval(() => { if (this.id && Date.now() - this.lastUsed > IDLE_MS) void this.stop(this.id, this.owner); }, 30_000);
    this.timer.unref?.();
  }

  async start(address: unknown, owner: string | null): Promise<{ id: string; width: number; height: number }> {
    if (this.closed) throw new HostBrowserError("browser_unavailable", "Ovis is stopping", 503);
    const url = hostBrowserUrl(address);
    if (owner === null) throw new HostBrowserError("unauthorized", "Sign in to Ovis first", 401);
    if (this.id || this.starting) throw new HostBrowserError("browser_busy", "A host browser is already open", 409);
    const executablePath = this.launch.executablePath ?? chromePath();
    if (!executablePath) throw new HostBrowserError("browser_missing", "Chrome is not installed on this PC", 503);
    this.starting = true;
    let context: BrowserContext | null = null;
    try {
      const { chromium } = await import("playwright-core");
      const profile = join(this.stateDir, "host-auth-browser");
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const options = {
        executablePath, viewport: { width: WIDTH, height: HEIGHT }, acceptDownloads: false,
        // Playwright normally disables profile extensions. This browser keeps the user's
        // one-time 1Password installation in its dedicated profile between sign-ins.
        ignoreDefaultArgs: ["--disable-extensions"],
      };
      const headless = this.launch.headless ?? (process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"]);
      try {
        context = await chromium.launchPersistentContext(profile, { ...options, headless });
      } catch (error) {
        if (this.launch.headless !== undefined || headless) throw error;
        // A service can serve Ovis to remote devices without owning a desktop session.
        // Chrome's current headless mode still loads extensions from this profile.
        context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
      }
      if (this.closed) throw new Error("Ovis stopped while Chrome was opening");
      const page = context.pages()[0] ?? await context.newPage();
      context.on("page", (opened) => { this.page = opened; });
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
      catch { /* A redirect can outlast this wait; the browser remains available. */ }
      if (this.closed) throw new Error("Ovis stopped while Chrome was opening");
      this.context = context;
      this.page = context.pages().at(-1) ?? page;
      this.id = crypto.randomUUID();
      this.owner = owner;
      this.lastUsed = Date.now();
      context.on("close", () => {
        if (this.context !== context) return;
        this.context = null;
        this.page = null;
        this.id = null;
        this.owner = null;
      });
      return { id: this.id, width: WIDTH, height: HEIGHT };
    } catch (error) {
      if (context) await context.close().catch(() => undefined);
      // Navigation errors are handled above. A launch error cannot contain the OAuth URL;
      // keep its first line on the host for diagnosing a missing display or Chrome library.
      console.error("Host browser launch failed:", error instanceof Error ? error.message.split("\n")[0] : String(error));
      throw new HostBrowserError("browser_unavailable", "Could not open Chrome on this PC", 503);
    } finally {
      this.starting = false;
    }
  }

  private requireSession(id: unknown, owner: string | null, renew = false): void {
    if (typeof id !== "string" || id !== this.id || owner !== this.owner) {
      throw new HostBrowserError("browser_not_found", "This host browser has closed", 404);
    }
    if (renew) this.lastUsed = Date.now();
  }

  private active(id: unknown, owner: string | null, renew = false): Page {
    this.requireSession(id, owner, renew);
    const page = this.page?.isClosed() ? this.context?.pages().find((candidate) => !candidate.isClosed()) ?? null : this.page;
    if (!page) throw new HostBrowserError("browser_not_found", "This host browser has closed", 404);
    this.page = page;
    return page;
  }

  async frame(id: unknown, owner: string | null): Promise<{ origin: string; image_base64: string; width: number; height: number }> {
    const page = this.active(id, owner);
    const image = await page.screenshot({ type: "jpeg", quality: 72, timeout: 10_000 });
    let origin = "";
    try { origin = new URL(page.url()).origin; } catch { /* Chrome's blank page has no origin. */ }
    return { origin, image_base64: image.toString("base64"), width: WIDTH, height: HEIGHT };
  }

  async input(id: unknown, owner: string | null, value: unknown): Promise<void> {
    const page = this.active(id, owner, true);
    const input = validateHostBrowserInput(value);
    if (input.kind === "click") await page.mouse.click(input.x, input.y);
    else if (input.kind === "scroll") { await page.mouse.move(input.x, input.y); await page.mouse.wheel(0, input.delta_y); }
    else if (input.kind === "key") await page.keyboard.press(input.key === "SelectAll" ? process.platform === "darwin" ? "Meta+A" : "Control+A" : input.key);
    else await page.keyboard.insertText(input.text);
  }

  async stop(id: unknown, owner: string | null): Promise<void> {
    this.requireSession(id, owner);
    const context = this.context;
    this.context = null;
    this.page = null;
    this.id = null;
    this.owner = null;
    if (context) await context.close().catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    const context = this.context;
    this.context = null;
    this.page = null;
    this.id = null;
    this.owner = null;
    if (context) void context.close().catch(() => undefined);
  }
}
