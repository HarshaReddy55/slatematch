import { useEffect, useRef, useState } from "react";

/* Stage 4: the access-key modal (state.js openKeyModal /
   saveApiKey / removeApiKey), with audit row 15's fix: the copy
   follows the deployment's TRUE auth state from /health. Vanilla's
   copy asserts "This deployment is locked with API keys" even on a
   dev-open deployment. Here the locked paragraph is used verbatim
   only when /health reports auth "api-key"; on "dev-open" the
   opening claim tells the truth and the remaining sentences are
   vanilla's, unchanged. Behaviour is identical to vanilla's manual
   flow and nothing about auth itself changes: the key lives in the
   same localStorage slot (slate-key) both stacks share, and Part B
   stays parked. */

const LOCKED_COPY =
  "This deployment is locked with API keys. Paste the key issued for your workspace and this browser will send it with every request. The key is stored only in this browser - the server keeps only a hash of it. The bootstrap key does not belong here; it only mints workspace keys.";

const OPEN_COPY =
  "This deployment is open - no API key is in force, and this browser does not need one to work here. If this deployment is locked later, paste the key issued for your workspace here and this browser will send it with every request. The key is stored only in this browser - the server keeps only a hash of it. The bootstrap key does not belong here; it only mints workspace keys.";

/** Pure copy selector, unit-checked by the Stage 4 contract tests:
    the locked claim may only render when the state says locked. */
export function keyModalCopy(auth: string | null | undefined): string {
  return auth === "api-key" ? LOCKED_COPY : OPEN_COPY;
}

export function storedKey(): string {
  try {
    return localStorage.getItem("slate-key") || "";
  } catch {
    return "";
  }
}

export default function KeyModal({
  open,
  onClose,
  toast,
}: {
  open: boolean;
  onClose: () => void;
  toast: (m: string) => void;
}) {
  const [auth, setAuth] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const k = storedKey();
    setValue(k);
    setHasKey(!!k);
    setNote("");
    setAuth(null);
    fetch("/health")
      .then((r) => r.json())
      .then((d) => setAuth(typeof d?.auth === "string" ? d.auth : null))
      .catch(() => setAuth(null));
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = () => {
    const v = value.trim();
    if (!v) {
      setNote("Paste the API key first");
      return;
    }
    try {
      localStorage.setItem("slate-key", v);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("slate:key-changed"));
    onClose();
    toast("Access key saved - this browser will use it for every request");
  };

  const remove = () => {
    try {
      localStorage.removeItem("slate-key");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("slate:key-changed"));
    onClose();
    toast("Access key removed from this browser");
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center"
      role="dialog"
      aria-label="Access key"
    >
      <div className="absolute inset-0 bg-black/55" />
      <div className="glass-pop relative rounded-[6px] border border-line p-5 mt-[14vh] w-[min(480px,92vw)]">
        <h3 className="font-display text-[16px] font-semibold m-0">
          Access key
        </h3>
        <p className="text-[13px] text-mut leading-relaxed mt-2 mb-3">
          {keyModalCopy(auth)}
        </p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder="Paste your API key"
          autoComplete="off"
          className="w-full glass-input border border-line rounded-none px-3 py-2.5 text-[13.5px] text-ink"
        />
        {note && <p className="text-[12.5px] text-warn mb-0 mt-2">{note}</p>}
        <div className="flex gap-2 mt-4 justify-end">
          {hasKey && (
            <button
              className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer"
              onClick={remove}
            >
              Remove key
            </button>
          )}
          <button
            className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="font-sans text-[12.5px] font-medium px-3 py-1.5 rounded-none border border-blue text-white bg-blue hover:bg-[#2b5cd7] cursor-pointer"
            onClick={save}
          >
            Save key
          </button>
        </div>
      </div>
    </div>
  );
}
