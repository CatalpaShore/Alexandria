import { getIntlLocale } from "../i18n/core";
import { useDemoStatus } from "./DemoNotice";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Empty, Input, Segmented, Select, Skeleton, Slider, Switch, Tag, Tooltip, Typography } from "antd";
import {
  ArrowLeft,
  Badge,
  CalendarRange,
  ChevronRight,
  ChevronsDown,
  Clapperboard,
  ExternalLink,
  Factory,
  Film,
  Focus,
  GitBranch,
  Heart,
  History,
  Layers3,
  Lock,
  Network,
  Redo2,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Tags,
  Undo2,
  Unlock,
  UsersRound,
  X,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchKnowledgeGraph,
  fetchKnowledgeGraphConnection,
  fetchKnowledgeGraphNeighbors,
  fetchKnowledgeGraphPath,
  fetchTopicOverview,
  getPosterUrl,
  type KnowledgeGraphData,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeGraphYearBucket,
  type MediaItem,
  type TopicType
} from "../lib/api";
import type { MetadataLanguage } from "../lib/metadataDisplay";
import { PosterImage } from "./PosterImage";
import "../knowledge-graph.css";

type GraphDimension = Extract<TopicType, "actor" | "series" | "genre" | "director" | "maker" | "label">;
type GraphLevel = "dimensions" | "entities" | "relations";
type KnowledgeGraphProps = {
  metadataLanguage: MetadataLanguage;
  onBack?: () => void;
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onOpenMedia?: (media: MediaItem) => void;
  onToggleFavorite?: (entity: { type: TopicType; value: string; label: string }, favorite: boolean) => void;
};
type GraphNodeView = {
  id: string;
  type: GraphDimension;
  value: string;
  label: string;
  originalLabel: string | null;
  mediaCount: number;
  degree: number;
  isFavorite: boolean;
  mediaId: string | null;
  coverKind: "manual" | "representative" | "none";
  latestReleaseDate: string | null;
};
type GraphEdgeView = {
  id: string;
  source: string;
  target: string;
  strength: number;
  sharedCount: number;
  affinity: number;
  relationType: string;
  relationLabel: string;
};
type Point = { x: number; y: number };
type Scene = {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  positions: Record<string, Point>;
  pinned: string[];
  breadcrumbs: string[];
  addedBy: Record<string, string>;
};
type DrillStep = { node: GraphNodeView; targetType: GraphDimension };
type StoredExploration = {
  id: string;
  savedAt: string;
  title: string;
  scene: Scene;
  level?: GraphLevel;
  activeDimension?: GraphDimension | null;
  targetDimension?: GraphDimension;
  trail?: DrillStep[];
};
type NeighborRequest = { source: GraphNodeView; targetType: GraphDimension; trail: DrillStep[] };

const { Text, Title } = Typography;
const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 640;
const HISTORY_KEY = "amw:knowledge-graph:history:v2";
const LEGACY_HISTORY_KEY = "amw:knowledge-graph:history:v1";
const NODE_LIMIT_MARKS = { 20: "20", 60: "60", 100: "100" };
const DIMENSIONS: Array<{
  type: GraphDimension;
  label: string;
  description: string;
  color: string;
  icon: LucideIcon;
}> = [
  { type: "actor", label: "演员", description: "从出演关系探索作品、标签与合作演员", color: "#ff9900", icon: UsersRound },
  { type: "series", label: "主题", description: "按系列与主题聚合内容，再查看关联人物", color: "#4cc9a7", icon: Layers3 },
  { type: "genre", label: "标签", description: "从内容标签发现相邻题材与代表作品", color: "#e66fb1", icon: Tags },
  { type: "director", label: "导演", description: "查看导演、演员、厂商之间的创作关系", color: "#6ea8fe", icon: Clapperboard },
  { type: "maker", label: "厂商", description: "从制作厂商下钻系列、厂牌和作品", color: "#ffd166", icon: Factory },
  { type: "label", label: "厂牌", description: "探索厂牌旗下系列与常见合作关系", color: "#a78bfa", icon: Badge }
];
const DIMENSION_BY_TYPE = new Map(DIMENSIONS.map((item) => [item.type, item]));
const GENERIC_GRAPH_GENRES = new Set([
  "高清", "高画质", "hd", "4k", "单体作品", "單體作品", "独家配信", "獨家配信", "独占配信",
  "samplevideo", "サンプル動画", "样片"
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string" && String(record[key]).trim()) return String(record[key]).trim();
  }
  return null;
}

function numberValue(record: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const result = Number(record[key]);
    if (Number.isFinite(result)) return result;
  }
  return fallback;
}

function normalizeNode(node: KnowledgeGraphNode, language: MetadataLanguage): GraphNodeView | null {
  const record = asRecord(node);
  const type = stringValue(record, ["type", "entityType", "facetType"]);
  const value = stringValue(record, ["value", "entityValue", "id"]);
  if (!type || !value || !DIMENSION_BY_TYPE.has(type as GraphDimension)) return null;
  const localized = stringValue(record, ["labelZh", "localizedLabel", "displayLabel", "label", "name"]);
  const label = language === "zh" ? localized || value : value;
  return {
    id: stringValue(record, ["id", "key"]) || `${type}:${value}`,
    type: type as GraphDimension,
    value,
    label,
    originalLabel: value !== label ? value : null,
    mediaCount: Math.max(0, numberValue(record, ["mediaCount", "workCount", "count"])),
    degree: Math.max(0, numberValue(record, ["degree", "connectionCount"])),
    isFavorite: Boolean(record.isFavorite),
    mediaId: stringValue(record, ["mediaId", "coverMediaId"]),
    coverKind: (stringValue(record, ["coverKind"]) as GraphNodeView["coverKind"]) || "none",
    latestReleaseDate: stringValue(record, ["latestReleaseDate", "releaseDate"])
  };
}

function endpointId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return value && typeof value === "object" ? stringValue(asRecord(value), ["id", "key"]) : null;
}

function normalizeEdge(edge: KnowledgeGraphEdge, index: number): GraphEdgeView | null {
  const record = asRecord(edge);
  const source = endpointId(record.source) || endpointId(record.sourceId) || endpointId(record.from);
  const target = endpointId(record.target) || endpointId(record.targetId) || endpointId(record.to);
  if (!source || !target || source === target) return null;
  const relationType = stringValue(record, ["relationType", "type", "kind"]) || "shared_media";
  return {
    id: stringValue(record, ["id", "key"]) || `${source}:${target}:${index}`,
    source,
    target,
    strength: Math.max(0.001, numberValue(record, ["strength", "weight", "sharedMediaCount", "count"], 1)),
    sharedCount: Math.max(1, numberValue(record, ["sharedCount", "weight", "sharedMediaCount", "count"], 1)),
    affinity: Math.max(0, Math.min(1, numberValue(record, ["affinity"], 0))),
    relationType,
    relationLabel: stringValue(record, ["relationLabel", "label"]) || "共同作品"
  };
}

