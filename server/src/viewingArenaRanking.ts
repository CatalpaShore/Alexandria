export const VIEWING_LANES = ["core", "adjacent", "wildcard"] as const;
export const VIEWING_FACET_TYPES = ["actor", "series", "genre", "director", "maker", "label"] as const;

export type ViewingLane = (typeof VIEWING_LANES)[number];
export type ViewingFacetType = (typeof VIEWING_FACET_TYPES)[number];

export type ViewingFacet = {
  type: ViewingFacetType;
  value: string;
};

export type ViewingSignal = ViewingFacet & {
  score: number;
};

export type ArenaDecisionRecord = {
  roundIndex: number;
  decision: "" | "choose" | "both" | "reject" | "reroll" | "skip" | "neutral";
  leftMediaId: string;
  rightMediaId: string;
  winnerMediaId: string | null;
};

export type ArenaSignalProfile = {
  positiveSignals: ViewingSignal[];
  negativeSignals: ViewingSignal[];
  confidence: number;
  diversity: number;
  decidedRounds: number;
  weights: Record<string, number>;
  lastImpact: {
    action: "choose" | "both" | "reject" | "skip" | "neutral";
    positiveSignals: ViewingSignal[];
    negativeSignals: ViewingSignal[];
  } | null;
};

export type ArenaRankCandidate<T = unknown> = {
  id: string;
  normalizedCode: string;
  baseScore: number;
  routeMatchCount: number;
  favorite: boolean;
  unwatched: boolean;
  facets: ViewingFacet[];
  payload: T;
};

export type RankedArenaCandidate<T = unknown> = ArenaRankCandidate<T> & {
  lane: ViewingLane;
  score: number;
  reason: string;
  matchedSignals: ViewingSignal[];
  newSignals: ViewingFacet[];
};

export type ArenaPairCandidate = {
  id: string;
  lane: ViewingLane;
  score: number;
  facets: ViewingFacet[];
};

export type ArenaStrategy = {
  id: "anchor" | "bridge" | "texture" | "boundary" | "surprise" | "confirm";
  label: string;
  prompt: string;
  leftLane: ViewingLane;
  rightLane: ViewingLane;
};

export const ARENA_STRATEGIES: ArenaStrategy[] = [
  { id: "anchor", label: "先看直觉", prompt: "先凭直觉选一部现在更想看的", leftLane: "core", rightLane: "core" },
  { id: "bridge", label: "熟悉还是变化", prompt: "一部更贴近刚才的选择，一部多一点变化，你更想看哪部？", leftLane: "core", rightLane: "adjacent" },
  { id: "texture", label: "选喜欢的风格", prompt: "两部都和你的选择有关，哪一部更对胃口？", leftLane: "adjacent", rightLane: "adjacent" },
  { id: "boundary", label: "试试新口味", prompt: "熟悉一点和新鲜一点之间，你现在更想看哪部？", leftLane: "adjacent", rightLane: "wildcard" },
  { id: "surprise", label: "不看旧偏好", prompt: "先不考虑之前的偏好，哪一部更吸引你？", leftLane: "wildcard", rightLane: "wildcard" },
  { id: "confirm", label: "最后一轮", prompt: "最后选一次：稳妥合口味，还是试试新方向？", leftLane: "core", rightLane: "wildcard" }
];

const FACET_WEIGHTS: Record<ViewingFacetType, number> = {
  actor: 38,
  series: 30,
  genre: 14,
  director: 22,
  maker: 16,
  label: 17
};

const FACET_LABELS: Record<ViewingFacetType, string> = {
  actor: "演员",
  series: "系列",
  genre: "题材",
  director: "导演",
  maker: "厂商",
  label: "厂牌"
};

function signalKey(signal: ViewingFacet): string {
  return `${signal.type}\u0000${signal.value}`;
}

function unpackSignal(key: string, score: number): ViewingSignal {
  const separator = key.indexOf("\u0000");
  return {
    type: key.slice(0, separator) as ViewingFacetType,
    value: key.slice(separator + 1),
    score
  };
}

function addWeight(target: Map<string, number>, facet: ViewingFacet, delta: number): void {
  const key = signalKey(facet);
  target.set(key, (target.get(key) ?? 0) + delta);
}

function uniqueFacets(facets: ViewingFacet[]): ViewingFacet[] {
  return [...new Map(facets.map((facet) => [signalKey(facet), facet])).values()];
}

function setDifference(left: ViewingFacet[], right: ViewingFacet[]): ViewingFacet[] {
  const rightKeys = new Set(right.map(signalKey));
  return left.filter((facet) => !rightKeys.has(signalKey(facet)));
}

