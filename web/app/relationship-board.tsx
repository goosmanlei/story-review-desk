"use client";
import { useMemo, useState } from "react";
import {
  FreeCanvas,
  canvasTone,
  type CanvasIcon,
  type FreeCanvasNode,
  type FreeCanvasEdge,
} from "./free-canvas";

export type CanvasNode = {
  id: string;
  label: string;
  group: string;
  detail?: string;
  facts?: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  icon?: CanvasIcon;
  tone?: string;
  badge?: FreeCanvasNode["badge"];
  draggable?: boolean;
  anchor?: { x: number; y: number; label?: string };
};
export type CanvasEdge = FreeCanvasEdge;
export type RelationshipCanvasProps = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedId?: string;
  selectedEdgeId?: string;
  onSelect: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  onOpenNode?: (id: string) => void;
  label?: string;
  viewportKey?: string;
  height?: number | string;
  layout?: "columns" | "flow";
  showGroups?: boolean;
  notice?: string;
  defaultAllEdges?: boolean;
  readOnly?: boolean;
  showReadableList?: boolean;
  edgeRouting?: "orthogonal" | "curved";
  preserveGraphOnSelect?: boolean;
  onClearSelection?: () => void;
  background?: import("./free-canvas").CanvasBackground;
};
export function RelationshipBoard({
  nodes,
  edges,
  selectedId,
  selectedEdgeId,
  onSelect,
  onSelectEdge,
  onOpenNode,
  label = "实体关系",
  viewportKey,
  height = 540,
  layout = "columns",
  showGroups = true,
  notice,
  defaultAllEdges = false,
  readOnly = false,
  showReadableList = true,
  edgeRouting = "orthogonal",
  preserveGraphOnSelect = false,
  onClearSelection,
  background,
}: RelationshipCanvasProps) {
  const [allEdges, setAllEdges] = useState(defaultAllEdges);
  const available = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [nodes, edges]);
  const anchor =
    selectedId && nodes.some((n) => n.id === selectedId)
      ? selectedId
      : [...nodes].sort(
          (a, b) =>
            available.filter((e) => e.from === b.id || e.to === b.id).length -
            available.filter((e) => e.from === a.id || e.to === a.id).length,
        )[0]?.id;
  const crowded = available.length > 12;
  const visibleEdges =
    !preserveGraphOnSelect && crowded && !allEdges
      ? available.filter((e) => e.from === anchor || e.to === anchor)
      : available;
  const arranged = useMemo(() => {
    const groups = [...new Set(nodes.map((n) => n.group))],
      labels: Array<{ x: number; y: number; label: string; tone: string }> = [];
    let start = 24;
    const positions = new Map<string, { x: number; y: number }>();
    for (const group of groups) {
      const items = nodes.filter((n) => n.group === group),
        columns =
          layout === "flow" ? 1 : Math.max(1, Math.ceil(items.length / 6)),
        rowStep = Math.max(148, ...items.map((n) => (n.height || 76) + 30));
      labels.push({
        x: start,
        y: 14,
        label: group,
        tone: items[0]?.tone || canvasTone(group),
      });
      items.forEach((node, index) =>
        positions.set(node.id, {
          x: start + (layout === "flow" ? 0 : Math.floor(index / 6)) * 290,
          y: (layout === "flow" ? index : index % 6) * rowStep + 62,
        }),
      );
      start += columns * 290 + 110;
    }
    return {
      nodes: nodes.map(
        (n) =>
          ({
            ...n,
            x: n.x ?? positions.get(n.id)!.x,
            y: n.y ?? positions.get(n.id)!.y,
          }) as FreeCanvasNode,
      ),
      labels,
    };
  }, [nodes, layout]);
  return (
    <FreeCanvas
      key={viewportKey || label}
      nodes={arranged.nodes}
      edges={visibleEdges}
      listEdges={available}
      selectedId={selectedId}
      selectedEdgeId={selectedEdgeId}
      onSelect={onSelect}
      onSelectEdge={onSelectEdge}
      onOpenNode={onOpenNode}
      label={label}
      height={height}
      viewportKey={viewportKey}
      groups={showGroups ? arranged.labels : []}
      readOnly={readOnly}
      showReadableList={showReadableList}
      edgeRouting={edgeRouting}
      preserveGraphOnSelect={preserveGraphOnSelect}
      onClearSelection={onClearSelection}
      background={background}
      notice={
        notice ||
        (!preserveGraphOnSelect && crowded && !allEdges
          ? `连线聚焦「${nodes.find((n) => n.id === anchor)?.label || ""}」；共 ${available.length} 条已登记关系。`
          : "连线来自已登记关系；虚线表示尚未确认。个人布局不改变实体或关系。")
      }
      toolbar={
        crowded && !readOnly && !preserveGraphOnSelect ? (
          <button
            type="button"
            aria-pressed={allEdges}
            onClick={() => setAllEdges((v) => !v)}
          >
            {allEdges ? "聚焦关联" : "全部连线"}
          </button>
        ) : undefined
      }
    />
  );
}
