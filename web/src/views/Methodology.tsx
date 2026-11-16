import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import Panel from "../ui/Panel";
import ViewHead, { LoadError, Loading } from "../ui/ViewHead";
import DataTable, { Row, Td, Th } from "../ui/DataTable";
import { Rise } from "../ui/motion";

/* Methodology (view 12): the React port of vanilla's Methodology
   section. Vanilla renders this view from GET /api/v1/methodology -
   the formulas are served by the backend with the code they
   describe (backend/app/methodology.py) - and this port reads the
   same endpoint, so the two stacks can never drift apart. */

type Formula = { name: string; expr: string };
type Section = {
  title: string;
  what: string;
  formulae: Formula[];
  meaning: string;
};

export default function Methodology() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ sections: Section[] }>("/api/v1/methodology");
      setSections(d.sections);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        eyebrow="EVALS & ARCHITECTURE — 12 / METHODOLOGY"
        title="Methodology"
        purpose="Formulas and definitions used by the live product."
        onRefresh={load}
      />
      {error && <LoadError error={error} />}
      {!sections && !error && <Loading label="Loading methodology" />}
      {sections?.map((sec, i) => (
        <Rise key={sec.title} i={i}>
          <Panel title={sec.title} sub={sec.what}>
            <DataTable
              head={
                <>
                  <Th className="w-[230px]">Component</Th>
                  <Th>How it is computed</Th>
                </>
              }
            >
              {sec.formulae.map((f) => (
                <Row key={f.name}>
                  <Td>
                    <b>{f.name}</b>
                  </Td>
                  <Td className="font-mono text-[12.5px]">{f.expr}</Td>
                </Row>
              ))}
            </DataTable>
            <p className="text-[13.5px] leading-[1.6] mt-3 mb-0">
              <b>What it means:</b> {sec.meaning}
            </p>
          </Panel>
        </Rise>
      ))}
    </div>
  );
}
