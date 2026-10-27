import { Columns3 } from "lucide-react";
import type { AgentPresentation } from "../../features/agent/api";

type Presentation = Extract<AgentPresentation, { kind: "comparison-matrix" }>;

export function AgentComparisonMatrix({ presentation, onOpenMedia }: { presentation: Presentation; onOpenMedia: (id: string) => void }) {
  return <section className="agent-structured-card agent-comparison">
    <header><Columns3 size={14} /><strong>{presentation.title}</strong></header>
    <div className="agent-comparison-scroll"><table>
      <thead><tr><th>维度</th>{presentation.columns.map((column) => <th key={column.mediaId}><button type="button" onClick={() => onOpenMedia(column.mediaId)}>{column.code}</button></th>)}</tr></thead>
      <tbody>{presentation.rows.map((row) => <tr key={row.key}><th>{row.label}</th>{row.values.map((value, index) => <td key={`${row.key}:${presentation.columns[index]?.mediaId}`}>{value}</td>)}</tr>)}</tbody>
    </table></div>
  </section>;
}
