import { useEffect, useRef, useState } from "react";

/** Animated number, the Obsidian dashboard behaviour: values roll up
    from zero with an ease-out cubic (the same easing the vanilla
    dashboard's count-up used), formatted by the caller's formatter so
    commas and decimals match the final text exactly. Reduced motion
    and a zero target land on the final value immediately. */
export function useRollUp(
  target: number,
  format: (v: number) => string,
  duration = 650
): string {
  const [text, setText] = useState(() => format(target));
  const fmtRef = useRef(format);
  fmtRef.current = format;
  useEffect(() => {
    if (
      !isFinite(target) ||
      target === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setText(fmtRef.current(target));
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min((t - t0) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setText(fmtRef.current(target * e));
      if (p < 1) raf = requestAnimationFrame(step);
      else setText(fmtRef.current(target));
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return text;
}
