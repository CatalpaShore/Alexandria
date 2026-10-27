import { useEffect, useState } from "react";
import type { MetadataLanguage } from "../lib/metadataDisplay";

const METADATA_LANGUAGE_KEY = "adult-media-wall:metadata-language";

export function useMetadataLanguage() {
  const [metadataLanguage, setMetadataLanguage] = useState<MetadataLanguage>(() =>
    localStorage.getItem(METADATA_LANGUAGE_KEY) === "ja" ? "ja" : "zh"
  );

  useEffect(() => {
    localStorage.setItem(METADATA_LANGUAGE_KEY, metadataLanguage);
  }, [metadataLanguage]);

  return { metadataLanguage, setMetadataLanguage };
}
