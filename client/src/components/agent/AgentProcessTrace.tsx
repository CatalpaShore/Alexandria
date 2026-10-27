import { Check, CircleAlert, LoaderCircle, Search, Sparkles } from "lucide-react";
import type { AgentTraceStep } from "../../features/agent/api";

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return "";
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function AgentProcessTrace({
  trace,
  status
}: {
  trace: AgentTraceStep[];
  status: "generating" | "completed" | "failed" | "interrupted";
}) {
  if (trace.length === 0 && status === "completed") return null;
  const active = trace.find((step) => step.status === "active");
  const reasoning = trace.find((step) => step.key === "reason");
  const visibleSteps = trace.filter((step) => step.key !== "reason" && step.key !== "save");
  const totalDuration = trace.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const title = status === "generating"
    ? `正在分析${active?.label ? ` · ${active.label}` : ""}`
    : status === "completed"
      ? `思考过程摘要${totalDuration ? ` · ${formatDuration(totalDuration)}` : ""}`
      : status === "interrupted" ? "生成已停止" : "处理过程出现问题";

  return (
    <details className="agent-process" open={status === "generating"}>
      <summary>
        <span className="agent-process-summary-icon">
          {status === "generating" ? <LoaderCircle className="is-spinning" size={14} /> : <Sparkles size={14} />}
        </span>
        <span>{title}</span>
        <small>{status === "generating" ? active?.detail : "问题理解、馆藏依据与判断路径"}</small>
      </summary>
      {reasoning && (
        <div className={`agent-process-overview is-${reasoning.status}`}>
          <span><Sparkles size={12} /></span>
          <div><strong>判断路径</strong><small>{reasoning.detail}</small></div>
        </div>
      )}
      <div className="agent-process-steps">
        {visibleSteps.map((step) => (
          <div className={`agent-process-step is-${step.status}`} key={step.key}>
            <span>
              {step.status === "complete" ? <Check size={12} />
                : step.status === "active" ? <LoaderCircle className="is-spinning" size={12} />
                  : step.status === "failed" ? <CircleAlert size={12} /> : <Search size={12} />}
            </span>
            <div><strong>{step.label}</strong><small>{step.detail}</small></div>
            {step.durationMs != null && <time>{formatDuration(step.durationMs)}</time>}
          </div>
        ))}
      </div>
    </details>
  );
}
