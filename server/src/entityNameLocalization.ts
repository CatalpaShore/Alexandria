export type EntityNameLocalizationTarget = "profile" | "metadata";

function normalizeEntityName(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function shouldForceEntityNameOverride(input: {
  override?: string;
  target: EntityNameLocalizationTarget;
  localized?: string;
  resolvedDisplayName?: string;
}): boolean {
  const override = normalizeEntityName(input.override);
  if (!override) return false;
  const current = input.target === "metadata" ? input.localized : input.resolvedDisplayName;
  return normalizeEntityName(current) !== override;
}
