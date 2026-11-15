import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import Markdown from "./Markdown";
import SlideOver from "./SlideOver";

/* Stage 4: the Product Docs drawer (insight.js openDocs /
   loadDocsList / readDoc), narrowed per audit row 14: vanilla's
   drawer is min(760px, 96vw), over half the screen for a reading
   surface; this one is a 560px reading column with a quiet list
   (title left, name and size in mono at the right). Header, intro
   line, endpoints and document content are unchanged - the
   markdown is rendered by the ported mdRender (ui/Markdown). */

interface DocMeta {
  name: string;
  title: string;
  bytes: number;
}

export default function DocsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [listNote, setListNote] = useState("");
  const [current, setCurrent] = useState("");
  const [md, setMd] = useState("");
  const [docError, setDocError] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);

  useEffect(() => {
    if (!open || docs) return;
    api<{ docs?: DocMeta[]; note?: string }>("/api/v1/docs")
      .then((d) => {
        setDocs(d.docs || []);
        if (!d.docs?.length)
          setListNote(d.note || "No documents found in this deployment.");
      })
      .catch((e) =>
        setListNote(e instanceof Error ? e.message : String(e))
      );
  }, [open, docs]);

  const read = useCallback((name: string) => {
    setCurrent(name);
    setMd("");
    setDocError("");
    setLoadingDoc(true);
    api<{ markdown: string }>(`/api/v1/docs/${encodeURIComponent(name)}`)
      .then((d) => setMd(d.markdown || ""))
      .catch((e) =>
        setDocError(e instanceof Error ? e.message : String(e))
      )
      .finally(() => setLoadingDoc(false));
  }, []);

  return (
    <SlideOver
      open={open}
      title="Product documents"
      onClose={onClose}
      width="w-[min(520px,94vw)]"
    >
      <p className="text-[13px] text-mut leading-relaxed m-0">
        The documents that ship in the repository under{" "}
        <span className="font-mono text-[12px]">docs/</span> - the same
        files, read live from the server.
      </p>
      <div className="flex flex-col mt-4 border-t border-white/[0.06]">
        {!docs && !listNote && (
          <p className="font-mono text-[11px] text-mut tracking-[0.04em] py-3 m-0">
            LOADING DOCUMENTS...
          </p>
        )}
        {listNote && (
          <p className="text-sm text-mut py-3 m-0">{listNote}</p>
        )}
        {(docs || []).map((d) => (
          <button
            key={d.name}
            onClick={() => read(d.name)}
            aria-current={current === d.name ? "true" : undefined}
            className={`flex items-baseline justify-between gap-3 text-left bg-transparent border-0 border-b border-white/[0.06] px-1 py-2.5 cursor-pointer ${
              current === d.name ? "text-blue2" : "text-ink hover:text-blue2"
            }`}
          >
            <span className="text-[13.5px] font-medium">{d.title}</span>
            <span className="font-mono text-[10.5px] text-mut2 whitespace-nowrap">
              {d.name} - {(d.bytes / 1024).toFixed(1)} KB
            </span>
          </button>
        ))}
      </div>
      {loadingDoc && (
        <p className="font-mono text-[11px] text-mut tracking-[0.04em] py-4 m-0">
          LOADING DOCUMENT...
        </p>
      )}
      {docError && (
        <p className="text-sm text-bad mt-4 break-words">{docError}</p>
      )}
      {md && (
        <div className="mt-2" data-docs-body="1">
          <Markdown md={md} />
        </div>
      )}
    </SlideOver>
  );
}
