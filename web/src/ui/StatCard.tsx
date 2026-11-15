import { useRollUp } from "../lib/useRollUp";
import Sparkline from "./Sparkline";

/** The Obsidian-pattern metric card: label, a number that rolls up on
    load, an optional delta pill (coloured by whether the move is good,
    not just by direction), a sparkline of the real series, and a note
    that explains the number. The surface is the kit's glass card
    (.glass-card in index.css, the Stack Glass pass). */
export default function StatCard({
  label,
  value,
  format,
  note,
  spark,
  sparkColor,
  delta,
  deltaGood,
  deltaText,
}: {
  label: string;
  value: number | null;
  format: (v: number) => string;
  note?: string;
  spark?: number[];
  sparkColor?: string;
  delta?: number | null;
  deltaGood?: boolean;
  deltaText?: string;
}) {
  const rolled = useRollUp(value ?? 0, format);
  return (
    <div className="glass-card rounded-md border border-white/[0.11] p-4 flex flex-col gap-1 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[10.5px] tracking-[0.07em] uppercase text-mut">
          {label}
        </span>
        {delta != null && deltaText && (
          <span
            className={`font-mono text-[10.5px] font-medium px-2 py-[2px] rounded-full whitespace-nowrap ${
              deltaGood ? "text-ok bg-okbg" : "text-bad bg-badbg"
            }`}
          >
            {deltaText}
          </span>
        )}
      </div>
      <div className="font-display text-[30px] leading-none font-semibold text-ink mt-1">
        {value == null ? "-" : rolled}
      </div>
      {spark && spark.length > 1 && (
        <div className="mt-1">
          <Sparkline points={spark} color={sparkColor || "#3d75e8"} width={150} height={30} />
        </div>
      )}
      {note && <p className="text-[12px] text-mut leading-snug m-0 mt-1">{note}</p>}
    </div>
  );
}
