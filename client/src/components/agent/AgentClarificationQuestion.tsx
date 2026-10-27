import { Button, Input } from "antd";
import { ArrowRight, MessageCircleQuestion, Send } from "lucide-react";
import { useState } from "react";
import type { AgentPresentation } from "../../features/agent/api";

type Presentation = Extract<AgentPresentation, { kind: "clarification-question" }>;

export function AgentClarificationQuestion({
  answered = false,
  onAnswer,
  presentation
}: {
  answered?: boolean;
  onAnswer?: (answer: string) => void;
  presentation: Presentation;
}) {
  const [customAnswer, setCustomAnswer] = useState("");
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const submitAnswer = (answer: string) => {
    const value = answer.trim();
    if (!value || answered || selectedAnswer) return;
    setSelectedAnswer(value);
    onAnswer?.(value);
  };

  return (
    <section aria-label={presentation.title} className={`agent-clarification-card${answered ? " is-answered" : ""}`}>
      <header>
        <span><MessageCircleQuestion size={15} /></span>
        <div><strong>{presentation.title}</strong><small>{answered ? "已收到回答" : "回答后继续生成原请求"}</small></div>
      </header>
      <div className="agent-clarification-copy">
        <strong>{presentation.question}</strong>
        {presentation.why && <p>{presentation.why}</p>}
      </div>
      <div className="agent-clarification-options">
        {presentation.options.map((option) => {
          const selected = selectedAnswer === option.label;
          return (
            <button
              aria-pressed={selected}
              disabled={answered || Boolean(selectedAnswer)}
              key={option.id}
              onClick={() => submitAnswer(option.label)}
              type="button"
            >
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              <ArrowRight size={14} />
            </button>
          );
        })}
      </div>
      {presentation.allowCustom && !answered && (
        <div className="agent-clarification-custom">
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 3 }}
            disabled={Boolean(selectedAnswer)}
            onChange={(event) => setCustomAnswer(event.target.value)}
            onPressEnter={(event) => {
              if (event.shiftKey) return;
              event.preventDefault();
              submitAnswer(customAnswer);
            }}
            placeholder={presentation.customPlaceholder ?? "补充你的要求"}
            value={customAnswer}
          />
          <Button
            aria-label="提交补充回答"
            disabled={!customAnswer.trim() || Boolean(selectedAnswer)}
            icon={<Send size={13} />}
            onClick={() => submitAnswer(customAnswer)}
            type="primary"
          >
            继续
          </Button>
        </div>
      )}
    </section>
  );
}
