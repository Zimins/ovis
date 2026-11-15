/** Remote controls for the dedicated sign-in browser running on the Ovis PC. */
import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";

import { ApiError, hostBrowserFrame, hostBrowserInput, routeMissing, startHostBrowser, stopHostBrowser, type HostBrowserInput } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";

const FRAME_MS = 900;
const SPECIAL_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function HostBrowserPanel({ address, onClose }: { readonly address: string; readonly onClose: () => void }) {
  const t = useT();
  const [session, setSession] = useState<{ id: string; width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<{ origin: string; image: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void startHostBrowser(address).then((opened) => {
      if (cancelled) { void stopHostBrowser(opened.id).catch(() => undefined); return; }
      sessionRef.current = opened.id;
      setSession(opened);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(routeMissing(cause) ? t("This Ovis server does not have the host browser feature.")
        : cause instanceof ApiError && cause.code === "browser_busy" ? t("A browser on this PC is already open. Close it before starting another.")
        : cause instanceof ApiError && cause.code === "browser_missing" ? t("Install Chrome on the PC running Ovis.")
        : cause instanceof ApiError && cause.code === "browser_unavailable" ? t("Chrome could not start on this PC. Check the Ovis server log.")
        : `${t("Could not open the browser on this PC.")} (${cause instanceof ApiError ? cause.code ?? cause.status : "network"})`);
    });
    return () => {
      cancelled = true;
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id) void stopHostBrowser(id).catch(() => undefined);
    };
  }, [address, t]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const next = await hostBrowserFrame(session.id);
        if (!stopped) { setFrame({ origin: next.origin, image: `data:image/jpeg;base64,${next.image_base64}` }); setError(null); }
      } catch {
        if (!stopped) setError(t("Could not read the browser on this PC."));
      }
      if (!stopped) timer = window.setTimeout(() => void refresh(), FRAME_MS);
    };
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [session, t]);

  const send = (event: HostBrowserInput): void => {
    const id = sessionRef.current;
    if (!id) return;
    queue.current = queue.current.then(() => hostBrowserInput(id, event)).catch(() => setError(t("Could not send input to the browser.")));
  };
  const click = (event: MouseEvent<HTMLImageElement>): void => {
    if (!session) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    send({ kind: "click", x: Math.min(session.width, Math.max(0, (event.clientX - bounds.left) * session.width / bounds.width)), y: Math.min(session.height, Math.max(0, (event.clientY - bounds.top) * session.height / bounds.height)) });
    input.current?.focus();
  };
  const wheel = (event: WheelEvent<HTMLImageElement>): void => {
    if (!session) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    send({ kind: "scroll", x: (event.clientX - bounds.left) * session.width / bounds.width, y: (event.clientY - bounds.top) * session.height / bounds.height, delta_y: Math.max(-2000, Math.min(2000, event.deltaY)) });
  };

  return <div className="host-browser-panel">
    <div className="host-browser-toolbar">
      <span>{frame?.origin || t("Opening browser on this PC…")}</span>
      <button type="button" className="icon-button" aria-label={t("Close host browser")} onClick={onClose}><X aria-hidden="true" /></button>
    </div>
    {error && <p className="settings-hint account-error" role="alert">{error}</p>}
    {frame && session && <img className="host-browser-frame" src={frame.image} width={session.width} height={session.height}
      alt={t("Browser on this PC")} onClick={click} onWheel={wheel} draggable={false} />}
    <label className="settings-label" htmlFor="host-browser-input">{t("Type into the browser on this PC")}</label>
    <input ref={input} id="host-browser-input" className="input" type="password" autoComplete="off" spellCheck={false}
      onInput={(event) => { if (event.nativeEvent.isComposing) return; const text = event.currentTarget.value; event.currentTarget.value = ""; if (text) send({ kind: "text", text }); }}
      onCompositionEnd={(event) => { const text = event.currentTarget.value; event.currentTarget.value = ""; if (text) send({ kind: "text", text }); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const key = event.key === "Tab" && event.shiftKey ? "Shift+Tab" : event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey) ? "SelectAll" : event.key;
        if (SPECIAL_KEYS.has(event.key) || key === "Shift+Tab" || key === "SelectAll") { event.preventDefault(); event.stopPropagation(); send({ kind: "key", key }); }
      }} />
    <div className="host-browser-scroll">
      <button type="button" className="btn btn-ghost" onClick={() => send({ kind: "scroll", x: 500, y: 380, delta_y: -500 })}><ArrowUp aria-hidden="true" />{t("Scroll up")}</button>
      <button type="button" className="btn btn-ghost" onClick={() => send({ kind: "scroll", x: 500, y: 380, delta_y: 500 })}><ArrowDown aria-hidden="true" />{t("Scroll down")}</button>
    </div>
  </div>;
}