function setIntersection(left: ViewingFacet[], right: ViewingFacet[]): ViewingFacet[] {
  const rightKeys = new Set(right.map(signalKey));
  return left.filter((facet) => rightKeys.has(signalKey(facet)));
}

function topSignals(weights: Map<string, number>, direction: "positive" | "negative", limit = 6): ViewingSignal[] {
  return [...weights.entries()]
    .filter(([, score]) => direction === "positive" ? score > 0.08 : score < -0.08)
    .map(([key, score]) => unpackSignal(key, Math.abs(score)))
    .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value))
    .slice(0, limit);
}

export function buildArenaSignalProfile(input: {
  initialSignals?: ViewingSignal[];
  branchSignals?: ViewingSignal[];
  rounds: ArenaDecisionRecord[];
  facetsByMediaId: Map<string, ViewingFacet[]>;
}): ArenaSignalProfile {
  const weights = new Map<string, number>();
  for (const signal of input.initialSignals ?? []) addWeight(weights, signal, signal.score);
  for (const signal of input.branchSignals ?? []) addWeight(weights, signal, signal.score);

  let lastImpact: ArenaSignalProfile["lastImpact"] = null;
  for (const round of [...input.rounds].sort((left, right) => left.roundIndex - right.roundIndex)) {
    if (!round.decision || round.decision === "reroll") continue;
    const left = uniqueFacets(input.facetsByMediaId.get(round.leftMediaId) ?? []);
    const right = uniqueFacets(input.facetsByMediaId.get(round.rightMediaId) ?? []);
    const impactWeights = new Map<string, number>();
    const impact = (facet: ViewingFacet, delta: number) => {
      addWeight(weights, facet, delta);
      addWeight(impactWeights, facet, delta);
    };

    if (round.decision === "choose" && round.winnerMediaId) {
      const winner = round.winnerMediaId === round.leftMediaId ? left : right;
      const alternative = round.winnerMediaId === round.leftMediaId ? right : left;
      for (const facet of setIntersection(winner, alternative)) impact(facet, 0.28);
      for (const facet of setDifference(winner, alternative)) impact(facet, 1);
      for (const facet of setDifference(alternative, winner)) impact(facet, -0.3);
    } else if (round.decision === "both" || round.decision === "neutral") {
      for (const facet of setIntersection(left, right)) impact(facet, 0.72);
      for (const facet of setDifference(left, right)) impact(facet, 0.22);
      for (const facet of setDifference(right, left)) impact(facet, 0.22);
    } else if (round.decision === "reject") {
      for (const facet of uniqueFacets([...left, ...right])) impact(facet, -0.62);
    }

    lastImpact = {
      action: round.decision,
      positiveSignals: topSignals(impactWeights, "positive", 3),
      negativeSignals: topSignals(impactWeights, "negative", 3)
    };
  }

  const positiveSignals = topSignals(weights, "positive");
  const negativeSignals = topSignals(weights, "negative");
  const decidedRounds = input.rounds.filter((round) => Boolean(round.decision) && round.decision !== "reroll").length;
  const positiveTypes = new Set(positiveSignals.map((signal) => signal.type)).size;
  const strongSignals = positiveSignals.filter((signal) => signal.score >= 0.75).length;

  return {
    positiveSignals,
    negativeSignals,
    confidence: Math.min(100, 18 + decidedRounds * 12 + strongSignals * 4),
    diversity: Math.min(100, 24 + positiveTypes * 10 + Math.min(positiveSignals.length, 6) * 3 + decidedRounds * 3),
    decidedRounds,
    weights: Object.fromEntries(weights),
    lastImpact
  };
}

function describeSignal(signal: ViewingSignal): string {
  return `${FACET_LABELS[signal.type]}「${signal.value}」`;
}

function rankCandidate<T>(candidate: ArenaRankCandidate<T>, profile: ArenaSignalProfile): Omit<RankedArenaCandidate<T>, "lane" | "reason"> & {
  affinity: number;
  negativeAffinity: number;
} {
  const matchedSignals: ViewingSignal[] = [];
  const newSignals: ViewingFacet[] = [];
  let affinity = 0;
  let negativeAffinity = 0;
  for (const facet of uniqueFacets(candidate.facets)) {
    const weight = profile.weights[signalKey(facet)] ?? 0;
    if (weight > 0) {
      const signal = { ...facet, score: weight };
      matchedSignals.push(signal);
      affinity += FACET_WEIGHTS[facet.type] * weight;
    } else if (weight < 0) {
      negativeAffinity += FACET_WEIGHTS[facet.type] * Math.abs(weight);
    } else if (newSignals.length < 6) {
      newSignals.push(facet);
    }
  }
  matchedSignals.sort((left, right) => right.score - left.score);
  const novelty = new Set(newSignals.map((facet) => facet.type)).size;
  const score = candidate.baseScore + affinity - negativeAffinity * 1.25 + novelty * 2.5;
  return { ...candidate, score, matchedSignals, newSignals, affinity, negativeAffinity };
}

