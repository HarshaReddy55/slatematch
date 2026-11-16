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
  /* Stage 6: vanilla's .btn exactly - square corners (the Serro
     pass sets .btn border-radius to 0), primary hover deepens to
     #2b5cd7 with no movement, ghost is transparent with a --line2
     border. */
  const cls = ghost
    ? "inline-flex items-center gap-2 font-sans text-[13px] font-medium px-3.5 py-2 rounded-none border border-line2 text-ink bg-transparent hover:border-blue cursor-pointer no-underline"
    : "inline-flex items-center gap-2 font-sans text-[13px] font-medium px-3.5 py-2 rounded-none border border-blue text-white bg-blue hover:bg-[#2b5cd7] cursor-pointer no-underline";
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
