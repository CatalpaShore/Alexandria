export class R18RequestError extends Error {
  constructor(public readonly status: number) {
    super(`R18.dev request failed (${status})`);
    this.name = "R18RequestError";
  }
}

export function isRetryableR18Status(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isR18ProductUnavailableStatus(status: number): boolean {
  return status === 404;
}