function classifyLane(candidate: ReturnType<typeof rankCandidate>, pinned: boolean): ViewingLane {
  if (pinned || candidate.affinity >= 28 || candidate.routeMatchCount >= 2 || candidate.favorite) return "core";
  if (candidate.affinity > 0 || candidate.routeMatchCount > 0) return "adjacent";
  return "wildcard";
}

function laneReason(candidate: ReturnType<typeof rankCandidate>, lane: ViewingLane, pinned: boolean): string {
  if (pinned) return "你在刚才的对比中选中了这部";
  const match = candidate.matchedSignals[0];
  const next = candidate.newSignals.find((facet) => facet.type !== match?.type) ?? candidate.newSignals[0];
  if (lane === "core") return match ? `符合你刚才偏好的${describeSignal(match)}` : "最贴近你刚才的选择";
  if (lane === "adjacent") {
    if (match && next) return `保留${describeSignal(match)}，同时加入${FACET_LABELS[next.type]}「${next.value}」`;
    return match ? `保留${describeSignal(match)}，再换一点新风格` : "有熟悉的元素，也带来一些变化";
  }
  return next ? `试试较少出现的${FACET_LABELS[next.type]}「${next.value}」` : "和常看内容差别更大，并已避开不喜欢的方向";
}

function repeatPenalty(candidate: ArenaRankCandidate, selected: RankedArenaCandidate[]): number {
  const counts = new Map<string, number>();
  for (const item of selected) {
    for (const facet of uniqueFacets(item.facets)) counts.set(signalKey(facet), (counts.get(signalKey(facet)) ?? 0) + 1);
  }
  let penalty = 0;
  for (const facet of uniqueFacets(candidate.facets)) {
    const repeats = counts.get(signalKey(facet)) ?? 0;
    const weight = facet.type === "actor" ? 34
      : facet.type === "series" ? 26
        : facet.type === "director" ? 14
          : facet.type === "maker" || facet.type === "label" ? 10 : 4;
    penalty += repeats * weight;
  }
  return penalty;
}

function exceedsConcentrationCap(candidate: ArenaRankCandidate, selected: RankedArenaCandidate[]): boolean {
  const caps: Partial<Record<ViewingFacetType, number>> = { actor: 4, series: 3, director: 4, maker: 6, label: 5 };
  const counts = new Map<string, number>();
  for (const item of selected) {
    for (const facet of uniqueFacets(item.facets)) counts.set(signalKey(facet), (counts.get(signalKey(facet)) ?? 0) + 1);
  }
  return uniqueFacets(candidate.facets).some((facet) => {
    const cap = caps[facet.type];
    return cap != null && (counts.get(signalKey(facet)) ?? 0) >= cap;
  });
}

function quotaFor(limit: number): Record<ViewingLane, number> {
  const core = Math.ceil(limit / 3);
  const adjacent = Math.ceil((limit - core) / 2);
  return { core, adjacent, wildcard: Math.max(0, limit - core - adjacent) };
}

