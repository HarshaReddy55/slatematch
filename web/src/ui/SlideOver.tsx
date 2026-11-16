import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { EASE_OUT } from "./motion";

/* The evidence slide-over (Obsidian Analytics pattern, recorded in
   the adaptation ledger): a glass panel that slides in from the
   right over a scrim, carrying one record's full evidence while the
   view behind it keeps its place. Used for a match's derivation
   (Run, Approvals) and for the raw BAPI payload (SAP). The panel
   animates transform and opacity only; under reduced motion it is
   simply there or not there. Escape closes it. */
export default function SlideOver({
  open,
  title,
  onClose,
  children,
  width = "w-[min(700px,94vw)]",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Panel width utility; the Docs drawer narrows it to a reading
      column (Stage 4, audit row 14). */
  width?: string;
}) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (reduce) {
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-50" role="dialog" aria-label={title}>
        <button
          aria-label="Close"
          className="absolute inset-0 bg-black/55 cursor-pointer border-0"
          onClick={onClose}
        />
        <div className={`glass-pop absolute right-0 top-0 h-full ${width} overflow-y-auto border-l border-line p-5`}>
          <SlideHead title={title} onClose={onClose} />
          {children}
        </div>
      </div>
    );
  }
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-label={title}>
          <motion.button
            aria-label="Close"
            className="absolute inset-0 bg-black/55 cursor-pointer border-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            className={`glass-pop absolute right-0 top-0 h-full ${width} overflow-y-auto border-l border-line p-5`}
            initial={{ x: 48, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 48, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
          >
            <SlideHead title={title} onClose={onClose} />
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function SlideHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="font-display text-[15px] font-semibold text-ink m-0">
        {title}
      </h3>
      <button
        className="font-sans text-[13px] font-medium px-3 py-1.5 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer pressable"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}
