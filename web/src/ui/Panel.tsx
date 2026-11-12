import type { ReactNode } from "react";

/** The product's panel surface at finish-pass grade: gradient ground,
    hairline border in white alpha, a soft top highlight and shadow. */
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
      className={`rounded-md border border-white/[0.07] p-4 sm:p-5 ${className}`}
      style={{
        background: "linear-gradient(180deg,#2d2d2e,#272727)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.04), 0 4px 14px rgba(0,0,0,.28)",
      }}
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