export function rankArenaCandidates<T>(input: {
  candidates: ArenaRankCandidate<T>[];
  profile: ArenaSignalProfile;
  limit: number;
  pinnedIds?: string[];
  focusLane?: ViewingLane;
}): RankedArenaCandidate<T>[] {
  const pinned = new Set(input.pinnedIds ?? []);
  const ranked = input.candidates.map((candidate) => {
    const details = rankCandidate(candidate, input.profile);
    let lane = classifyLane(details, pinned.has(candidate.id));
    if (input.focusLane === "core" && details.affinity > 0) lane = "core";
    if (input.focusLane === "adjacent" && lane === "core" && !pinned.has(candidate.id)) lane = "adjacent";
    if (input.focusLane === "wildcard" && lane === "adjacent" && details.affinity < 16) lane = "wildcard";
    return {
      ...details,
      lane,
      reason: laneReason(details, lane, pinned.has(candidate.id))
    };
  });
  const quotas = quotaFor(input.limit);
  const selected: RankedArenaCandidate<T>[] = [];
  const used = new Set<string>();

  const laneFitScore = (candidate: (typeof ranked)[number], lane: ViewingLane) => {
    const repetition = repeatPenalty(candidate, selected);
    if (lane === "core") return candidate.score - repetition;
    if (lane === "adjacent") {
      const bridgeAffinity = Math.min(candidate.affinity, 32) - Math.max(0, candidate.affinity - 32) * 1.5;
      return candidate.baseScore + bridgeAffinity + candidate.routeMatchCount * 5 - repetition;
    }
    return candidate.baseScore
      - candidate.affinity * 1.45
      - candidate.routeMatchCount * 24
      - (candidate.favorite ? 42 : 0)
      - repetition;
  };

  const selectForLane = (lane: ViewingLane, count: number) => {
    while (selected.filter((item) => item.lane === lane).length < count) {
      const exactPool = ranked.filter((candidate) => candidate.lane === lane && !used.has(candidate.id));
      const fallbackPool = ranked.filter((candidate) => (
        !used.has(candidate.id) && (lane === "core" || !pinned.has(candidate.id))
      ));
      const pool = exactPool.length ? exactPool : fallbackPool;
      if (!pool.length) break;
      const withinCap = pool.filter((candidate) => pinned.has(candidate.id) || !exceedsConcentrationCap(candidate, selected));
      const eligible = withinCap.length ? withinCap : pool;
      eligible.sort((left, right) => {
        const leftPinned = Number(pinned.has(left.id));
        const rightPinned = Number(pinned.has(right.id));
        return rightPinned - leftPinned
          || laneFitScore(right, lane) - laneFitScore(left, lane)
          || left.id.localeCompare(right.id);
      });
      const next = eligible[0];
      selected.push(next.lane === lane ? next : {
        ...next,
        lane,
        reason: laneReason(next, lane, pinned.has(next.id))
      });
      used.add(next.id);
    }
  };

  for (const lane of VIEWING_LANES) selectForLane(lane, quotas[lane]);
  while (selected.length < input.limit) {
    const pool = ranked.filter((candidate) => !used.has(candidate.id));
    if (!pool.length) break;
    pool.sort((left, right) => (right.score - repeatPenalty(right, selected)) - (left.score - repeatPenalty(left, selected)));
    const next = pool.find((candidate) => !exceedsConcentrationCap(candidate, selected)) ?? pool[0];
    selected.push(next);
    used.add(next.id);
  }
  return selected;
}

function facetSimilarity(left: ViewingFacet[], right: ViewingFacet[]): number {
  const leftKeys = new Set(uniqueFacets(left).map(signalKey));
  const rightKeys = new Set(uniqueFacets(right).map(signalKey));
  if (!leftKeys.size && !rightKeys.size) return 0;
  let shared = 0;
  for (const key of leftKeys) if (rightKeys.has(key)) shared += 1;
  return shared / Math.max(1, new Set([...leftKeys, ...rightKeys]).size);
}

function deterministicPairNoise(left: string, right: string, seed: number): number {
  let hash = seed | 0;
  for (const char of `${left}:${right}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619);
  return ((hash >>> 0) % 10_000) / 10_000;
}

export function pickAdaptiveArenaPair(input: {
  candidates: ArenaPairCandidate[];
  usedMediaIds?: Set<string>;
  strategyIndex: number;
  seed: number;
  focusLane?: ViewingLane;
}): { left: ArenaPairCandidate; right: ArenaPairCandidate; strategy: ArenaStrategy } | null {
  const baseStrategy = ARENA_STRATEGIES[input.strategyIndex % ARENA_STRATEGIES.length];
  const strategy = input.focusLane
    ? { ...baseStrategy, leftLane: input.focusLane, rightLane: input.focusLane === "core" ? "adjacent" : input.focusLane }
    : baseStrategy;
  const unused = input.candidates.filter((candidate) => !input.usedMediaIds?.has(candidate.id));
  const source = unused.length >= 2 ? unused : input.candidates;
  const leftPool = source.filter((candidate) => candidate.lane === strategy.leftLane);
  const rightPool = source.filter((candidate) => candidate.lane === strategy.rightLane);
  const leftCandidates = leftPool.length ? leftPool : source;
  const rightCandidates = rightPool.length ? rightPool : source;
  let best: { left: ArenaPairCandidate; right: ArenaPairCandidate; score: number } | null = null;
  for (const left of leftCandidates) {
    for (const right of rightCandidates) {
      if (left.id === right.id) continue;
      const similarity = facetSimilarity(left.facets, right.facets);
      const targetSimilarity = strategy.id === "anchor" || strategy.id === "texture" ? 0.24 : 0.06;
      const contrastScore = 60 - Math.abs(similarity - targetSimilarity) * 80;
      const quality = Math.min(80, Math.max(-20, (left.score + right.score) / 12));
      const noise = deterministicPairNoise(left.id, right.id, input.seed) * 5;
      const score = contrastScore + quality + noise;
      if (!best || score > best.score) best = { left, right, score };
    }
  }
  return best ? { left: best.left, right: best.right, strategy } : null;
}
