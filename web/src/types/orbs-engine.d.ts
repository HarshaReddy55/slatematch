// The thinking-orbs engine is vendored vanilla ESM (MIT) at
// frontend/js/vendor/orbs-engine.js and is imported by both stacks.
// Aliased exports in the vendored chunk: M = MODE_FRAMES (frame
// generators per mode), p = paintFrame, r = resolvePreset.
declare module "*orbs-engine.js" {
  export const M: Record<
    string,
    (size: number, tSec: number, opts: Record<string, unknown>) => unknown
  >;
  export const p: (
    ctx: CanvasRenderingContext2D,
    frame: unknown,
    dark: boolean,
    tint?: string
  ) => void;
  export const r: (
    state: string,
    size: number
  ) => { mode: string; speed: number; opts: Record<string, unknown> };
}
