/** A host browser for a sign-in URL copied from any CLI pane. */
import { useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { HostBrowserPanel } from "./HostBrowserPanel.tsx";
import "./UsageAccountDialog.css";

const ONE_PASSWORD_STORE = "https://chromewebstore.google.com/detail/1password-%E2%80%93-password-mana/aeblfdkhhhdcdjpifhhbdiojplfjncoa";

export function HostBrowserDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const surface = useFocusTrap<HTMLDivElement>(true);
  const input = useRef<HTMLInputElement>(null);
  const address = useRef("");
  const [opened, setOpened] = useState(false);
  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = input.current?.value.trim();
    if (!value) return;
    address.current = value;
    if (input.current) input.current.value = "";
    setOpened(true);
  };
  return createPortal(<div className="modal-scrim" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={surface} className={`modal usage-account-dialog usage-sign-in-dialog${opened ? " host-browser-open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="host-browser-title" tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <div className="modal-header">
        <h2 className="modal-title" id="host-browser-title">{t("Browser on this PC")}</h2>
        <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <div className="modal-body">
        {!opened ? <form className="account-step-content" onSubmit={start}>
          <label className="settings-label" htmlFor="host-browser-url">{t("Paste a sign-in URL from the terminal")}</label>
          <input ref={input} className="input" id="host-browser-url" type="url" autoComplete="off" spellCheck={false} required maxLength={8192} placeholder="https://" />
          <button className="btn" type="submit">{t("Open on this PC")}</button>
          <button className="btn btn-ghost" type="button" onClick={() => { address.current = ONE_PASSWORD_STORE; setOpened(true); }}>{t("Set up 1Password in host browser")}</button>
          <p className="settings-hint">{t("Install 1Password once on the host PC. Chrome's extension confirmation appears on that PC.")}</p>
        </form> : <HostBrowserPanel address={address.current} onClose={() => { address.current = ""; setOpened(false); }} />}
      </div>
    </div>
  </div>, document.body);
}
