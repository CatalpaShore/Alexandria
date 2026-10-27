import type { Response } from "express";

export const RESPONSE_READY_EVENT = "alexandria:response-ready";

export function markResponseReady(res: Response): void {
  res.emit(RESPONSE_READY_EVENT);
}
