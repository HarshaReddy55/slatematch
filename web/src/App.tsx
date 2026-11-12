import { useEffect, useRef } from "react";
import { motion } from "motion/react";
// @ts-ignore - vendored ESM chunk, typed via src/types/orbs-engine.d.ts
import { M as MODE_FRAMES, p as paintFrame, r as resolvePreset } from "../../frontend/js/vendor/orbs-engine.js";

/* Stage 0 foundation proof, deliberately bare: it exists to prove the
   pipeline (Vite + React + TypeScript + Tailwind tokens + Motion) and
   one core assumption, that the vendored thinking-orbs engine imports
   into React unchanged. The designed Orb component is Stage 1 kit. */
const RENDER = 64;

function EngineProof() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { mode, speed, opts } = resolvePreset("solving", RENDER);
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
  }, []);
  return (
    <canvas
      ref={ref}
      width={RENDER * 2}
      height={RENDER * 2}
      style={{ width: 64, height: 64, filter: "drop-shadow(0 0 6px rgba(255,255,255,.30))" }}
      role="img"
      aria-label="Solving orb, rendered by the vendored engine inside React"
    />
  );
}

const SWATCHES: Array<[string, string]> = [
  ["bg", "bg-bg"],
  ["panel", "bg-panel"],
  ["blue", "bg-blue"],
  ["ok", "bg-ok"],
  ["warn", "bg-warn"],
  ["bad", "bg-bad"],
];

export default function App() {
  return (
    <main className="min-h-screen bg-bg text-ink font-sans flex items-center justify-center p-6">
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="bg-panel border border-line rounded-md p-6 max-w-md w-full"
      >
        <p className="font-mono text-[11px] tracking-[0.08em] text-blue2 m-0">
          REACT FOUNDATION - STAGE 0
        </p>
        <h1 className="font-display text-2xl font-semibold mt-2 mb-1">SlateMatch</h1>
        <p className="text-mut text-sm leading-relaxed mt-1">
          Pipeline check: Vite, React, TypeScript, Tailwind tokens and Motion
          are live. The orb below is the vendored thinking-orbs engine,
          imported into React unchanged.
        </p>
        <div className="flex items-center gap-4 mt-4">
          <EngineProof />
          <div className="flex gap-2">
            {SWATCHES.map(([name, cls]) => (
              <span key={name} className="flex flex-col items-center gap-1">
                <span className={`block w-6 h-6 rounded-sm border border-line2 ${cls}`} />
                <span className="font-mono text-[9px] text-mut2">{name}</span>
              </span>
            ))}
          </div>
        </div>
        <p className="font-mono text-[11px] text-mut2 mt-4 mb-0">
          Vanilla remains the product at / - this shell is the migration
          foundation only.
        </p>
      </motion.section>
    </main>
  );
}
