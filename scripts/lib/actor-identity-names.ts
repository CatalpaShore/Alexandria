function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja")
    .replace(/[\s\-_.・·()（）]+/gu, "");
}

function explicitIdentityAliases(value: string): string[] {
  const normalized = value.normalize("NFKC").trim();
  const aliases = [normalized];
  const bracketPattern = /[（(]([^()（）]+)[）)]/gu;
  for (const match of normalized.matchAll(bracketPattern)) {
    const alias = match[1]?.trim();
    if (!alias) continue;
    aliases.push(alias);
    // A parenthesized stage-name history sometimes lists several explicit
    // identities separated by Japanese/Chinese commas. Split only inside the
    // parentheses; never split free-form actor descriptions.
    aliases.push(...alias.split(/[、，,／/]+/u).map((item) => item.trim()).filter(Boolean));
  }
  return aliases;
}

export function normalizedActorIdentityNames(value: string): string[] {
  const identities = new Set<string>();
  for (const alias of explicitIdentityAliases(value)) {
    identities.add(normalizedName(alias));
    const latinParts = alias.split(/[\s\-_.・·]+/u).filter(Boolean);
    if (latinParts.length === 2 && latinParts.every((part) => /^[A-Za-z]+$/u.test(part))) {
      // Public indexes commonly alternate between "given family" and "family given".
      // Only admit the exact two-token reversal; broader fuzzy matching risks namesakes.
      identities.add(normalizedName([...latinParts].reverse().join(" ")));
    }
  }
  return [...identities].filter(Boolean);
}

export type StableActorIdentity = {
  kanji: string;
  romaji: string;
};

export function uniqueStableActorIdentityMatch<T extends StableActorIdentity>(
  targetActor: string,
  candidates: T[]
): T | null {
  const expected = new Set(normalizedActorIdentityNames(targetActor));
  if (!expected.size) return null;
  const matches = candidates.filter((candidate) => [candidate.kanji, candidate.romaji]
    .flatMap(normalizedActorIdentityNames)
    .some((name) => expected.has(name)));
  return matches.length === 1 ? matches[0]! : null;
}
