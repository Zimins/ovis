import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { HostBrowserError, hostBrowserUrl, validateHostBrowserInput, type HostBrowserController } from "./host-browser.ts";

describe("host browser input", () => {
  it("accepts web addresses without embedded credentials", () => {
    expect(hostBrowserUrl("https://auth.example.test/login?state=123")).toBe("https://auth.example.test/login?state=123");
    for (const address of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.test", "invalid"]) {
      expect(() => hostBrowserUrl(address)).toThrow(HostBrowserError);
    }
  });

  it("bounds coordinates and typed text", () => {
    expect(validateHostBrowserInput({ kind: "click", x: 100, y: 50 })).toEqual({ kind: "click", x: 100, y: 50 });
    expect(validateHostBrowserInput({ kind: "text", text: "hello" })).toEqual({ kind: "text", text: "hello" });
    for (const input of [{ kind: "click", x: -1, y: 50 }, { kind: "key", key: "Control+L" }, { kind: "text", text: "x".repeat(2049) }]) {
      expect(() => validateHostBrowserInput(input)).toThrow(HostBrowserError);
    }
  });
});

describe("POST /api/host-browser", () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-host-browser-"));
  const calls: unknown[][] = [];
  const browser: HostBrowserController = {
    async start(url, owner) { calls.push(["start", url, owner]); return { id: "session-1", width: 1000, height: 760 }; },
    async frame(id, owner) { calls.push(["frame", id, owner]); return { origin: "https://auth.example.test", image_base64: "AQID", width: 1000, height: 760 }; },
    async input(id, owner, value) { calls.push(["input", id, owner, value]); },
    async stop(id, owner) { calls.push(["stop", id, owner]); },
    close() { calls.push(["close"]); },
  };
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "test-token", machines: false, sidecar: false, tailscaleOwner: null, hostBrowser: browser });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (body: unknown, token = "test-token") => fetch(`${base}/api/host-browser`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: base }, body: JSON.stringify(body),
  });
  afterAll(() => { app.stop(); rmSync(root, { recursive: true, force: true }); });

  it("requires authentication and same-origin input", async () => {
    expect((await post({ action: "start", url: "https://auth.example.test" }, "wrong")).status).toBe(401);
    const crossSite = await fetch(`${base}/api/host-browser`, { method: "POST", headers: { authorization: "Bearer test-token", origin: "https://other.example" }, body: "{}" });
    expect(crossSite.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("opens, displays and controls only the requested host browser session", async () => {
    const started = await post({ action: "start", url: "https://auth.example.test" });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ id: "session-1", width: 1000, height: 760 });
    const frame = await post({ action: "frame", id: "session-1" });
    expect(frame.headers.get("cache-control")).toBe("no-store");
    expect(await frame.json()).toEqual({ origin: "https://auth.example.test", image_base64: "AQID", width: 1000, height: 760 });
    expect((await post({ action: "input", id: "session-1", input: { kind: "text", text: "password-fragment" } })).status).toBe(200);
    expect((await post({ action: "stop", id: "session-1" })).status).toBe(200);
    expect(calls.map((call) => call[0])).toEqual(["start", "frame", "input", "stop"]);
    expect(readFileSync(join(root, "http-requests.jsonl"), "utf8")).not.toContain("password-fragment");
  });
});
