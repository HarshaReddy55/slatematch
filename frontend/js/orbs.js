/* v58 Thinking Orbs bridge: drives the vendored thinking-orbs engine
   (MIT, Jakub Antalik) from the classic-script frontend. Any canvas with
   a data-orb state gets a live orb; orbSync() mounts new ones and stops
   orbs whose canvas has left the document, so re-rendered surfaces never
   leak animation loops. Reduced motion gets one static frame. */
import { M as MODE_FRAMES, p as paintFrame, r as resolvePreset } from "./vendor/orbs-engine.js";

const mounts = new Map();
const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const RENDER = 64; // always draw the engine's large hand-tuned preset and
// let the browser scale it down to the display size: the dot field keeps
// the reference density instead of thinning out at small sizes.
function mount(canvas) {
  const state = canvas.dataset.orb || "working";
  const display = Number(canvas.dataset.orbSize || 28);
  const scale = 2;
  canvas.width = RENDER * scale;
  canvas.height = RENDER * scale;
  canvas.style.width = display + "px";
  canvas.style.height = display + "px";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { mode, speed, opts } = resolvePreset(state, RENDER);
  const frameFn = MODE_FRAMES[mode];
  const draw = (t) => {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, RENDER, RENDER);
    paintFrame(ctx, frameFn(RENDER, t, opts), true);
  };
  if (reduced) { draw(0.6); mounts.set(canvas, () => {}); return; }
  let raf = 0, running = true;
  const loop = () => { draw(performance.now() / 1e3 * speed); if (running) raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  mounts.set(canvas, () => { running = false; cancelAnimationFrame(raf); });
}

window.orbSync = function () {
  for (const [c, stop] of [...mounts]) if (!document.contains(c)) { stop(); mounts.delete(c); }
  document.querySelectorAll("canvas[data-orb]").forEach((c) => { if (!mounts.has(c)) mount(c); });
};
window.orbStopAll = function () {
  for (const [c, stop] of [...mounts]) { stop(); mounts.delete(c); }
};
