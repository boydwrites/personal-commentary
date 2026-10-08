import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { api } from "../api";
import { Modal, useToast, Dots } from "./ui";
import { Mark } from "./Logo";

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d{5,25}/;

/**
 * Hand reviewed text to X's composer. A receipt is the only action that records a post as posted.
 */
export function PublishFlow({ open, onClose, study, working, publish, handle, onChanged }: { open: boolean; onClose: () => void; study: any; working: any; publish: any; handle: string; onChanged: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<any>(publish?.posts?.length && !publish.stale ? publish : null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [edited, setEdited] = useState(false);
  const [editedText, setEditedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [receiptMode, setReceiptMode] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);

  const planned = [
    ...working.parts.filter((p: string) => p.trim()).map((p: string, i: number) => ({ key: `p${i}`, role: i === 0 ? "main" : "thread_part", text: p })),
    ...(working.source_reply?.trim() ? [{ key: "r", role: "source_reply", text: working.source_reply }] : []),
  ];
  const steps: any[] = state ? state.posts : planned.map((p, i) => ({ ...p, id: p.key, status: i === 0 ? "ready" : "pending", sequence: i }));
  const nextId = state ? state.next?.postId : steps[0]?.id;
  const roleName = (p: any, i: number) => (p.role === "main" ? (steps.length > 1 ? "Post" : "Your post") : p.role === "source_reply" ? "Sources reply" : `Part ${i + 1}`);

  useEffect(() => {
    if (!receiptMode) return;
    const timer = setTimeout(() => linkInput.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [receiptMode, nextId]);

  /** Opens X. The window opens synchronously (so it isn't blocked), then gets its address once the post is recorded. */
  const openX = async () => {
    const w = window.open("about:blank", "_blank");
    if (w) w.opener = null;
    setBusy(true);
    try {
      let s = state;
      if (!s) {
        s = await api(`/api/studies/${study.id}/publish`, { method: "POST", body: { confirm_text_hash: working.text_hash } });
        setState(s);
        onChanged();
      }
      const n = s.next;
      if (!n) return w?.close();
      if (n.mode === "clipboard") {
        try {
          await navigator.clipboard.writeText(n.text);
          toast("The draft is on your clipboard. Paste it into X, then save it there or post.");
        } catch {
          toast("The draft couldn't be copied. It is still saved here. Select and copy the text below, then paste it into X.", "error");
        }
      }
      if (w) w.location.href = n.intentUrl;
      else window.open(n.intentUrl, "_blank", "noopener");
      setOpenedFor(n.postId);
      setReceiptMode(false);
    } catch (e: any) {
      w?.close();
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const submitReceipt = async (link = url) => {
    if (!state?.next) return;
    setBusy(true);
    try {
      const r = await api(`/api/posts/${state.next.postId}/receipt`, { method: "POST", body: { url: link.trim(), published_text: edited && editedText.trim() ? editedText : null } });
      setState(r);
      setUrl("");
      setEdited(false);
      setEditedText("");
      setOpenedFor(null);
      setReceiptMode(false);
      onChanged();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    try {
      const r = await api(`/api/posts/${state.next.postId}/skip`, { method: "POST" });
      setState(r);
      setOpenedFor(null);
      onChanged();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const done = state?.done;
  const firstUrl = state?.posts?.find((p: any) => p.x_url)?.x_url;

  return (
    <Modal open={open} onClose={onClose} label="Open in X">
      {done ? (
        <div className="stack" style={{ gap: 18 }}>
          <div className="done-mark">
            <Mark size={72} />
            <h2 style={{ margin: "14px 0 4px", padding: 0 }}>Posted.</h2>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {study.display_ref} is live on X. The first hour of replies matters most.
            </p>
          </div>
          <div className="row wrap" style={{ justifyContent: "center", gap: 10 }}>
            {firstUrl && (
              <a className="btn x" href={firstUrl} target="_blank" rel="noreferrer noopener">
                View on X <ArrowUpRight className="lucide" />
              </a>
            )}
            <a className="btn secondary" href={`https://x.com/search?q=${encodeURIComponent(`"${study.display_ref}"`)}&f=live`} target="_blank" rel="noreferrer noopener">
              Who's talking about {study.display_ref}
            </a>
          </div>
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            {state.posts.some((p: any) => p.text_mismatch) && " Noted that the posted wording differs from what was checked."}
          </p>
        </div>
      ) : (
        <>
          <h2>Open in X</h2>
          {handle && <p className="small muted">Check that X shows @{handle}.</p>}
          <ol className="steps">
            {steps.map((p: any, i: number) => {
              const isNext = p.id === nextId;
              const cls = p.status === "posted" ? "done" : p.status === "skipped" ? "skipped" : isNext ? "current" : "pending";
              return (
                <li key={p.id} className={`step ${cls}`}>
                  <span className="step-num">{p.status === "posted" ? <Check className="lucide" /> : i + 1}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="step-role">
                      {roleName(p, i)}
                      {p.status === "skipped" && <span>· skipped</span>}
                      {p.x_url && (
                        <a className="text-btn accent" href={p.x_url} target="_blank" rel="noreferrer noopener">
                          view
                        </a>
                      )}
                    </div>
                    <div className="step-text">{p.text}</div>
                    {isNext && (
                      <div className="step-do">
                        {!receiptMode ? (
                          <>
                          <div className="row wrap">
                            <button className="btn x" onClick={openX} disabled={busy} data-autofocus>
                              {busy ? <Dots label="Opening" /> : <>{openedFor === p.id ? "Open X again" : "Open in X"} <ArrowUpRight className="lucide" /></>}
                            </button>
                            {state && <button className="btn secondary" onClick={() => setReceiptMode(true)} disabled={busy}>I posted it</button>}
                            {state && p.role === "source_reply" && (
                              <button className="text-btn" onClick={skip}>Skip the sources reply</button>
                            )}
                          </div>
                          {openedFor === p.id && <div className="helper" style={{ marginTop: 14 }}>
                            <div className="label">Save in X for later</div>
                            <p className="small">Close X's composer and choose Save. It waits under Unsent posts.</p>
                            <button className="btn secondary sm" onClick={onClose}>Keep draft for later</button>
                          </div>}
                          </>
                        ) : (
                          <>
                            <input
                              ref={linkInput}
                              className="input"
                              placeholder={`Paste the link — https://x.com/${handle}/status/…`}
                              value={url}
                              onChange={(e) => setUrl(e.target.value)}
                              onPaste={(e) => {
                                const t = e.clipboardData.getData("text").trim();
                                if (STATUS_URL.test(t) && !edited) {
                                  e.preventDefault();
                                  setUrl(t);
                                  submitReceipt(t);
                                }
                              }}
                              onKeyDown={(e) => e.key === "Enter" && url.trim() && submitReceipt()}
                              aria-label="Link to the post on X"
                            />
                            {edited && <textarea className="textarea" rows={3} placeholder="Paste what you actually posted" value={editedText} onChange={(e) => setEditedText(e.target.value)} />}
                            <div className="row wrap">
                              <button className="btn primary sm" onClick={() => submitReceipt()} disabled={!url.trim() || busy}>
                                {busy ? <Dots label="Saving" /> : "Record posted link"}
                              </button>
                              <button className="text-btn" onClick={() => setReceiptMode(false)} disabled={busy}>Back to draft</button>
                              <span className="spacer" />
                              <label className="check small muted">
                                <input type="checkbox" checked={edited} onChange={(e) => setEdited(e.target.checked)} /> I changed the wording on X
                              </label>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Modal>
  );
}
