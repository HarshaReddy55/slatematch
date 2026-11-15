import { useEffect, useRef, useState } from "react";

/** Animated number, the Obsidian dashboard behaviour, extended with
    the Stack Glass count-up-on-change (adapted 15 Nov 2026): values
    roll up from zero when data first arrives, and when the value
    later changes they count from the previous value to the new one
    instead of restarting at zero. Ease-out cubic (the same easing
    the vanilla dashboard's count-up used), 650ms, formatted by the
    caller's formatter throughout so commas and decimals match the
    final text exactly; the last frame is set with format(target)
    itself, so the settled text is byte-identical to a static render.
    Reduced motion lands on the final value immediately. */
export function useRollUp(
  target: number,
  format: (v: number) => string,
  duration = 650
): string {
  const [text, setText] = useState(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return format(target);
    return format(0);
  });
  const fmtRef = useRef(format);
  fmtRef.current = format;
  const prevRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !isFinite(target) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      prevRef.current = target;
      setText(fmtRef.current(target));
      return;
    }
    const from = prevRef.current === null ? 0 : prevRef.current;
    prevRef.current = target;
    if (from === target) {
      setText(fmtRef.current(target));
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min((t - t0) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setText(fmtRef.current(from + (target - from) * e));
      if (p < 1) raf = requestAnimationFrame(step);
      else setText(fmtRef.current(target));
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return text;
}
