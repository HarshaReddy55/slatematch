import Button from "./Button";
import { TitleRise } from "./motion";

/** Shared view header for the React stack: eyebrow with the vanilla
    view's section number, title, purpose line, refresh. The title
    block rises in on mount (TitleRise, the Stack Glass view-enter
    choreography); the view's panels follow via Rise. */
export default function ViewHead({
  eyebrow,
  title,
  purpose,
  onRefresh,
}: {
  eyebrow: string;
  title: string;
  purpose?: string;
  onRefresh: () => void;
}) {
  return (
    <header className="flex items-end justify-between gap-4 flex-wrap">
      <TitleRise>
        <p className="font-mono text-[11px] tracking-[0.08em] text-blue2 m-0">
          {eyebrow}
        </p>
        <h1 className="font-display text-[28px] font-semibold m-0 mt-1">
          {title}
        </h1>
        {purpose && (
          <p className="text-[13px] text-mut m-0 mt-1 max-w-[640px] leading-relaxed">
            {purpose}
          </p>
        )}
      </TitleRise>
      <div className="flex gap-2">
        <Button ghost href="/vanilla/">
          Vanilla app
        </Button>
        <Button onClick={onRefresh}>Refresh</Button>
      </div>
    </header>
  );
}

export function LoadError({ error }: { error: string }) {
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-4">
      <p className="text-sm text-bad m-0 break-words">{error}</p>
      <p className="text-sm text-mut mt-2 mb-0">
        If this workspace is locked with an API key, set it with ACCESS
        KEY in the sidebar; both stacks share the same browser key.
      </p>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="font-mono text-[12px] text-mut tracking-[0.04em] m-0 py-3">
      {label}
    </p>
  );
}
