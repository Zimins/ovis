/** Manual native-browser check; run on the test Mac in a fresh clone, never in a live user session. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostBrowser, HostBrowserError } from "../server/host-browser.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-host-browser-qa-"));
let received: string | null = null;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/callback") {
    received = url.searchParams.get("code");
    return new Response("Sign-in finished on the host");
  }
  return new Response(`<!doctype html><html><body style="margin:0">
    <input style="position:absolute;left:50px;top:50px;width:220px;height:30px" aria-label="Code">
    <button style="position:absolute;left:50px;top:110px;width:120px;height:40px" onclick="location.href='/callback?code='+encodeURIComponent(document.querySelector('input').value)">Continue</button>
  </body></html>`, { headers: { "content-type": "text/html" } });
} });
const browser = new HostBrowser(root, { headless: true, ...(process.env["CHROME_PATH"] ? { executablePath: process.env["CHROME_PATH"] } : {}) });

try {
  const opened = await browser.start(`http://127.0.0.1:${fixture.port}/form`, "qa-owner");
  await assert.rejects(browser.frame(opened.id, "other-owner"), (error) => error instanceof HostBrowserError && error.status === 404);
  await assert.rejects(browser.start(`http://127.0.0.1:${fixture.port}/form`, "qa-owner"), (error) => error instanceof HostBrowserError && error.status === 409);
  const first = await browser.frame(opened.id, "qa-owner");
  assert.equal(first.origin, `http://127.0.0.1:${fixture.port}`);
  assert.ok(first.image_base64.startsWith("/9j/"));
  await browser.input(opened.id, "qa-owner", { kind: "click", x: 80, y: 65 });
  await browser.input(opened.id, "qa-owner", { kind: "text", text: "remote-code" });
  await browser.input(opened.id, "qa-owner", { kind: "click", x: 80, y: 125 });
  const deadline = Date.now() + 5000;
  while (received === null && Date.now() < deadline) await Bun.sleep(50);
  assert.equal(received, "remote-code");
  assert.equal((await browser.frame(opened.id, "qa-owner")).origin, `http://127.0.0.1:${fixture.port}`);
  await browser.stop(opened.id, "qa-owner");
  console.log("PASS host browser: remote input and localhost callback");
} finally {
  browser.close();
  fixture.stop(true);
  rmSync(root, { recursive: true, force: true });
}