function normalizeGraph(data: Pick<KnowledgeGraphData, "nodes" | "edges">, language: MetadataLanguage) {
  const nodes = (data.nodes || [])
    .map((node) => normalizeNode(node, language))
    .filter((node): node is GraphNodeView => Boolean(node));
  const edges = (data.edges || [])
    .map(normalizeEdge)
    .filter((edge): edge is GraphEdgeView => Boolean(edge));
  return { nodes, edges };
}

function seededUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function layoutEntityLayer(nodes: GraphNodeView[], width: number): Record<string, Point> {
  const center = { x: width / 2, y: GRAPH_HEIGHT / 2 + 8 };
  const maxRadius = Math.min(width * 0.42, GRAPH_HEIGHT * 0.45);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  return Object.fromEntries(nodes.map((node, index) => {
    if (index === 0) return [node.id, center];
    const progress = Math.sqrt(index / Math.max(1, nodes.length - 1));
    const angle = index * goldenAngle + seededUnit(node.id) * 0.72;
    const radius = 62 + progress * (maxRadius - 62);
    const drift = (seededUnit(`${node.id}:drift`) - 0.5) * 36;
    return [node.id, {
      x: Math.max(54, Math.min(width - 54, center.x + Math.cos(angle) * radius * 1.34 + drift)),
      y: Math.max(58, Math.min(GRAPH_HEIGHT - 54, center.y + Math.sin(angle) * radius * 0.84 + drift * 0.22))
    }];
  }));
}

function layoutRelationLayer(nodes: GraphNodeView[], width: number, sourceId: string): Record<string, Point> {
  const source = nodes.find((node) => node.id === sourceId) || nodes[0];
  const targets = nodes.filter((node) => node.id !== source?.id);
  const center = { x: width <= 600 ? width * 0.42 : width * 0.38, y: GRAPH_HEIGHT * 0.53 };
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const maxRadius = Math.min(width * 0.43, GRAPH_HEIGHT * 0.43);
  const positions: Record<string, Point> = {};
  if (source) positions[source.id] = center;
  targets.forEach((node, index) => {
    const progress = Math.sqrt((index + 1) / Math.max(1, targets.length));
    const angle = index * goldenAngle - 0.55 + (seededUnit(node.id) - 0.5) * 0.5;
    const radius = 112 + progress * (maxRadius - 88);
    positions[node.id] = {
      x: Math.max(54, Math.min(width - 52, center.x + Math.cos(angle) * radius * 1.42)),
      y: Math.max(62, Math.min(GRAPH_HEIGHT - 54, center.y + Math.sin(angle) * radius * 0.86))
    };
  });
  return positions;
}

function curvedEdgePath(source: Point, target: Point, seed: string): string {
  const midpoint = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = (seededUnit(seed) - 0.5) * Math.min(78, length * 0.34);
  const control = {
    x: midpoint.x - dy / length * bend,
    y: midpoint.y + dx / length * bend
  };
  return `M ${source.x} ${source.y} Q ${control.x} ${control.y} ${target.x} ${target.y}`;
}

function layoutGraph(
  nodes: GraphNodeView[],
  edges: GraphEdgeView[],
  width: number,
  previous: Record<string, Point> = {},
  pinnedIds: string[] = []
): Record<string, Point> {
  const pinned = new Set(pinnedIds);
  const center = { x: width / 2, y: GRAPH_HEIGHT / 2 };
  const positions = nodes.map((node) => {
    const old = previous[node.id];
    const dimension = Math.max(0, DIMENSIONS.findIndex((item) => item.type === node.type));
    const angle = dimension / DIMENSIONS.length * Math.PI * 2 + (seededUnit(node.id) - 0.5) * 0.8;
    const radius = Math.min(width, GRAPH_HEIGHT) * (0.15 + 0.28 * seededUnit(`${node.id}:r`));
    return {
      id: node.id,
      x: old?.x ?? center.x + Math.cos(angle) * radius,
      y: old?.y ?? center.y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0
    };
  });
  const byId = new Map(positions.map((node, index) => [node.id, index]));
  for (let iteration = 0; iteration < 62; iteration += 1) {
    const cooling = 1 - iteration / 76;
    for (let a = 0; a < positions.length; a += 1) {
      for (let b = a + 1; b < positions.length; b += 1) {
        const first = positions[a];
        const second = positions[b];
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        const distanceSq = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSq);
        const force = Math.min(2.5, 2100 / distanceSq) * cooling;
        dx /= distance;
        dy /= distance;
        if (!pinned.has(first.id)) {
          first.vx -= dx * force;
          first.vy -= dy * force;
        }
        if (!pinned.has(second.id)) {
          second.vx += dx * force;
          second.vy += dy * force;
        }
      }
    }
    for (const edge of edges) {
      const ai = byId.get(edge.source);
      const bi = byId.get(edge.target);
      if (ai == null || bi == null) continue;
      const first = positions[ai];
      const second = positions[bi];
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 115) * 0.0028 * cooling;
      if (!pinned.has(first.id)) {
        first.vx += dx / distance * force;
        first.vy += dy / distance * force;
      }
      if (!pinned.has(second.id)) {
        second.vx -= dx / distance * force;
        second.vy -= dy / distance * force;
      }
    }
    for (const node of positions) {
      if (pinned.has(node.id)) continue;
      node.vx = (node.vx + (center.x - node.x) * 0.0007) * 0.78;
      node.vy = (node.vy + (center.y - node.y) * 0.0007) * 0.78;
      node.x = Math.max(42, Math.min(width - 42, node.x + node.vx * 5));
      node.y = Math.max(38, Math.min(GRAPH_HEIGHT - 38, node.y + node.vy * 5));
    }
  }
  return Object.fromEntries(positions.map(({ id, x, y }) => [id, { x, y }]));
}

function graphLabel(label: string) {
  return label.length > 12 ? `${label.slice(0, 11)}...` : label;
}

function defaultTargetDimension(sourceType: GraphDimension): GraphDimension {
  if (sourceType === "actor") return "genre";
  if (sourceType === "genre") return "actor";
  if (sourceType === "series") return "actor";
  if (sourceType === "director") return "actor";
  return "series";
}

function normalizeGenreKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_\-/]+/g, "");
}

