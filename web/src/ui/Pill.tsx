export type PillKind = "ok" | "warn" | "bad" | "info" | "grey";

const STYLES: Record<PillKind, string> = {
  ok: "text-ok bg-okbg",
  warn: "text-warn bg-warnbg",
  bad: "text-bad bg-badbg",
  info: "text-blue2 bg-[rgba(61,117,232,.13)]",
  grey: "text-mut bg-white/[0.06]",
};

/** Status pill, same language as the vanilla pill(): mono, small,
    tinted ground. */
export default function Pill({
  kind = "grey",
  children,
}: {
  kind?: PillKind;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-block font-mono text-[10.5px] font-medium px-2 py-[3px] rounded-[2px] whitespace-nowrap tracking-[0.02em] ${STYLES[kind]}`}
    >
      {children}
    </span>
  );
}
