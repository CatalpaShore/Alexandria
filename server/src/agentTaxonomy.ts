export const HEAVY_CONTENT_GENRE_LABELS = [
  "淫乱/硬核", "鬼畜", "SM", "BDSM", "拘束", "捆绑/紧缚", "捆绑", "绳缚",
  "调教/奴隶", "监禁", "肛交", "肛门玩法", "灌肠", "呕吐", "撒尿", "喝尿",
  "排尿/尿湿", "放尿", "凌辱", "羞辱", "强奸", "施虐", "酷刑", "粪便学", "粗暴的表达"
] as const;

type AgentGenreConcept = {
  value: string;
  aliases: readonly string[];
  genres: readonly string[];
};

const agentGenreConcepts: readonly AgentGenreConcept[] = [{
  value: "重口",
  aliases: ["重口", "重口味", "R-18G", "R18G", "R18-G", "硬核", "极端题材", "極端題材", "大尺度素材"],
  genres: HEAVY_CONTENT_GENRE_LABELS
}];

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[\s_-]+/gu, "").toLocaleLowerCase("zh-CN");
}

function queryIncludesAlias(query: string, alias: string): boolean {
  return normalized(query).includes(normalized(alias));
}

export function findAgentGenreConcepts(query: string): AgentGenreConcept[] {
  return agentGenreConcepts.filter((concept) => concept.aliases.some((alias) => queryIncludesAlias(query, alias)));
}

export function expandAgentGenreConcepts(query: string): string[] {
  return [...new Set(findAgentGenreConcepts(query).flatMap((concept) => [...concept.genres]))];
}

export function extractAgentGenreConceptValues(query: string): string[] {
  return findAgentGenreConcepts(query).map((concept) => concept.value);
}

export function genreMatchesAgentConcept(genre: string, conceptValue: string): boolean {
  const expected = normalized(conceptValue);
  const concept = agentGenreConcepts.find((item) => item.value === conceptValue
    || item.aliases.some((alias) => normalized(alias) === expected));
  return Boolean(concept?.genres.some((value) => normalized(value) === normalized(genre)));
}
