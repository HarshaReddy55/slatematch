import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

/* The shared motion system for the React stack, adapted from the
   Stack Glass motion study (uberdesigner.ai/t/stack-glass) under
   Harsha's direction of 15 Nov 2026 and recorded in the adaptation
   ledger (BEUI_COMPONENT_REVIEW.md) and MOTION.md. The behaviours
   are functional only, none ambient:

   1. The nav highlight springs between tabs (App.tsx, NAV_SPRING).
   2. A view-enter choreography: the title rises, then the view's
      blocks follow with a small stagger (TitleRise + Rise below).
   3. Feed rows slide in as records land (Agent Health audit trail).
   4. Expandable detail reveals with height-and-fade instead of
      appearing instantly (Reveal below): the Forecast drill table,
      the Agent Health status-bar readout, the Forecast what-if
      result. The container animates; the content inside is static.
   5. Refreshed regions cross-fade briefly instead of hard-flashing
      when a re-fetch changes them (RefreshFade below).

   Every piece honours prefers-reduced-motion: with reduced motion
   on, Rise and TitleRise render plain divs at the final state, the
   nav pill's spring collapses to zero duration, reveals open
   instantly and refresh fades do not run. No loops, no breathing,
   no drift, nothing decorative beyond the enter itself. */

/** The beUI EASE_OUT curve, already the kit's default UI easing. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Stack Glass spring character, stiffened for a console: fast
    travel, heavy damping, no overshoot theatrics. */
export const NAV_SPRING: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 40,
  mass: 0.9,
};

/** Enter stagger: 45ms steps, capped so a long view never turns the
    entrance into a ceremony. With the 240ms item duration, a typical
    four-to-five block view settles inside roughly 400ms. */
export const ENTER_STEP = 0.045;
export const ENTER_MAX_DELAY = 0.27;
export const ENTER_DURATION = 0.24;
export const ENTER_RISE_PX = 12;

/** One staggered block of a view's enter choreography. Wrap each
    top-level panel, card grid or section of a view in Rise with its
    order index; the block rises 12px and fades in when it mounts
    (which, for data-driven blocks, is when the data arrives). */
export function Rise({
  i = 0,
  className = "",
  children,
}: {
  i?: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: ENTER_RISE_PX }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ENTER_DURATION,
        delay: Math.min(i * ENTER_STEP, ENTER_MAX_DELAY),
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
}

/** Reveal timing: a third of a second to open on EASE_OUT, slightly
    quicker to close, so an expand feels deliberate and a collapse
    never lingers. */
export const REVEAL_IN = 0.32;
export const REVEAL_OUT = 0.2;

/** An expandable region that opens with a smooth height-and-fade
    instead of appearing instantly, and closes by reversing the same
    motion. Only the container animates (height, opacity, clipped);
    the children render statically inside it, so nothing reflows
    mid-animation beyond the container's own growth. Pass a stable
    revealKey per distinct content: when the key changes while open
    (a different drill week, a different selected run), the old
    content collapses out and the new content expands in
    (AnimatePresence mode="wait"). Under reduced motion the region
    is simply there or not there, instantly. */
export function Reveal({
  open,
  revealKey,
  className = "",
  children,
}: {
  open: boolean;
  revealKey: string;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) {
    return open ? <div className={className}>{children}</div> : null;
  }
  return (
    <AnimatePresence initial={false} mode="wait">
      {open && (
        <motion.div
          key={revealKey}
          className={className}
          variants={{
            open: {
              height: "auto",
              opacity: 1,
              transition: { duration: REVEAL_IN, ease: EASE_OUT },
            },
            closed: {
              height: 0,
              opacity: 0,
              transition: { duration: REVEAL_OUT, ease: EASE_OUT },
            },
          }}
          initial="closed"
          animate="open"
          exit="closed"
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A region whose content is replaced by a re-fetch (a table, a
    feed, a run history) cross-fades briefly when its data signature
    changes, instead of hard-flashing from old rows to new. The fade
    runs through the Web Animations API on the wrapper, so it costs
    no re-render and never touches layout; the first mount does not
    fade (the view's enter choreography covers arrival). The
    signature must describe the data, not presentational state: a
    filter keystroke must not retrigger it. Under reduced motion
    nothing fades. */
export function RefreshFade({
  signature,
  className = "",
  children,
}: {
  signature: string;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || reduce) return;
    const anim = el.animate([{ opacity: 0.3 }, { opacity: 1 }], {
      duration: 280,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
    return () => anim.cancel();
  }, [signature, reduce]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** The view title's entrance: a slightly longer rise than the blocks
    that follow it, so the eye lands on the title first. Used by
    ViewHead and by the Dashboard's own header. */
export function TitleRise({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.34, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
