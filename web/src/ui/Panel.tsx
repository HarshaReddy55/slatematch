import type { ReactNode } from "react";

/** The product's panel surface. Stage 6 (vanilla fidelity
    restoration): .glass-panel in index.css now resolves to
    vanilla's flat panel - background --panel (#2a2a2a), no blur,
    no gradient, no shadow - and this component adds vanilla's
    --line border, square corners (livecube.css's Serro pass sets
    .panel border-radius to 0; measured 0px on the live vanilla
    app) and the panel's padding and title structure. Tables
    (DataTable) inherit their surface from this container. */
export default function Panel({
  title,
  sub,
  children,
  className = "",
}: {
  title?: string;
  sub?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`glass-panel rounded-none border border-line p-4 sm:p-5 ${className}`}
    >
      {title && (
        <h3 className="font-display text-[15px] font-semibold text-ink m-0">
          {title}
        </h3>
      )}
      {sub && <p className="text-[13px] text-mut mt-1 mb-0 leading-relaxed">{sub}</p>}
      {children}
    </section>
  );
}
