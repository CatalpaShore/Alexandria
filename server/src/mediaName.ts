function getFirstLetter(name: string): string {
  const match = name.match(/[A-Za-z0-9]/);
  if (!match) return "OTHER";
  const value = match[0].toUpperCase();
  return /[0-9]/.test(value) ? "#" : value;
}

function getCollectionBucket(basename: string, directory: string): string {
  return directory.split("/")[0] || getFirstLetter(basename);
}

function normalizeSeparatedJavNumber(number: string): string {
  return number.length < 3 ? number.padStart(3, "0") : number;
}

function normalizeCompactJavNumber(number: string): string {
  const withoutPadding = number.replace(/^0+(?=\d{3,}$)/, "");
  return normalizeSeparatedJavNumber(withoutPadding);
}

export function parseMediaName(basename: string, directory: string) {
  const cleanName = basename
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[.\s_-]+$/g, "")
    .trim();
  const fc2Match = cleanName.match(/^FC2[-_ ]?(?:PPV[-_ ]?)?(\d{4,9})(?:[-_ ]?(.*))?$/i);
  if (fc2Match) {
    const tailTags = (fc2Match[2] ?? "")
      .split(/[-_ .]+/)
      .map((tag) => tag.trim().toUpperCase())
      .filter(Boolean);

    return {
      collectionBucket: getCollectionBucket(basename, directory),
      codePrefix: "FC2",
      codeNumber: fc2Match[1],
      normalizedCode: `FC2-PPV-${fc2Match[1]}`,
      variantTags: ["PPV", ...tailTags],
      qualityTag: ""
    };
  }

  const compactJavMatch = cleanName.match(/^([A-Z]{2,10})(\d{3,7})(?:[-_ ]?(CH|[A-Z]))?[-_ ]*$/i);
  if (compactJavMatch) {
    const codePrefix = compactJavMatch[1].toUpperCase();
    const codeNumber = normalizeCompactJavNumber(compactJavMatch[2]);
    const suffix = (compactJavMatch[3] ?? "").toUpperCase();
    const variantTags = suffix ? [suffix === "CH" ? "C" : suffix] : [];

    return {
      collectionBucket: getCollectionBucket(basename, directory),
      codePrefix,
      codeNumber,
      normalizedCode: `${codePrefix}-${codeNumber}`,
      variantTags,
      qualityTag: ""
    };
  }

  const codeMatch = cleanName.match(/^([A-Z][A-Z0-9]{1,9})[-_ ]?(\d{1,7})(?:[-_ ]?(.*))?$/i);
  const codePrefix = codeMatch?.[1]?.toUpperCase() ?? "";
  const codeNumber = codeMatch?.[2] ? normalizeSeparatedJavNumber(codeMatch[2]) : "";
  const tail = codeMatch?.[3] ?? "";
  const normalizedCode = codePrefix && codeNumber ? `${codePrefix}-${codeNumber}` : cleanName.toUpperCase();
  const variantTags = tail
    .split(/[-_ .]+/)
    .map((tag) => tag.trim().toUpperCase())
    .filter(Boolean);
  const qualityTag =
    variantTags.find((tag) => ["4K", "UHD", "FHD", "HD", "1080P", "720P"].includes(tag)) ?? "";

  return {
    collectionBucket: getCollectionBucket(basename, directory),
    codePrefix,
    codeNumber,
    normalizedCode,
    variantTags,
    qualityTag
  };
}
