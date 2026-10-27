import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentCitation } from "../../features/agent/api";
import { normalizeAgentMarkdown, resolveAgentCitationReferences } from "./agentMarkdownUtils";

export function AgentMarkdown({ content, citations = [] }: { content: string; citations?: AgentCitation[] }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const safeHref = href && /^https?:\/\//i.test(href) ? href : null;
            return safeHref
              ? <a href={safeHref} rel="noreferrer noopener" target="_blank">{children}</a>
              : <span>{children}</span>;
          },
          table: ({ children }) => <div className="agent-table-scroll"><table>{children}</table></div>,
          img: () => null
        }}
      >
        {normalizeAgentMarkdown(resolveAgentCitationReferences(content, citations))}
      </ReactMarkdown>
    </div>
  );
}
