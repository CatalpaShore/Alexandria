import type { ReactNode } from "react";

type MotionSurfaceProps = {
  children: ReactNode;
  className?: string;
  direction?: "backward" | "forward" | "neutral";
  label?: string;
  motionKey: string;
  pending?: boolean;
};

export function MotionSurface({
  children,
  className = "",
  direction = "neutral",
  label = "正在切换内容",
  motionKey,
  pending = false
}: MotionSurfaceProps) {
  return (
    <div
      aria-busy={pending || undefined}
      className={`motion-surface${pending ? " is-pending" : ""}${className ? ` ${className}` : ""}`}
      data-motion-direction={direction}
    >
      <div className="motion-surface-content" key={motionKey}>
        {children}
      </div>
      {pending && <span aria-label={label} className="motion-surface-pending" role="status" />}
    </div>
  );
}
