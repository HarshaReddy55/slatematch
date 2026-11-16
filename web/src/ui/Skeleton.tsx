/* Stage 5, item 5: static skeleton loading states. When a view
   opens, its panels and cards appear immediately as still,
   panel-tone shapes while the data loads, instead of blank space
   under a one-line label. Deliberately NO shimmer or pulse: the
   UI lock refuses ambient loops in the core workspace, so the
   skeleton is static. Shapes mirror each view's real layout
   (stat-card row, table panels, field rows) so the settled view
   lands in the same place the eye is already looking. */

function Bar({ w, h = 12 }: { w: string; h?: number }) {
  return <div className="skel" style={{ width: w, height: h }} />;
}

function StatRow({ n }: { n: number }) {
  return (
    <div className={`grid gap-3 grid-cols-2 ${n >= 4 ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="glass-card rounded-md border border-white/[0.11] p-4 flex flex-col gap-2.5">
          <Bar w="45%" h={9} />
          <Bar w="65%" h={26} />
          <Bar w="80%" h={9} />
        </div>
      ))}
    </div>
  );
}

function PanelShape({
  lines,
  table,
}: {
  lines: number;
  table?: boolean;
}) {
  return (
    <div className="glass-panel rounded-md border border-white/[0.11] p-4 flex flex-col gap-3">
      <Bar w="180px" h={10} />
      {table ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: lines }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <Bar w="18%" h={11} />
              <Bar w="30%" h={11} />
              <Bar w="14%" h={11} />
              <Bar w="22%" h={11} />
              <Bar w="10%" h={11} />
            </div>
          ))}
        </div>
      ) : (
        Array.from({ length: lines }).map((_, i) => (
          <Bar key={i} w={`${88 - (i % 3) * 14}%`} h={11} />
        ))
      )}
    </div>
  );
}

function FieldRows({ n }: { n: number }) {
  return (
    <div className="glass-panel rounded-md border border-white/[0.11] p-4 flex flex-col gap-4">
      <Bar w="180px" h={10} />
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Bar w="26%" h={12} />
          <div className="skel" style={{ width: "22%", height: 30 }} />
          <Bar w="38%" h={10} />
        </div>
      ))}
    </div>
  );
}

export type SkeletonKind =
  | "stats"
  | "table"
  | "panels"
  | "run"
  | "form"
  | "chart";

export default function ViewSkeleton({ kind }: { kind: SkeletonKind }) {
  return (
    <div role="status" aria-label="Loading this view" className="flex flex-col gap-4">
      {kind === "stats" && (
        <>
          <StatRow n={4} />
          <PanelShape lines={4} table />
          <PanelShape lines={3} />
        </>
      )}
      {kind === "table" && (
        <>
          <PanelShape lines={7} table />
          <PanelShape lines={4} table />
        </>
      )}
      {kind === "panels" && (
        <>
          <PanelShape lines={3} />
          <PanelShape lines={4} />
          <PanelShape lines={3} />
        </>
      )}
      {kind === "run" && (
        <>
          <PanelShape lines={3} />
          <PanelShape lines={6} table />
          <PanelShape lines={3} />
        </>
      )}
      {kind === "form" && (
        <>
          <FieldRows n={5} />
          <FieldRows n={3} />
        </>
      )}
      {kind === "chart" && (
        <>
          <div className="glass-panel rounded-md border border-white/[0.11] p-4 flex flex-col gap-3">
            <Bar w="180px" h={10} />
            <div className="skel" style={{ width: "100%", height: 150 }} />
          </div>
          <PanelShape lines={5} table />
        </>
      )}
    </div>
  );
}
