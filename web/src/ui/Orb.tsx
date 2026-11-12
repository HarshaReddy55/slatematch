import { useEffect, useRef } from "react";
// @ts-ignore - vendored ESM chunk, typed via src/types/orbs-engine.d.ts
import { M as MODE_FRAMES, p as paintFrame, r as resolvePreset } from "../../../frontend/js/vendor/orbs-engine.js";

/* The designed Orb component (Stage 1 kit): the vendored thinking-orbs
   engine, always drawn at its large 64-size preset and scaled down by
   the browser so the dot field keeps the reference density at any
   display size. Reduced motion renders one static frame. */
const RENDER = 64;

export default function Orb({
  state,
  size = 28,
  label,
}: {
  state: string;
  size?: number;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { mode, speed, opts } = resolvePreset(state, RENDER);
    const frameFn = MODE_FRAMES[mode];
    const draw = (t: number) => {
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, RENDER, RENDER);
      paintFrame(ctx, frameFn(RENDER, t, opts), true);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(0.6);
      return;
    }
    let raf = 0;
    const loop = () => {
      draw((performance.now() / 1000) * speed);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state]);
  return (
    <canvas
      ref={ref}
      width={RENDER * 2}
      height={RENDER * 2}
      style={{
        width: size,
        height: size,
        filter: "drop-shadow(0 0 5px rgba(255,255,255,.30))",
      }}
      role="img"
      aria-label={label || state}
    />
  );
}
