export default function Button({
  children,
  onClick,
  href,
  ghost = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  ghost?: boolean;
}) {
  const cls = ghost
    ? "inline-flex items-center gap-2 font-sans text-[13px] font-medium px-3.5 py-2 rounded-[3px] border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer no-underline"
    : "inline-flex items-center gap-2 font-sans text-[13px] font-medium px-3.5 py-2 rounded-[3px] border border-blue text-white bg-blue hover:bg-[#2f66d6] cursor-pointer no-underline";
  if (href)
    return (
      <a className={cls} href={href}>
        {children}
      </a>
    );
  return (
    <button className={cls} onClick={onClick}>
      {children}
    </button>
  );
}
