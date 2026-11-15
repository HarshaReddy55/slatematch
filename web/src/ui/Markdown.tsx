import type { ReactNode } from "react";

/* A line-for-line React port of vanilla's mdRender (insight.js):
   same block rules (fences, tables, h1-h4, hr, blockquote, lists,
   paragraphs joined with a space), same inline precedence (code,
   bold, italic, http links), same escape-first posture - raw HTML
   in a document renders as text, never as markup. The rendered
   text content equals vanilla's for the same markdown. */

function parseInline(text: string, keyBase: string): ReactNode[] {
  // code spans first
  const out: ReactNode[] = [];
  const parts = text.split(/`([^`]+)`/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(
        <code
          key={`${keyBase}-c${i}`}
          className="font-mono text-[0.92em] bg-white/[0.06] px-1 rounded-[2px]"
        >
          {part}
        </code>
      );
    } else if (part) {
      out.push(...parseBold(part, `${keyBase}-t${i}`));
    }
  });
  return out;
}

function parseBold(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/\*\*([^*]+)\*\*/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) out.push(<b key={`${keyBase}-b${i}`}>{part}</b>);
    else if (part) out.push(...parseItalic(part, `${keyBase}-i${i}`));
  });
  return out;
}

function parseItalic(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/\*([^*\n]+)\*/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) out.push(<i key={`${keyBase}-i${i}`}>{part}</i>);
    else if (part) out.push(...parseLink(part, `${keyBase}-l${i}`));
  });
  return out;
}

function parseLink(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/\[([^\]]+)\]\((https?:[^)\s]+)\)/);
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) out.push(parts[i]);
    if (i + 2 < parts.length) {
      out.push(
        <a
          key={`${keyBase}-a${i}`}
          href={parts[i + 2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue2 underline"
        >
          {parts[i + 1]}
        </a>
      );
    }
  }
  return out;
}

const isRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
const cells = (s: string) =>
  s
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export default function Markdown({ md }: { md: string }) {
  const lines = String(md).split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `md-${k++}`;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={key()}
          className="bg-bg2 border border-line rounded-[3px] p-3 overflow-x-auto my-3"
        >
          <code className="font-mono text-[12px] leading-relaxed">
            {buf.join("\n")}
          </code>
        </pre>
      );
      continue;
    }
    if (
      isRow(ln) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      const head = cells(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key()} className="overflow-x-auto my-3">
          <table className="w-full text-[12.5px] border-collapse">
            <thead>
              <tr className="text-left text-mut font-mono text-[10.5px] tracking-[0.06em] uppercase">
                {head.map((c, j) => (
                  <th key={j} className="py-1.5 pr-3 font-medium border-b border-line">
                    {parseInline(c, `${key()}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-white/[0.05]">
                  {r.map((c, j) => (
                    <td key={j} className="py-1.5 pr-3 align-top">
                      {parseInline(c, `${key()}-r${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const cls =
        lv === 1
          ? "font-display text-[20px] font-semibold mt-5 mb-2"
          : lv === 2
            ? "font-display text-[16.5px] font-semibold mt-5 mb-2"
            : "font-display text-[14.5px] font-semibold mt-4 mb-1.5";
      blocks.push(
        <div key={key()} className={cls} role="heading" aria-level={lv}>
          {parseInline(h[2], key())}
        </div>
      );
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) {
      blocks.push(<hr key={key()} className="border-white/[0.1] my-4" />);
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(ln)) {
      blocks.push(
        <blockquote
          key={key()}
          className="border-l-2 border-line2 pl-3 text-mut my-3"
        >
          {parseInline(ln.replace(/^\s*>\s?/, ""), key())}
        </blockquote>
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key()} className="list-disc pl-5 my-2 flex flex-col gap-1">
          {items.map((it, j) => (
            <li key={j} className="text-[13.5px] leading-relaxed">
              {parseInline(it, `${key()}-li${j}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key()} className="list-decimal pl-5 my-2 flex flex-col gap-1">
          {items.map((it, j) => (
            <li key={j} className="text-[13.5px] leading-relaxed">
              {parseInline(it, `${key()}-li${j}`)}
            </li>
          ))}
        </ol>
      );
      continue;
    }
    if (!ln.trim()) {
      i++;
      continue;
    }
    const para = [ln];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !isRow(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key()} className="text-[13.5px] leading-relaxed my-2">
        {parseInline(para.join(" "), key())}
      </p>
    );
  }
  return <div>{blocks}</div>;
}
