import { getIntlLocale } from "../i18n/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type AnimatedMetricProps = {
  value: number;
  formatter?: (value: number) => string;
  className?: string;
  label?: ReactNode;
  ariaLabel?: string;
  delay?: number;
  milestone?: number;
  milestoneAriaLabel?: string;
};

function splitMetricValue(value: string) {
  return Array.from(value).map((character, index) => ({
    character,
    index,
    digit: /^\d$/.test(character) ? Number(character) : null
  }));
}

export function AnimatedMetric({
  value,
  formatter = (nextValue) => nextValue.toLocaleString(getIntlLocale()),
  className = "",
  label,
  ariaLabel,
  delay = 0,
  milestone,
  milestoneAriaLabel
}: AnimatedMetricProps) {
  const [active, setActive] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const previousValueRef = useRef(0);
  const displayValue = useMemo(() => formatter(value), [formatter, value]);
  const characters = useMemo(() => splitMetricValue(displayValue), [displayValue]);
  const milestoneReached = milestone != null && value >= milestone;

  useEffect(() => {
    setActive(false);
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setActive(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayValue]);

  useEffect(() => {
    const crossedMilestone = milestone != null && previousValueRef.current < milestone && value >= milestone;
    previousValueRef.current = value;
    if (!crossedMilestone) return;

    const startTimer = window.setTimeout(
      () => setCelebrating(true),
      delay + characters.length * 42 + 420
    );
    const endTimer = window.setTimeout(
      () => setCelebrating(false),
      delay + characters.length * 42 + 2_850
    );
    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(endTimer);
    };
  }, [characters.length, delay, milestone, value]);

  return (
    <span
      aria-label={ariaLabel ?? `${label ?? ""}${displayValue}${milestoneReached && milestoneAriaLabel ? `，${milestoneAriaLabel}` : ""}`}
      className={`animated-metric${active ? " is-active" : ""}${milestoneReached ? " is-milestone" : ""}${celebrating ? " is-celebrating" : ""}${className ? ` ${className}` : ""}`}
      role="text"
    >
      {label && <span className="animated-metric-label">{label}</span>}
      <span aria-hidden="true" className="animated-metric-value">
        {characters.map(({ character, digit, index }) => digit === null ? (
          <span className={`animated-metric-symbol${character === " " ? " is-space" : ""}`} key={`${character}-${index}`}>{character}</span>
        ) : (
          <span className="animated-metric-digit" key={`digit-${index}`}>
            <span
              className="animated-metric-reel"
              style={{
                transform: `translateY(-${active ? digit : 0}em)`,
                transitionDelay: `${delay + index * 42}ms`
              }}
            >
              {Array.from({ length: 10 }, (_, reelDigit) => <span key={reelDigit}>{reelDigit}</span>)}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
