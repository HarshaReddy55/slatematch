import type { ReactNode } from "react";

/** The product's panel surface: true glass since the Stack Glass
    pass (15 Nov 2026). The recipe lives once in index.css as
    .glass-panel (translucent panel ground, backdrop blur over the
    hairline texture and the lit ground, top-edge light line, deep
    soft shadow, hover lift); this component adds the brighter
    hairline border and the panel's padding and title structure.
    Tables (DataTable) inherit their glass from this container. */
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
      className={`glass-panel rounded-md border border-white/[0.11] p-4 sm:p-5 ${className}`}
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