function readHistory(): StoredExploration[] {
  try {
    const stored = localStorage.getItem(HISTORY_KEY) || localStorage.getItem(LEGACY_HISTORY_KEY) || "[]";
    const value = JSON.parse(stored);
    return Array.isArray(value) ? value.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function KnowledgeGraph({ metadataLanguage, onBack, onOpenEntity, onOpenMedia, onToggleFavorite }: KnowledgeGraphProps) {
  useLocale();
  const [graphLevel, setGraphLevel] = useState<GraphLevel>("dimensions");
  const [activeDimension, setActiveDimension] = useState<GraphDimension | null>(null);
  const [targetDimension, setTargetDimension] = useState<GraphDimension>("actor");
  const [drillTrail, setDrillTrail] = useState<DrillStep[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [nodeLimit, setNodeLimit] = useState(60);
  const demo = useDemoStatus();
  const [minSharedOverride, setMinShared] = useState<number | null>(null);
  const minShared = minSharedOverride ?? (demo.data?.demo ? 1 : 2);
  const [category, setCategory] = useState<"ALL" | "JAV" | "FC2">("ALL");
  const [hideGeneric, setHideGeneric] = useState(true);
  const [scene, setScene] = useState<Scene | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [undoStack, setUndoStack] = useState<Scene[]>([]);
  const [redoStack, setRedoStack] = useState<Scene[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [history, setHistory] = useState<StoredExploration[]>(() => readHistory());
  const [compactLayout, setCompactLayout] = useState(false);
  const [yearRange, setYearRange] = useState<[number, number] | null>(null);
  const [yearDraft, setYearDraft] = useState<[number, number] | null>(null);
  const [pathStatus, setPathStatus] = useState<"idle" | "found" | "empty">("idle");
  const graphRef = useRef<SVGSVGElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setCompactLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const graphWidth = compactLayout ? 560 : GRAPH_WIDTH;
  const overviewQuery = useQuery({
    queryKey: ["knowledge-graph-overview"],
    queryFn: fetchTopicOverview,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000
  });
  const graphQuery = useQuery({
    queryKey: ["knowledge-graph-layer", activeDimension, debouncedSearch, nodeLimit, minShared, category, hideGeneric, metadataLanguage, yearRange],
    queryFn: () => fetchKnowledgeGraph({
      types: activeDimension ? [activeDimension] : [],
      q: debouncedSearch || undefined,
      limit: nodeLimit,
      minShared,
      category,
      hideGeneric,
      yearFrom: yearRange?.[0],
      yearTo: yearRange?.[1]
    }),
    enabled: graphLevel === "entities" && Boolean(activeDimension),
    staleTime: 5 * 60 * 1000,
    gcTime: 20 * 60 * 1000
  });
  const baseGraph = useLocalizedMemo(
    () => graphQuery.data ? normalizeGraph(graphQuery.data, metadataLanguage) : { nodes: [], edges: [] },
    [graphQuery.data, metadataLanguage]
  );

  useEffect(() => {
    if (graphLevel !== "entities" || !graphQuery.data) return;
    const current = sceneRef.current;
    const positions = layoutEntityLayer(baseGraph.nodes, graphWidth);
    const next: Scene = {
      nodes: baseGraph.nodes,
      edges: [],
      positions,
      pinned: (current?.pinned || []).filter((id) => baseGraph.nodes.some((node) => node.id === id)),
      breadcrumbs: [],
      addedBy: {}
    };
    setScene(next);
    setUndoStack([]);
    setRedoStack([]);
    setPathIds([]);
    setSelectedId((id) => id && next.nodes.some((node) => node.id === id) ? id : next.nodes[0]?.id ?? null);
  }, [baseGraph, graphLevel, graphQuery.data, graphWidth]);

  const nodes = useLocalizedMemo(() => scene?.nodes || [], [scene?.nodes]);
  const edges = useLocalizedMemo(() => scene?.edges || [], [scene?.edges]);
  const nodesById = useLocalizedMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedId ? nodesById.get(selectedId) || null : null;
  const relationSourceId = drillTrail.at(-1)?.node.id || null;
  const pathNodeSet = useLocalizedMemo(() => new Set(pathIds), [pathIds]);
  const pathEdgeSet = useLocalizedMemo(() => new Set(edges.filter((edge) => {
    const first = pathIds.indexOf(edge.source);
    const second = pathIds.indexOf(edge.target);
    return first >= 0 && second >= 0 && Math.abs(first - second) === 1;
  }).map((edge) => edge.id)), [edges, pathIds]);
  const relatedNodes = useLocalizedMemo(() => selectedNode ? edges
    .filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id)
    .map((edge) => ({ edge, node: nodesById.get(edge.source === selectedNode.id ? edge.target : edge.source) }))
    .filter((item): item is { edge: GraphEdgeView; node: GraphNodeView } => Boolean(item.node))
    .sort((left, right) => right.edge.strength - left.edge.strength) : [], [edges, nodesById, selectedNode]);

  useEffect(() => {
    setSelectedConnectionId((id) => id && relatedNodes.some((item) => item.edge.id === id)
      ? id
      : relatedNodes[0]?.edge.id ?? null);
  }, [relatedNodes]);

  const selectedConnection = selectedConnectionId
    ? relatedNodes.find((item) => item.edge.id === selectedConnectionId) || null
    : null;
  const connectionQuery = useInfiniteQuery({
    queryKey: ["knowledge-graph-connection", selectedNode?.id, selectedConnection?.node.id, category, yearRange],
    queryFn: ({ pageParam }) => fetchKnowledgeGraphConnection({
      sourceType: selectedNode!.type,
      sourceValue: selectedNode!.value,
      targetType: selectedConnection!.node.type,
      targetValue: selectedConnection!.node.value,
      category,
      limit: 12,
      cursor: pageParam || undefined,
      minShared,
      yearFrom: yearRange?.[0],
      yearTo: yearRange?.[1]
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.pageInfo?.nextCursor ?? lastPage.pagination?.nextCursor ?? undefined,
    enabled: Boolean(graphLevel === "relations" && selectedNode && selectedConnection),
    staleTime: 5 * 60 * 1000
  });
  const connectionPages = useLocalizedMemo(() => connectionQuery.data?.pages || [], [connectionQuery.data?.pages]);
  const connectionSummary = connectionPages[0];
  const connectionItems = useLocalizedMemo(() => {
    const byId = new Map<string, MediaItem>();
    connectionPages.forEach((page) => page.items.forEach((item) => byId.set(item.id, item)));
    return [...byId.values()];
  }, [connectionPages]);

  const mutateScene = useCallback((create: (current: Scene) => Scene) => {
    setScene((current) => {
      if (!current) return current;
      const next = create(current);
      setUndoStack((stack) => [...stack.slice(-19), current]);
      setRedoStack([]);
      return next;
    });
  }, []);

  const saveHistory = useCallback((next: Scene, trail: DrillStep[], nextTarget: GraphDimension) => {
    const title = trail.at(-1)?.node.label || next.nodes[0]?.label || "知识图谱探索";
    const item: StoredExploration = {
      id: `${Date.now()}`,
      savedAt: new Date().toISOString(),
      title,
      scene: next,
      level: "relations",
      activeDimension,
      targetDimension: nextTarget,
      trail
    };
    setHistory((current) => {
      const updated = [item, ...current].slice(0, 8);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [activeDimension]);

  const neighborsMutation = useMutation({
    mutationFn: ({ source, targetType }: NeighborRequest) => fetchKnowledgeGraphNeighbors({
      sourceType: source.type,
      sourceValue: source.value,
      targetTypes: [targetType],
      category,
      limit: Math.min(30, nodeLimit),
      minShared,
      yearFrom: yearRange?.[0],
      yearTo: yearRange?.[1]
    }),
    onSuccess: (data, request) => {
      const incoming = normalizeGraph({
        nodes: data.source ? [data.source, ...data.nodes] : data.nodes,
        edges: data.edges
      }, metadataLanguage);
      const source = incoming.nodes.find((node) => node.id === request.source.id) || request.source;
      const nodeMap = new Map<string, GraphNodeView>([[source.id, source]]);
      incoming.nodes.forEach((node) => nodeMap.set(node.id, node));
      const nextNodes = [...nodeMap.values()].filter((node) => node.id === source.id || !(
        hideGeneric &&
        node.type === "genre" &&
        GENERIC_GRAPH_GENRES.has(normalizeGenreKey(node.label))
      ));
      const visibleNodeIds = new Set(nextNodes.map((node) => node.id));
      const nextEdges = incoming.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
      const current = sceneRef.current;
      const next: Scene = {
        nodes: nextNodes,
        edges: nextEdges,
        positions: layoutRelationLayer(nextNodes, graphWidth, source.id),
        pinned: (current?.pinned || []).filter((id) => nodeMap.has(id)),
        breadcrumbs: request.trail.map((step) => step.node.id),
        addedBy: Object.fromEntries(nextNodes.filter((node) => node.id !== source.id).map((node) => [node.id, source.id]))
      };
      if (current) setUndoStack((stack) => [...stack.slice(-19), current]);
      setRedoStack([]);
      setScene(next);
      setGraphLevel("relations");
      setDrillTrail(request.trail);
      setTargetDimension(request.targetType);
      setSelectedId(source.id);
      setNodeMenuOpen(false);
      setPathIds([]);
      setCompareIds([]);
      saveHistory(next, request.trail, request.targetType);
    }
  });

  const runDrill = useCallback((source: GraphNodeView, nextTarget = targetDimension, restoredTrail?: DrillStep[]) => {
    const trail = restoredTrail || [...drillTrail, { node: source, targetType: nextTarget }];
    neighborsMutation.mutate({ source, targetType: nextTarget, trail });
  }, [drillTrail, neighborsMutation, targetDimension]);

  const comparedNodes = compareIds
    .map((id) => nodesById.get(id))
    .filter((node): node is GraphNodeView => Boolean(node));
  const pathMutation = useMutation({
    mutationFn: () => fetchKnowledgeGraphPath({
      sourceType: comparedNodes[0].type,
      sourceValue: comparedNodes[0].value,
      targetType: comparedNodes[1].type,
      targetValue: comparedNodes[1].value,
      category,
      minShared,
      yearFrom: yearRange?.[0],
      yearTo: yearRange?.[1]
    }),
    onSuccess: (data) => {
      const incoming = normalizeGraph(data, metadataLanguage);
      const returnedPath = Array.isArray(data.path)
        ? data.path
        : data.found === false ? [] : incoming.nodes.map((node) => node.id);
      if (data.found === false || !returnedPath.length) {
        setPathIds([]);
        setPathStatus("empty");
        return;
      }
      mutateScene((current) => {
        const nodeMap = new Map(current.nodes.map((node) => [node.id, node]));
        incoming.nodes.forEach((node) => nodeMap.set(node.id, node));
        const edgeMap = new Map(current.edges.map((edge) => [edge.id, edge]));
        incoming.edges.forEach((edge) => edgeMap.set(edge.id, edge));
        const nextNodes = [...nodeMap.values()];
        const nextEdges = [...edgeMap.values()];
        return {
          ...current,
          nodes: nextNodes,
          edges: nextEdges,
          positions: layoutGraph(nextNodes, nextEdges, graphWidth, current.positions, current.pinned)
        };
      });
      setPathIds(returnedPath);
      setPathStatus("found");
    }
  });

  const yearBuckets = useLocalizedMemo<KnowledgeGraphYearBucket[]>(() => {
    const supplied = graphQuery.data?.yearDistribution || [];
    if (supplied.length) return supplied;
    const counts = new Map<number, number>();
    baseGraph.nodes.forEach((node) => {
      const year = Number(node.latestReleaseDate?.slice(0, 4));
      if (year > 1900) counts.set(year, (counts.get(year) || 0) + node.mediaCount);
    });
    return [...counts].map(([year, count]) => ({ year, count })).sort((left, right) => left.year - right.year);
  }, [baseGraph.nodes, graphQuery.data?.yearDistribution]);
  const yearBounds = useLocalizedMemo<[number, number] | null>(() => yearBuckets.length
    ? [yearBuckets[0].year, yearBuckets[yearBuckets.length - 1].year]
    : null, [yearBuckets]);

  useEffect(() => {
    if (yearBounds && !yearRange) {
      setYearRange(yearBounds);
      setYearDraft(yearBounds);
    }
  }, [yearBounds, yearRange]);

  useEffect(() => {
    if (yearRange) setYearDraft(yearRange);
  }, [yearRange]);

  useEffect(() => {
    setPathStatus("idle");
    setPathIds([]);
  }, [compareIds]);

  const maxStrength = Math.max(1, ...edges.map((edge) => edge.strength));
  const maxMedia = Math.max(1, ...nodes.map((node) => node.mediaCount));
  const focusedIds = useLocalizedMemo(() => {
    const result = new Set<string>(pathIds);
    if (selectedId) result.add(selectedId);
    edges.forEach((edge) => {
      if (edge.source === selectedId) result.add(edge.target);
      if (edge.target === selectedId) result.add(edge.source);
    });
    return result;
  }, [edges, pathIds, selectedId]);

  const enterDimension = useCallback((type: GraphDimension) => {
    setGraphLevel("entities");
    setActiveDimension(type);
    setTargetDimension(defaultTargetDimension(type));
    setDrillTrail([]);
    setSearch("");
    setScene(null);
    setSelectedId(null);
    setNodeMenuOpen(false);
    setSelectedConnectionId(null);
    setCompareIds([]);
    setPathIds([]);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const showOverview = useCallback(() => {
    setGraphLevel("dimensions");
    setActiveDimension(null);
    setDrillTrail([]);
    setScene(null);
    setSelectedId(null);
    setNodeMenuOpen(false);
    setSelectedConnectionId(null);
    setCompareIds([]);
    setPathIds([]);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const undo = () => {
    const previous = undoStack.at(-1);
    if (!previous || !scene) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, scene]);
    setScene(previous);
    setSelectedId(previous.breadcrumbs.at(-1) || previous.nodes[0]?.id || null);
    setPathIds([]);
  };
  const redo = () => {
    const next = redoStack.at(-1);
    if (!next || !scene) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, scene]);
    setScene(next);
    setSelectedId(next.breadcrumbs.at(-1) || next.nodes[0]?.id || null);
    setPathIds([]);
  };
  const reset = () => {
    if (graphLevel === "relations" && drillTrail.length) {
      const last = drillTrail.at(-1)!;
      runDrill(last.node, last.targetType, drillTrail);
      return;
    }
    if (!scene || !baseGraph.nodes.length) return;
    mutateScene(() => ({
      nodes: baseGraph.nodes,
      edges: [],
      positions: layoutEntityLayer(baseGraph.nodes, graphWidth),
      pinned: scene.pinned.filter((id) => baseGraph.nodes.some((node) => node.id === id)),
      breadcrumbs: [],
      addedBy: {}
    }));
    setPathIds([]);
  };
  const togglePin = () => selectedNode && mutateScene((current) => ({
    ...current,
    pinned: current.pinned.includes(selectedNode.id)
      ? current.pinned.filter((id) => id !== selectedNode.id)
      : [...current.pinned, selectedNode.id]
  }));
  const toggleFavorite = () => {
    if (!selectedNode) return;
    const nextFavorite = !selectedNode.isFavorite;
    onToggleFavorite?.({
      type: selectedNode.type,
      value: selectedNode.value,
      label: selectedNode.label
    }, nextFavorite);
    setScene((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === selectedNode.id
        ? { ...node, isFavorite: nextFavorite }
        : node)
    } : current);
  };
  const collapse = () => selectedNode && mutateScene((current) => {
    const remove = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, parent] of Object.entries(current.addedBy)) {
        if ((parent === selectedNode.id || remove.has(parent)) && !remove.has(id)) {
          remove.add(id);
          changed = true;
        }
      }
    }
    return {
      ...current,
      nodes: current.nodes.filter((node) => !remove.has(node.id)),
      edges: current.edges.filter((edge) => !remove.has(edge.source) && !remove.has(edge.target)),
      pinned: current.pinned.filter((id) => !remove.has(id)),
      breadcrumbs: current.breadcrumbs.filter((id) => id !== selectedNode.id && !remove.has(id)),
      addedBy: Object.fromEntries(Object.entries(current.addedBy).filter(([id]) => !remove.has(id))),
      positions: Object.fromEntries(Object.entries(current.positions).filter(([id]) => !remove.has(id)))
    };
  });

  const comparison = useLocalizedMemo(() => {
    if (comparedNodes.length !== 2) return null;
    const neighbors = (id: string) => new Set(edges
      .filter((edge) => edge.source === id || edge.target === id)
      .map((edge) => edge.source === id ? edge.target : edge.source));
    const first = neighbors(comparedNodes[0].id);
    const second = neighbors(comparedNodes[1].id);
    return {
      first,
      second,
      common: [...first].filter((id) => second.has(id)),
      onlyFirst: [...first].filter((id) => !second.has(id)),
      onlySecond: [...second].filter((id) => !first.has(id))
    };
  }, [comparedNodes, edges]);

  const overviewByType = useLocalizedMemo(() => new Map(
    (overviewQuery.data?.dimensions || []).map((item) => [item.type, item])
  ), [overviewQuery.data?.dimensions]);
  const overviewEntityCount = useLocalizedMemo(() => DIMENSIONS.reduce(
    (total, dimension) => total + (overviewByType.get(dimension.type)?.entityCount || 0), 0
  ), [overviewByType]);
  const activeDimensionMeta = activeDimension ? DIMENSION_BY_TYPE.get(activeDimension) : null;
  const targetDimensionMeta = DIMENSION_BY_TYPE.get(targetDimension)!;
  const selectedPoint = selectedNode ? scene?.positions[selectedNode.id] : null;
  const selectedDimension = selectedNode ? DIMENSION_BY_TYPE.get(selectedNode.type) : null;
  const selectedRelationSource = relationSourceId ? nodesById.get(relationSourceId) || null : null;
  const selectedSharedCount = selectedConnection?.edge.sharedCount ?? 0;

  const revealEvidence = () => {
    setNodeMenuOpen(false);
    if (!selectedConnection && selectedNode) {
      onOpenEntity({ type: selectedNode.type, value: selectedNode.value, label: selectedNode.label });
      return;
    }
    window.requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const restoreHistory = (item: StoredExploration) => {
    if (scene) setUndoStack((stack) => [...stack, scene]);
    const inferredLevel = item.level || (item.scene.edges.length ? "relations" : "entities");
    const inferredDimension = item.activeDimension || item.scene.nodes[0]?.type || null;
    setGraphLevel(inferredLevel);
    setActiveDimension(inferredDimension);
    setTargetDimension(item.targetDimension || defaultTargetDimension(inferredDimension || "actor"));
    setDrillTrail(item.trail || []);
    setScene(item.scene);
    setSelectedId(item.scene.breadcrumbs.at(-1) || item.scene.nodes[0]?.id || null);
    setNodeMenuOpen(false);
    setRedoStack([]);
  };

  const summary = graphLevel === "dimensions"
    ? { first: DIMENSIONS.length, firstLabel: "维度", second: overviewEntityCount, secondLabel: "子分类" }
    : { first: nodes.length, firstLabel: "节点", second: edges.length, secondLabel: "关系" };

  return <section aria-label="内容知识图谱" className="knowledge-graph">
    <header className="knowledge-graph-heading">
      <div>
        {onBack ? <Tooltip title="返回专题">
          <Button aria-label="返回专题" className="knowledge-graph-back" icon={<ArrowLeft size={16} />} onClick={onBack} type="text" />
        </Tooltip> : null}
        <Text className="knowledge-graph-kicker" type="secondary">分层探索</Text>
        <Title level={2}>内容知识图谱</Title>
      </div>
      <div className="knowledge-graph-summary" aria-live="polite">
        <span><strong>{summary.first.toLocaleString(getIntlLocale())}</strong>{summary.firstLabel}</span>
        <span><strong>{summary.second.toLocaleString(getIntlLocale())}</strong>{summary.secondLabel}</span>
      </div>
    </header>

    <nav aria-label="知识图谱层级" className="knowledge-graph-layer-trail">
      <span><Network size={14} />探索层级</span>
      <button className={graphLevel === "dimensions" ? "is-current" : undefined} onClick={showOverview} type="button">
        <small>第 1 层</small>专题总览
      </button>
      {activeDimensionMeta ? <>
        <ChevronRight size={13} />
        <button className={graphLevel === "entities" ? "is-current" : undefined} onClick={() => enterDimension(activeDimensionMeta.type)} type="button">
          <small>第 2 层</small>{activeDimensionMeta.label}
        </button>
      </> : null}
      {drillTrail.map((step, index) => <span className="knowledge-graph-layer-step" key={`${step.node.id}:${index}`}>
        <ChevronRight size={13} />
        <button
          className={index === drillTrail.length - 1 ? "is-current" : undefined}
          onClick={() => runDrill(step.node, step.targetType, drillTrail.slice(0, index + 1))}
          type="button"
        >
          <small>第 {index + 3} 层</small>{step.node.label}<i>{DIMENSION_BY_TYPE.get(step.targetType)?.label}</i>
        </button>
      </span>)}
    </nav>

    {graphLevel === "dimensions" ? <>
      <section className="knowledge-graph-root motion-tab-panel" aria-label="专题维度总览">
        <div className="knowledge-graph-root-node"><Network size={22} /><div><strong>{t("专题")}</strong><span>选择一个维度开始逐层探索</span></div></div>
        <div className="knowledge-graph-root-line" />
        {overviewQuery.isLoading ? <div className="knowledge-graph-overview-loading"><Skeleton active paragraph={{ rows: 4 }} /></div>
          : overviewQuery.isError ? <Alert action={<Button onClick={() => void overviewQuery.refetch()} size="small">{t("重试")}</Button>} description="暂时无法读取专题维度" showIcon title="维度加载失败" type="error" />
            : <div className="knowledge-graph-dimension-grid">
              {DIMENSIONS.map((dimension, index) => {
                const Icon = dimension.icon;
                const overview = overviewByType.get(dimension.type);
                return <button className="motion-list-item" key={dimension.type} onClick={() => enterDimension(dimension.type)} style={{ "--dimension-color": dimension.color, animationDelay: `${Math.min(index, 5) * 24}ms` } as React.CSSProperties} type="button">
                  <span className="knowledge-graph-dimension-icon"><Icon size={19} /></span>
                  <span className="knowledge-graph-dimension-copy"><strong>{dimension.label}</strong><small>{dimension.description}</small></span>
                  <span className="knowledge-graph-dimension-count"><strong>{(overview?.entityCount || 0).toLocaleString(getIntlLocale())}</strong><small>子分类</small></span>
                  <span className="knowledge-graph-dimension-highlights">
                    {(overview?.highlights || []).slice(0, 3).map((item) => <i key={item.value}>{item.label}</i>)}
                  </span>
                  <ChevronRight className="knowledge-graph-dimension-arrow" size={17} />
                </button>;
              })}
            </div>}
      </section>
    </> : <>
      <div className="knowledge-graph-toolbar">
        {graphLevel === "entities" ? <Input
          allowClear
          aria-label="搜索当前维度节点"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("搜索{{p0}}", { p0: activeDimensionMeta?.label || "当前维度" })}
          prefix={<Search size={15} />}
          value={search}
        /> : <div className="knowledge-graph-context">
          <GitBranch size={15} />
          <span><strong>{drillTrail.at(-1)?.node.label}</strong> 的 {targetDimensionMeta.label} 关系层</span>
        </div>}
        <div className="knowledge-graph-limit"><Text type="secondary">节点上限</Text><Slider aria-label="节点数量限制" marks={NODE_LIMIT_MARKS} max={100} min={20} onChange={setNodeLimit} step={20} value={nodeLimit} /></div>
        <Tooltip title="刷新当前层">
          <Button
            aria-label="刷新当前知识图谱层"
            icon={<RefreshCw size={15} />}
            loading={graphLevel === "relations" ? neighborsMutation.isPending : graphQuery.isFetching}
            onClick={() => {
              if (graphLevel === "relations" && drillTrail.length) {
                const last = drillTrail.at(-1)!;
                runDrill(last.node, last.targetType, drillTrail);
              } else {
                void graphQuery.refetch();
              }
            }}
          />
        </Tooltip>
      </div>
      <div className="knowledge-graph-filters" aria-label="图谱关系筛选">
        <Segmented aria-label="图谱媒体分类" onChange={(value) => setCategory(value as typeof category)} options={[{ label: t("全部"), value: "ALL" }, { label: "JAV", value: "JAV" }, { label: "FC2", value: "FC2" }]} size="small" value={category} />
        <label className="knowledge-graph-generic-toggle"><Switch checked={hideGeneric} onChange={setHideGeneric} size="small" /><span>隐藏通用标签</span></label>
        <div className="knowledge-graph-min-shared"><Text type="secondary">至少共同 {minShared} {t("部")}</Text><Slider aria-label="最低共同作品数" max={12} min={1} onChange={setMinShared} value={minShared} /></div>
        {yearBounds && yearDraft ? <div className="knowledge-graph-years">
          <span><CalendarRange size={14} />发行年份 {yearDraft[0]}-{yearDraft[1]}</span>
          <Slider aria-label="发行年份范围" max={yearBounds[1]} min={yearBounds[0]} onChange={(value) => setYearDraft(value as [number, number])} onChangeComplete={(value) => setYearRange(value as [number, number])} range value={yearDraft} />
          <div aria-label="年份作品分布" className="knowledge-graph-year-bars">
            {yearBuckets.map((bucket) => <i key={bucket.year} style={{ height: `${Math.max(2, bucket.count / Math.max(...yearBuckets.map((item) => item.count)) * 16)}px` }} title={`${bucket.year}: ${bucket.count}`} />)}
          </div>
        </div> : null}
      </div>

      {graphLevel === "entities" && graphQuery.isLoading ? <div className="knowledge-graph-loading" aria-label="知识图谱加载中"><Skeleton active paragraph={{ rows: 8 }} /></div>
        : graphLevel === "entities" && graphQuery.isError ? <Alert action={<Button onClick={() => void graphQuery.refetch()} size="small">{t("重试")}</Button>} className="knowledge-graph-state" description={graphQuery.error instanceof Error ? graphQuery.error.message : "暂时无法读取图谱数据"} showIcon title="知识图谱加载失败" type="error" />
          : !nodes.length ? <Empty className="knowledge-graph-state" description="当前筛选暂无可用节点" />
            : <>
              <div className="knowledge-graph-layer-guide">
                {graphLevel === "entities" ? <><span>当前层</span><strong>{activeDimensionMeta?.label}子分类</strong><small>选择任一节点，再指定下一层关系维度</small></>
                  : <><span>当前路径</span><strong>{drillTrail.at(-1)?.node.label}</strong><ChevronRight size={13} /><strong style={{ color: targetDimensionMeta.color }}>{targetDimensionMeta.label}</strong><small>点击右侧节点可继续向下探索</small></>}
              </div>
              <div className="knowledge-graph-actions" role="toolbar" aria-label="图谱操作">
                <Tooltip title="撤销"><Button aria-label="撤销" disabled={!undoStack.length} icon={<Undo2 size={15} />} onClick={undo} /></Tooltip>
                <Tooltip title="重做"><Button aria-label="重做" disabled={!redoStack.length} icon={<Redo2 size={15} />} onClick={redo} /></Tooltip>
                <Tooltip title={graphLevel === "relations" ? "自由整理当前关系" : "重新排列当前层"}>
                  <Button aria-label="重新布局" icon={<Focus size={15} />} onClick={() => mutateScene((current) => ({
                    ...current,
                    positions: graphLevel === "relations" && relationSourceId
                      ? layoutRelationLayer(current.nodes, graphWidth, relationSourceId)
                      : layoutEntityLayer(current.nodes, graphWidth)
                  }))} />
                </Tooltip>
                <Tooltip title="重置当前层"><Button aria-label="重置当前层" icon={<RotateCcw size={15} />} onClick={reset} /></Tooltip>
                <Select
                  aria-label="恢复最近探索"
                  className="knowledge-graph-history-select"
                  placeholder={<span><History size={14} />最近探索</span>}
                  onChange={(id) => {
                    const item = history.find((entry) => entry.id === id);
                    if (item) restoreHistory(item);
                  }}
                  options={history.map((item) => ({ value: item.id, label: `${item.title} · ${new Date(item.savedAt).toLocaleDateString(getIntlLocale())}` }))}
                />
              </div>
              <div className="knowledge-graph-workspace motion-tab-panel">
                <div className="knowledge-graph-canvas-shell">
                  <div className="knowledge-graph-canvas-tools">
                    <Text type="secondary">{graphLevel === "relations" ? "点击节点，在图上继续探索" : "节点大小代表关联作品规模"}</Text>
                  </div>
                  {graphLevel === "relations" ? <div className="knowledge-graph-canvas-layers" aria-hidden="true">
                    <span>当前节点</span><ChevronRight size={13} /><span style={{ color: targetDimensionMeta.color }}>{targetDimensionMeta.label}层</span>
                  </div> : null}
                  <svg aria-label={`知识图谱，${nodes.length} 个节点，${edges.length} 条关系`} className="knowledge-graph-canvas" onClick={() => setNodeMenuOpen(false)} ref={graphRef} role="img" tabIndex={-1} viewBox={`0 0 ${graphWidth} ${GRAPH_HEIGHT}`}>
                    <g className="knowledge-graph-edges">
                      {edges.map((edge) => {
                        const source = scene?.positions[edge.source];
                        const target = scene?.positions[edge.target];
                        if (!source || !target) return null;
                        const active = edge.source === selectedId || edge.target === selectedId;
                        return <g key={edge.id}>
                          <path aria-label={`${edge.relationLabel}，${edge.sharedCount} 部`} className={`${active ? "is-active" : ""}${selectedConnectionId === edge.id ? " is-selected" : ""}${pathEdgeSet.has(edge.id) ? " is-path" : ""}`} d={curvedEdgePath(source, target, edge.id)} fill="none" onClick={(event) => { event.stopPropagation(); if (active) setSelectedConnectionId(edge.id); }} strokeWidth={0.8 + edge.strength / maxStrength * 3.2} />
                          <text className={`knowledge-graph-edge-label${selectedConnectionId === edge.id || pathEdgeSet.has(edge.id) ? " is-visible" : ""}`} x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 4}>{edge.relationLabel}</text>
                        </g>;
                      })}
                    </g>
                    <g className="knowledge-graph-nodes">
                      {nodes.map((node, index) => {
                        const point = scene?.positions[node.id];
                        if (!point) return null;
                        const dimension = DIMENSION_BY_TYPE.get(node.type)!;
                        const selected = node.id === selectedId;
                        const compared = compareIds.includes(node.id);
                        const focused = focusedIds.has(node.id);
                        const sourceNode = graphLevel === "relations" && node.id === relationSourceId;
                        const radius = 10 + Math.sqrt(node.mediaCount / maxMedia) * 12 + (sourceNode ? 5 : 0);
                        const showCover = Boolean(node.mediaId && (graphLevel === "relations" || node.type === "actor" || node.type === "series"));
                        const pinned = scene?.pinned.includes(node.id);
                        const clipId = `knowledge-node-cover-${index}`;
                        return <g
                          aria-label={`${dimension.label}：${node.label}，${node.mediaCount} 部作品${pinned ? "，已固定" : ""}`}
                          className={`knowledge-graph-node${selected ? " is-selected" : ""}${graphLevel === "relations" && selectedId && !focused && !pathNodeSet.has(node.id) ? " is-dimmed" : ""}${compared ? " is-compared" : ""}${pathNodeSet.has(node.id) ? " is-path" : ""}${sourceNode ? " is-drill-root" : ""}${showCover ? " has-cover" : ""}`}
                          key={node.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(node.id);
                            setNodeMenuOpen(true);
                            if (event.shiftKey) setCompareIds((ids) => ids.includes(node.id) ? ids.filter((id) => id !== node.id) : [...ids.slice(-1), node.id]);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedId(node.id);
                              setNodeMenuOpen(true);
                            }
                            if (event.key === "Escape") {
                              setNodeMenuOpen(false);
                            }
                          }}
                          role="button"
                          aria-haspopup="dialog"
                          tabIndex={0}
                          transform={`translate(${point.x} ${point.y})`}
                        >
                          <title>{`${dimension.label}：${node.label} · ${node.mediaCount} 部；点击打开节点操作`}</title>
                          {node.type === "series" ? <>
                            <clipPath id={clipId}><rect height={radius * 1.7} rx={5} width={radius * 2.5} x={-radius * 1.25} y={-radius * 0.85} /></clipPath>
                            <rect className="knowledge-graph-node-shape" fill={dimension.color} height={radius * 1.7} rx={5} width={radius * 2.5} x={-radius * 1.25} y={-radius * 0.85} />
                          </> : <>
                            <clipPath id={clipId}><circle r={radius} /></clipPath>
                            <circle className="knowledge-graph-node-shape" fill={dimension.color} r={radius} />
                          </>}
                          {showCover ? <image clipPath={`url(#${clipId})`} height={radius * 2} href={getPosterUrl(node.mediaId!)} preserveAspectRatio="xMidYMid slice" width={radius * 2.5} x={-radius * 1.25} y={-radius} /> : null}
                          <circle className="knowledge-graph-node-ring" r={radius + 6} />
                          {pinned ? <Lock className="knowledge-graph-pin-mark" size={13} x={radius * 0.55} y={-radius * 0.95} /> : null}
                          <text dy={radius + 17}>{graphLabel(node.label)}</text>
                        </g>;
                      })}
                    </g>
                  </svg>

                  {nodeMenuOpen && selectedNode && selectedPoint ? <section
                    aria-label={`${selectedNode.label} 节点操作`}
                    className={`knowledge-graph-node-popover${selectedPoint.x > graphWidth * 0.68 ? " is-left" : ""}`}
                    role="dialog"
                    style={{
                      "--popover-left": `${selectedPoint.x / graphWidth * 100}%`,
                      "--popover-top": `${selectedPoint.y / GRAPH_HEIGHT * 100}%`,
                      "--node-color": selectedDimension?.color || "#ff9900"
                    } as React.CSSProperties}
                  >
                    <header>
                      {selectedNode.mediaId ? <PosterImage alt="" src={getPosterUrl(selectedNode.mediaId)} /> : <span className="knowledge-graph-popover-mark" />}
                      <div><small>{selectedDimension?.label} · {selectedNode.mediaCount.toLocaleString(getIntlLocale())} 部作品</small><strong>{selectedNode.label}</strong>{selectedNode.originalLabel ? <i>{selectedNode.originalLabel}</i> : null}</div>
                      <Button aria-label="关闭节点操作" icon={<X size={14} />} onClick={() => setNodeMenuOpen(false)} size="small" type="text" />
                    </header>
                    {graphLevel === "relations" && selectedRelationSource && selectedNode.id !== selectedRelationSource.id ? <div className="knowledge-graph-popover-relation">
                      <span>{selectedRelationSource.label}</span><ChevronRight size={13} /><strong>{selectedNode.label}</strong><small>共同 {selectedSharedCount} {t("部")}</small>
                    </div> : <div className="knowledge-graph-popover-relation"><strong>以此节点继续探索</strong><small>{selectedNode.degree} 条可用关系</small></div>}
                    <div className="knowledge-graph-popover-primary">
                      <Button icon={<GitBranch size={15} />} loading={neighborsMutation.isPending} onClick={() => runDrill(selectedNode)} type="primary">继续探索</Button>
                      <Button icon={<Film size={15} />} onClick={revealEvidence}>{selectedConnection ? "查看关联影片" : "查看节点影片"}</Button>
                    </div>
                    <div className="knowledge-graph-popover-secondary">
                      <button onClick={() => onOpenEntity({ type: selectedNode.type, value: selectedNode.value, label: selectedNode.label })} type="button"><ExternalLink size={14} />打开详情</button>
                      <button aria-pressed={selectedNode.isFavorite} onClick={toggleFavorite} type="button"><Heart fill={selectedNode.isFavorite ? "currentColor" : "none"} size={14} />{selectedNode.isFavorite ? t("已收藏") : t("收藏")}</button>
                      <button aria-pressed={compareIds.includes(selectedNode.id)} onClick={() => setCompareIds((ids) => ids.includes(selectedNode.id) ? ids.filter((id) => id !== selectedNode.id) : [...ids.slice(-1), selectedNode.id])} type="button"><Scale size={14} />{compareIds.includes(selectedNode.id) ? "已对比" : "加入对比"}</button>
                    </div>
                    <div className="knowledge-graph-popover-dimensions" role="group" aria-label="选择下一层关系维度">
                      {DIMENSIONS.map((dimension) => {
                        const Icon = dimension.icon;
                        return <button aria-pressed={targetDimension === dimension.type} className={targetDimension === dimension.type ? "is-selected" : undefined} key={dimension.type} onClick={() => setTargetDimension(dimension.type)} style={{ "--dimension-color": dimension.color } as React.CSSProperties} type="button"><Icon size={13} />{dimension.label}</button>;
                      })}
                    </div>
                    <footer>
                      <button onClick={togglePin} type="button">{scene?.pinned.includes(selectedNode.id) ? <Unlock size={13} /> : <Lock size={13} />}{scene?.pinned.includes(selectedNode.id) ? "取消固定" : "固定节点"}</button>
                      {graphLevel === "relations" && selectedNode.id !== relationSourceId ? <button onClick={collapse} type="button"><X size={13} />收起分支</button> : null}
                    </footer>
                  </section> : null}
                </div>

                <aside aria-label="关系与作品" className="knowledge-graph-inspector" ref={inspectorRef}>
                  {selectedNode ? <>
                    <div className="knowledge-graph-node-heading motion-tab-panel" key={selectedNode.id}>
                      {selectedNode.mediaId ? <PosterImage alt="" className="knowledge-graph-node-cover" src={getPosterUrl(selectedNode.mediaId)} /> : <span className="knowledge-graph-node-mark" style={{ backgroundColor: DIMENSION_BY_TYPE.get(selectedNode.type)?.color }} />}
                      <div>
                        <div className="knowledge-graph-node-tags"><Tag>{DIMENSION_BY_TYPE.get(selectedNode.type)?.label}</Tag>{scene?.pinned.includes(selectedNode.id) ? <Tag color="orange">已固定</Tag> : null}</div>
                        <Title level={3}>{selectedNode.label}</Title>
                        {selectedNode.originalLabel ? <Text type="secondary">{selectedNode.originalLabel}</Text> : null}
                      </div>
                    </div>
                    <div className="knowledge-graph-node-stats"><span><strong>{selectedNode.mediaCount.toLocaleString(getIntlLocale())}</strong>{t("关联作品")}</span><span><strong>{selectedNode.degree.toLocaleString(getIntlLocale())}</strong>关系数</span></div>
                    {comparison ? <section aria-label="实体对比" className="knowledge-graph-comparison">
                      <div className="knowledge-graph-related-heading"><Text strong>实体对比</Text><Text type="secondary">当前关系层</Text></div>
                      <div className="knowledge-graph-comparison-columns">{comparedNodes.map((node, index) => <div key={node.id}><strong>{node.label}</strong><span>{node.mediaCount} 作品</span><span>{index ? comparison.second.size : comparison.first.size} 关系</span></div>)}</div>
                      <p>共同关联 <strong>{comparison.common.length}</strong> · 各自独有 <strong>{comparison.onlyFirst.length}</strong> / <strong>{comparison.onlySecond.length}</strong></p>
                      <div className="knowledge-graph-common-tags">{comparison.common.slice(0, 6).map((id) => <Tag key={id}>{nodesById.get(id)?.label || id}</Tag>)}</div>
                      <Button block icon={<GitBranch size={15} />} loading={pathMutation.isPending} onClick={() => { setPathStatus("idle"); pathMutation.mutate(); }}>查找两个节点的路径</Button>
                      {pathStatus === "empty" ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选条件下没有连接路径" /> : null}
                      {pathMutation.isError ? <Alert showIcon title="路径查询失败，请重试" type="warning" /> : null}
                    </section> : null}
                    {graphLevel === "relations" ? <>
                      <div className="knowledge-graph-related-heading"><Text strong>关联节点</Text><Text type="secondary">点击后可继续下钻</Text></div>
                      {relatedNodes.length ? <div className="knowledge-graph-related-list">{relatedNodes.map(({ edge, node }) => <button className={selectedConnectionId === edge.id ? "is-selected" : undefined} key={edge.id} onClick={() => { setSelectedId(node.id); setSelectedConnectionId(edge.id); setNodeMenuOpen(true); }} type="button"><span className="knowledge-graph-related-mark" style={{ backgroundColor: DIMENSION_BY_TYPE.get(node.type)?.color }} /><span className="knowledge-graph-related-copy"><strong>{node.label}</strong><small>{edge.relationLabel} · 共同 {edge.sharedCount} 部 · {Math.round(edge.affinity * 100)}%</small></span><span className="knowledge-graph-strength">{edge.sharedCount}</span></button>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前条件下暂无关联节点" />}
                      {selectedConnection ? <div className="knowledge-graph-evidence">
                        <div className="knowledge-graph-related-heading"><Text strong>作品</Text><Text type="secondary">{connectionSummary?.total ?? selectedConnection.edge.sharedCount} {t("部")}</Text></div>
                        {connectionQuery.isLoading ? <Skeleton active paragraph={{ rows: 2 }} title={false} />
                          : connectionQuery.isError ? <Alert showIcon title="作品加载失败" type="warning" />
                            : connectionItems.length ? <>
                              <div className="knowledge-graph-evidence-grid">{connectionItems.map((item) => <button aria-label={t("查看 {{p0}}", { p0: item.normalizedCode || item.basename })} key={item.id} onClick={() => onOpenMedia?.(item)} type="button"><PosterImage alt="" loading="lazy" src={getPosterUrl(item.id)} /><span>{item.normalizedCode || item.basename}</span></button>)}</div>
                              {connectionQuery.hasNextPage ? <Button block icon={<ChevronsDown size={15} />} loading={connectionQuery.isFetchingNextPage} onClick={() => void connectionQuery.fetchNextPage()}>加载更多作品</Button> : null}
                            </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可展示的作品" />}
                      </div> : null}
                    </> : <Alert className="knowledge-graph-drill-tip" showIcon title="选择关系维度并下钻，即可查看该节点的子节点与关联作品。" type="info" />}
                  </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择节点查看详情" />}
                </aside>
              </div>
            </>}
    </>}
  </section>;
}
