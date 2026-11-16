import type { ReactNode } from "react";

/* The kit's data table, in the Dashboard run-history finish: mono
   uppercase header, hairline row rules, tabular figures. Used by the
   Stage 2 Insight views. The Ledger adds sortable headers (the
   EasyUI Advanced Data Table pattern, re-expressed in this kit).
   The table itself carries no surface: it inherits the glass of the
   Panel that contains it (the glass pass, GLASS.md), and its rows
   take a whisper of hover light. */

export function Th({
  children,
  onSort,
  sorted,
  className = "",
}: {
  children: ReactNode;
  onSort?: () => void;
  sorted?: "asc" | "desc" | null;
  className?: string;
}) {
  return (
    <th
      className={`py-2 pr-3 font-medium ${onSort ? "cursor-pointer select-none hover:text-ink" : ""} ${className}`}
      onClick={onSort}
    >
      {children}
      {sorted ? (sorted === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

export function Td({
  children,
  className = "",
  colSpan,
}: {
  children: ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td className={`py-2 pr-3 align-top ${className}`} colSpan={colSpan}>
      {children}
    </td>
  );
}

export default function DataTable({
  head,
  children,
}: {
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto mt-2">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left text-mut font-mono text-[10.5px] tracking-[0.06em] uppercase">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({
  children,
  id,
}: {
  children: ReactNode;
  id?: string;
}) {
  return (
    <tr
      id={id}
      className="border-t border-white/[0.05] transition-colors hover:bg-white/[0.02]"
    >
      {children}
    </tr>
  );
}
