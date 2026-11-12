/** A small area sparkline in the finish-pass language: gradient wash
    under the line, a glowing end point. One series, real data only. */
export default function Sparkline({
  points,
  color = "#3d75e8",
  width = 120,
  height = 30,
}: {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const X = (i: number) => (i / (points.length - 1)) * (width - 4) + 2;
  const Y = (v: number) => height - 3 - ((v - min) / span) * (height - 8);
  const line = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`)
    .join(" ");
  const gid = `sp-${color.replace("#", "")}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="block"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${X(points.length - 1).toFixed(1)} ${height} L${X(0).toFixed(1)} ${height} Z`} fill={`url(#${gid})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={X(points.length - 1)} cy={Y(points[points.length - 1])} r="4.5" fill={color} opacity="0.25" />
      <circle cx={X(points.length - 1)} cy={Y(points[points.length - 1])} r="2.2" fill={color} />
    </svg>
  );
}
