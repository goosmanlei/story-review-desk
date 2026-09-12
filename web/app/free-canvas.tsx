"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./free-canvas.css";
import { instanceLocalStorage } from "./layout-storage";

export type CanvasIcon =
  | "person"
  | "place"
  | "object"
  | "state"
  | "media"
  | "story"
  | "process"
  | "review"
  | "delivery"
  | "unknown"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "defined"
  | "generate"
  | "approved";
export type FreeCanvasNode = {
  id: string;
  label: string;
  group: string;
  detail?: string;
  facts?: string[];
  x: number;
  y: number;
  width?: number;
  height?: number;
  icon?: CanvasIcon;
  tone?: string;
  badge?: { value: string; label: string; icon: CanvasIcon; tone: string };
  draggable?: boolean;
  anchor?: { x: number; y: number; label?: string };
};
export type FreeCanvasEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  directed?: boolean;
  uncertain?: boolean;
  hideLabel?: boolean;
};
export type CanvasBackground = {
  x: number;
  y: number;
  width: number;
  height: number;
  content: React.ReactNode;
};
type Point = { x: number; y: number };
type Transform = Point & { scale: number };
type GroupLabel = Point & { label: string; tone?: string };
type CanvasRoute = {
  edge: FreeCanvasEdge;
  path: string;
  x: number;
  y: number;
  width: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  curveBounds?: { x: number; y: number; right: number; bottom: number };
};
const personalLayouts = new Map<string, Record<string, Point>>();
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const palette = [
  "#9b493f",
  "#426b78",
  "#846230",
  "#596f51",
  "#796187",
  "#40786e",
];
export function canvasTone(group: string) {
  let code = 0;
  for (const char of group) code = (code * 31 + char.charCodeAt(0)) >>> 0;
  return palette[code % palette.length];
}
export function CanvasSymbol({ kind = "unknown" }: { kind?: CanvasIcon }) {
  const paths: Record<CanvasIcon, string> = {
    person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 21v-3a7 7 0 0 1 14 0v3",
    place:
      "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM9 10a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
    object: "m3 7 9-4 9 4v11l-9 4-9-4ZM3 7l9 4 9-4M12 11v11",
    state: "M5 5h14v14H5ZM8 12h8M12 8v8",
    media: "M3 4h18v16H3ZM10 8l6 4-6 4Z",
    story: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3ZM12 6v16",
    process: "M3 5h6v6H3ZM15 13h6v6h-6ZM9 8h9v5",
    review: "M4 3h16v19H4ZM8 12l3 3 6-7",
    delivery: "M3 8h18v13H3ZM6 8V3h12v5M8 14h8",
    image: "M3 4h18v16H3ZM5 17l5-6 4 4 3-3 3 5M15 8h.01",
    audio: "M9 17V5l11-2v12M9 17a3 3 0 1 1-3-3h3M20 15a3 3 0 1 1-3-3h3",
    video: "M3 5h12v14H3ZM15 10l6-4v12l-6-4",
    text: "M5 3h10l4 4v14H5ZM14 3v5h5M8 12h8M8 16h8",
    defined: "M5 4h14v17H5ZM9 9h6M9 13h6M9 17h3",
    generate: "m13 2-9 12h7l-1 8 10-13h-7Z",
    approved: "M22 12a10 10 0 1 1-4-8M7 11l4 4L21 4",
    unknown: "M5 5a10 10 0 1 0 14 0M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5M12 17v1",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

/** Device-local reading layout only. This component never calls a business API. */
export function FreeCanvas({
  nodes,
  edges,
  listEdges = edges,
  onSelect,
  onSelectEdge,
  onOpenNode,
  selectedId,
  selectedEdgeId,
  label = "实体关系",
  height = 540,
  viewportKey,
  groups = [],
  notice,
  toolbar,
  readOnly = false,
  showReadableList = true,
  edgeRouting = "orthogonal",
  preserveGraphOnSelect = false,
  onClearSelection,
  background,
}: {
  nodes: FreeCanvasNode[];
  edges: FreeCanvasEdge[];
  listEdges?: FreeCanvasEdge[];
  onSelect: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  onOpenNode?: (id: string) => void;
  selectedId?: string;
  selectedEdgeId?: string;
  label?: string;
  height?: number | string;
  viewportKey?: string;
  groups?: GroupLabel[];
  notice?: string;
  toolbar?: React.ReactNode;
  readOnly?: boolean;
  showReadableList?: boolean;
  edgeRouting?: "orthogonal" | "curved";
  preserveGraphOnSelect?: boolean;
  onClearSelection?: () => void;
  background?: CanvasBackground;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    marker = useId().replaceAll(":", "");
  const [size, setSize] = useState({
    width: 900,
    height: typeof height === "number" ? height : 540,
  });
  const storageKey = viewportKey?.startsWith("material-entity:")
    ? "canvas-v1:" + viewportKey
    : null;
  const [saved] = useState(() => {
    try {
      if (!storageKey || typeof window === "undefined") return null;
      const value = JSON.parse(
        instanceLocalStorage.getItem(storageKey) || "null",
      );
      if (!value || !["readable", "all"].includes(value.framing)) return null;
      const camera = value.camera;
      if (
        camera &&
        (![camera.x, camera.y, camera.scale].every(Number.isFinite) ||
          camera.scale < 0.01 ||
          camera.scale > 3)
      )
        return null;
      return {
        personal: Object.fromEntries(
          Object.entries(value.personal || {}).filter(
            ([id, p]) =>
              id.length < 500 &&
              p &&
              typeof p === "object" &&
              Number.isFinite((p as Point).x) &&
              Number.isFinite((p as Point).y),
          ),
        ) as Record<string, Point>,
        camera: camera as Transform | null,
        framing: value.framing as "readable" | "all",
      };
    } catch {
      return null;
    }
  });
  const [personal, setPersonal] = useState<Record<string, Point>>(
    () =>
      saved?.personal ||
      (viewportKey ? personalLayouts.get(viewportKey) || {} : {}),
  );
  const [camera, setCamera] = useState<Transform | null>(saved?.camera || null),
    [moving, setMoving] = useState(false);
  const [framing, setFraming] = useState<"readable" | "all">(
    saved?.framing || "readable",
  );
  useEffect(() => {
    if (!storageKey) return;
    try {
      instanceLocalStorage.setItem(
        storageKey,
        JSON.stringify({ personal, camera, framing }),
      );
    } catch {
      /* Layout storage must never block reading. */
    }
  }, [storageKey, personal, camera, framing]);
  const drag = useRef<{
    pointerId: number;
    client: Point;
    camera: Transform;
    nodeId?: string;
    point?: Point;
    fixed?: boolean;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(0);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0)
        setSize({ width: r.width, height: r.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const placed = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        ...(!readOnly && node.draggable !== false ? personal[node.id] : {}),
        draggable: !readOnly && node.draggable !== false,
        width: node.width || 220,
        height: node.height || 76,
      })),
    [nodes, personal, readOnly],
  );
  const positions = new Map(placed.map((node) => [node.id, node]));
  const selectedEdge = selectedEdgeId
    ? edges.find((edge) => edge.id === selectedEdgeId)
    : undefined;
  const preserveOverview = preserveGraphOnSelect,
    emphasizing =
      preserveOverview &&
      Boolean(selectedEdge || (selectedId && positions.has(selectedId)));
  const relatedEdge = (edge: FreeCanvasEdge) =>
    selectedEdge
      ? edge.id === selectedEdge.id
      : selectedId === edge.from || selectedId === edge.to;
  const highlightedNodes = new Set(
    emphasizing
      ? selectedEdge
        ? [selectedEdge.from, selectedEdge.to]
        : [
            selectedId!,
            ...edges
              .filter(relatedEdge)
              .flatMap((edge) => [edge.from, edge.to]),
          ]
      : [],
  );
  const pairKey = (from: string, to: string) =>
    JSON.stringify([from, to].sort());
  const curvePeers = new Map<string, string[]>();
  if (edgeRouting === "curved")
    for (const edge of edges) {
      const key = pairKey(edge.from, edge.to);
      curvePeers.set(key, [...(curvePeers.get(key) || []), edge.id]);
    }
  for (const peers of curvePeers.values()) peers.sort();
  const routes = edges.flatMap<CanvasRoute>((edge, index) => {
    const from = positions.get(edge.from),
      to = positions.get(edge.to);
    if (!from || !to) return [];
    const ax = from.x + from.width / 2,
      ay = from.y + from.height / 2,
      bx = to.x + to.width / 2,
      by = to.y + to.height / 2;
    const forward = to.x >= from.x + from.width + 16,
      backward = from.x >= to.x + to.width + 16;
    const startX = forward
      ? from.x + from.width
      : backward
        ? from.x
        : from.x + from.width;
    const endX = forward ? to.x : backward ? to.x + to.width : to.x + to.width;
    const lane =
      forward || backward
        ? (startX + endX) / 2
        : Math.max(from.x + from.width, to.x + to.width) + 58 + index * 28;
    if (edgeRouting === "curved") {
      // Stable sibling lanes distinguish parallel and reciprocal registered relations.
      // These are reading curves, not new relationship or geographical facts.
      const peers = curvePeers.get(pairKey(edge.from, edge.to))!,
        rank = peers.indexOf(edge.id);
      const offset =
        peers.length === 1 ? 28 : (rank - (peers.length - 1) / 2) * 64;
      const sx = startX,
        ex = endX,
        sy = from.id === to.id ? ay - 18 : ay,
        ey = from.id === to.id ? by + 18 : by;
      const side =
        forward || backward
          ? null
          : Math.max(from.x + from.width, to.x + to.width) + 96 + rank * 52;
      const c1 = {
        x: side ?? sx + (ex - sx) * 0.4,
        y: side === null ? sy + offset : from.id === to.id ? sy - 72 : sy,
      };
      const c2 = {
        x: side ?? ex - (ex - sx) * 0.4,
        y: side === null ? ey + offset : from.id === to.id ? ey + 72 : ey,
      };
      return [
        {
          edge,
          path: `M ${sx} ${sy} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${ex} ${ey}`,
          x: (sx + 3 * c1.x + 3 * c2.x + ex) / 8,
          y: (sy + 3 * c1.y + 3 * c2.y + ey) / 8,
          width: Math.max(92, Math.min(220, edge.label.length * 14 + 24)),
          ax,
          ay,
          bx,
          by,
          curveBounds: {
            x: Math.min(sx, ex, c1.x, c2.x),
            y: Math.min(sy, ey, c1.y, c2.y),
            right: Math.max(sx, ex, c1.x, c2.x),
            bottom: Math.max(sy, ey, c1.y, c2.y),
          },
        },
      ];
    }
    return [
      {
        edge,
        path: `M ${startX} ${ay} H ${lane} V ${by} H ${endX}`,
        x: lane,
        y: (ay + by) / 2,
        width: Math.max(92, Math.min(220, edge.label.length * 14 + 24)),
        ax,
        ay,
        bx,
        by,
        curveBounds: undefined,
      },
    ];
  });
  // Labels occupy separate rows and never cover another label or a node card.
  const labels: typeof routes = [];
  const narrowLabelFocus =
    !preserveOverview &&
    edgeRouting === "curved" &&
    readOnly &&
    selectedId &&
    size.width < 600
      ? positions.get(selectedId)
      : undefined;
  for (const route of routes.filter((route) => !route.edge.hideLabel)) {
    const next = { ...route };
    if (narrowLabelFocus) {
      const center = narrowLabelFocus.x + narrowLabelFocus.width / 2;
      next.width = Math.min(next.width, size.width - 40);
      next.x = clamp(
        next.x,
        center - size.width / 2 + 20 + next.width / 2,
        center + size.width / 2 - 20 - next.width / 2,
      );
    }
    let tries = 0;
    while (
      tries++ < 80 &&
      (placed.some(
        (n) =>
          Math.abs(next.x - (n.x + n.width / 2)) <
            (next.width + n.width) / 2 + 8 &&
          Math.abs(next.y - (n.y + n.height / 2)) <
            (36 + n.height + (narrowLabelFocus ? 16 : 0)) / 2 + 6,
      ) ||
        labels.some(
          (n) =>
            Math.abs(next.x - n.x) < (next.width + n.width) / 2 + 8 &&
            Math.abs(next.y - n.y) < 42,
        ))
    ) {
      next.y += 44;
    }
    labels.push(next);
  }
  const anchors = placed.flatMap((n) => (n.anchor ? [n.anchor] : []));
  const xs = [
      ...placed.map((n) => n.x),
      ...labels.map((n) => n.x - n.width / 2),
      ...groups.map((n) => n.x),
      ...anchors.map((n) => n.x),
    ],
    ys = [
      ...placed.map((n) => n.y),
      ...labels.map((n) => n.y - 20),
      ...groups.map((n) => n.y),
      ...anchors.map((n) => n.y),
    ];
  const right = [
      ...placed.map((n) => n.x + n.width),
      ...labels.map((n) => n.x + n.width / 2),
      ...groups.map((n) => n.x + 220),
      ...anchors.map((n) => n.x + 100),
    ],
    bottom = [
      ...placed.map((n) => n.y + n.height),
      ...labels.map((n) => n.y + 20),
      ...groups.map((n) => n.y + 30),
      ...anchors.map((n) => n.y + 20),
    ];
  // Include curved handles when fitting, without changing any node or map anchor.
  if (background) {
    xs.push(background.x);
    ys.push(background.y);
    right.push(background.x + background.width);
    bottom.push(background.y + background.height);
  }
  for (const route of routes)
    if ("curveBounds" in route && route.curveBounds) {
      xs.push(route.curveBounds.x);
      ys.push(route.curveBounds.y);
      right.push(route.curveBounds.right);
      bottom.push(route.curveBounds.bottom);
    }
  const bounds = {
    x: Math.min(...(xs.length ? xs : [0])) - 28,
    y: Math.min(...(ys.length ? ys : [0])) - 28,
    right: Math.max(...(right.length ? right : [500])) + 28,
    bottom: Math.max(...(bottom.length ? bottom : [260])) + 28,
  };
  const fitScale = clamp(
    Math.min(
      (size.width - 32) / (bounds.right - bounds.x),
      (size.height - 32) / (bounds.bottom - bounds.y),
    ),
    0.01,
    1,
  );
  const fit = {
    scale: fitScale,
    x: (size.width - (bounds.right + bounds.x) * fitScale) / 2,
    y: 20 - bounds.y * fitScale,
  };
  // A narrow read-only relationship focus starts with the chosen node readable,
  // even when its full direct-neighbor graph needs panning. Editable canvases retain their camera.
  const readingFocus =
    !preserveOverview && readOnly && selectedId && size.width < 600
      ? positions.get(selectedId)
      : undefined;
  const readable = readingFocus
    ? {
        scale: 1,
        x: (size.width - readingFocus.width) / 2 - readingFocus.x,
        y: 32 - readingFocus.y,
      }
    : fitScale >= 0.5
      ? fit
      : { scale: 1, x: 20 - bounds.x, y: 20 - bounds.y };
  const transform = camera || (framing === "all" ? fit : readable);
  const currentTransform = useRef(transform);
  useEffect(() => {
    currentTransform.current = transform;
  }, [transform]);
  function zoom(
    multiplier: number,
    anchor = { x: size.width / 2, y: size.height / 2 },
  ) {
    setCamera((previous) => {
      const current = previous || currentTransform.current,
        scale = clamp(current.scale * multiplier, 0.01, 3);
      return {
        scale,
        x: anchor.x - ((anchor.x - current.x) * scale) / current.scale,
        y: anchor.y - ((anchor.y - current.y) * scale) / current.scale,
      };
    });
  }
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect(),
        anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.shiftKey) {
        setCamera((previous) => {
          const current = previous || currentTransform.current;
          return {
            ...current,
            x: current.x - event.deltaY,
            y: current.y - event.deltaX,
          };
        });
        return;
      }
      const multiplier = Math.exp(-clamp(event.deltaY, -100, 100) * 0.004);
      setCamera((previous) => {
        const current = previous || currentTransform.current,
          scale = clamp(current.scale * multiplier, 0.01, 3);
        return {
          scale,
          x: anchor.x - ((anchor.x - current.x) * scale) / current.scale,
          y: anchor.y - ((anchor.y - current.y) * scale) / current.scale,
        };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  function savePosition(id: string, point: Point) {
    setPersonal((previous) => {
      const next = { ...previous, [id]: point };
      if (viewportKey) {
        personalLayouts.set(viewportKey, next);
        if (personalLayouts.size > 40)
          personalLayouts.delete(personalLayouts.keys().next().value!);
      }
      return next;
    });
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as Element;
    if (target.closest("[data-canvas-edge],[data-canvas-edge-hit]")) return;
    const element = target.closest<HTMLElement>("[data-canvas-node-id]");
    const node =
      event.button === 0 && element
        ? positions.get(element.dataset.canvasNodeId || "")
        : null;
    drag.current = {
      pointerId: event.pointerId,
      client: { x: event.clientX, y: event.clientY },
      camera: transform,
      nodeId: node?.id,
      point: node ? { x: node.x, y: node.y } : undefined,
      fixed: node?.draggable === false,
      moved: false,
    };
    setCamera(transform);
    (node && element ? element : event.currentTarget).setPointerCapture(
      event.pointerId,
    );
    if (!node) {
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
    }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.client.x,
      dy = event.clientY - active.client.y;
    if (!active.moved && Math.hypot(dx, dy) < 4) return;
    active.moved = true;
    if (active.fixed) return;
    setMoving(true);
    if (active.nodeId && active.point)
      savePosition(active.nodeId, {
        x: active.point.x + dx / active.camera.scale,
        y: active.point.y + dy / active.camera.scale,
      });
    else
      setCamera({
        ...active.camera,
        x: active.camera.x + dx,
        y: active.camera.y + dy,
      });
  }
  function endPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (active?.moved) suppressClick.current = performance.now() + 250;
    drag.current = null;
    setMoving(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return (
    <section
      className={`relationship-board free-canvas${readOnly ? " is-readonly" : ""}${edgeRouting === "curved" ? " is-curved" : ""}${emphasizing ? " is-preserved-emphasis" : ""}`}
      aria-label={label}
      data-edge-routing={edgeRouting}
    >
      <header>
        <div>
          <strong>{label}</strong>
          {notice && <p>{notice}</p>}
        </div>
        <div className="free-canvas-tools">
          {toolbar}
          {onClearSelection && (
            <button
              type="button"
              disabled={!selectedId && !selectedEdge}
              onClick={onClearSelection}
            >
              取消高亮
            </button>
          )}
          <button
            type="button"
            aria-label="缩小画板"
            onClick={() => zoom(1 / 1.25)}
          >
            −
          </button>
          <output aria-label="画板缩放比例">
            {Math.round(transform.scale * 100)}%
          </output>
          <button
            type="button"
            aria-label="放大画板"
            onClick={() => zoom(1.25)}
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() => {
              setFraming("all");
              setCamera(null);
            }}
          >
            适配全图
          </button>
          <button
            type="button"
            onClick={() => {
              setFraming("readable");
              setCamera(null);
            }}
          >
            阅读比例
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={() => {
                setPersonal({});
                if (viewportKey) personalLayouts.delete(viewportKey);
                setFraming("readable");
                setCamera(null);
              }}
            >
              重置个人布局
            </button>
          )}
        </div>
      </header>
      <div className="free-canvas-help">
        拖动空白处平移 · 滚轮缩放 ·{" "}
        {readOnly ? "节点位置固定，点击查看关联" : "拖动卡片整理个人布局"}{" "}
        <span>
          方向键平移，＋／− 缩放，Home 适配
          {onOpenNode
            ? " · 单击／Enter高亮关联，双击／Shift+Enter打开详情"
            : ""}
        </span>
      </div>
      <div
        ref={viewport}
        className={`relationship-viewport free-canvas-viewport${moving ? " is-moving" : ""}`}
        style={{ height } as CSSProperties}
        tabIndex={0}
        role="group"
        aria-label={label + "画板"}
        data-canvas-scale={transform.scale.toFixed(4)}
        data-canvas-x={transform.x.toFixed(1)}
        data-canvas-y={transform.y.toFixed(1)}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={() => {
          drag.current = null;
          setMoving(false);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const delta = event.shiftKey ? 100 : 40;
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            setCamera({
              ...transform,
              x:
                transform.x +
                (event.key === "ArrowLeft"
                  ? delta
                  : event.key === "ArrowRight"
                    ? -delta
                    : 0),
              y:
                transform.y +
                (event.key === "ArrowUp"
                  ? delta
                  : event.key === "ArrowDown"
                    ? -delta
                    : 0),
            });
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoom(1.25);
          } else if (event.key === "-") {
            event.preventDefault();
            zoom(1 / 1.25);
          } else if (event.key === "Home") {
            event.preventDefault();
            setFraming("all");
            setCamera(null);
          }
        }}
      >
        <div
          className="free-canvas-world"
          style={{
            transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`,
          }}
        >
          {background && (
            <div
              className="free-canvas-background"
              data-canvas-background
              style={{
                left: background.x,
                top: background.y,
                width: background.width,
                height: background.height,
              }}
            >
              {background.content}
            </div>
          )}
          {groups.map((group, index) => (
            <div
              className="free-canvas-group"
              key={`${group.label}:${index}`}
              style={{
                left: group.x,
                top: group.y,
                color: group.tone || canvasTone(group.label),
              }}
            >
              {group.label}
            </div>
          ))}
          <svg
            className="free-canvas-connectors"
            role={onSelectEdge ? "group" : undefined}
            aria-label={onSelectEdge ? label + "连线" : undefined}
            aria-hidden={onSelectEdge ? undefined : true}
          >
            <defs>
              <marker
                id={marker}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8Z" />
              </marker>
              <marker
                id={marker + "-related"}
                className="free-canvas-related-marker"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8Z" />
              </marker>
            </defs>
            {routes.map(({ edge, path }) => {
              const related = relatedEdge(edge);
              return (
                <path
                  key={edge.id}
                  role={onSelectEdge ? "button" : undefined}
                  tabIndex={onSelectEdge ? 0 : undefined}
                  aria-label={
                    onSelectEdge
                      ? `${positions.get(edge.from)?.label}，${edge.label}，${positions.get(edge.to)?.label}`
                      : undefined
                  }
                  aria-pressed={
                    onSelectEdge ? selectedEdge?.id === edge.id : undefined
                  }
                  data-canvas-edge-hit={onSelectEdge ? edge.id : undefined}
                  onClick={
                    onSelectEdge ? () => onSelectEdge(edge.id) : undefined
                  }
                  onKeyDown={
                    onSelectEdge
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectEdge(edge.id);
                          }
                        }
                      : undefined
                  }
                  style={
                    onSelectEdge
                      ? { pointerEvents: "stroke", cursor: "pointer" }
                      : undefined
                  }
                  data-canvas-edge-path={edge.id}
                  data-canvas-edge-from={edge.from}
                  data-canvas-edge-to={edge.to}
                  data-canvas-related={related ? "true" : "false"}
                  d={path}
                  className={`${edge.uncertain ? "is-uncertain " : ""}${related ? "is-related" : ""}`}
                  markerEnd={
                    edge.directed
                      ? `url(#${marker}${edgeRouting === "curved" && related ? "-related" : ""})`
                      : undefined
                  }
                />
              );
            })}
            {labels.map((label) => {
              const route = routes.find(
                  (item) => item.edge.id === label.edge.id,
                )!,
                related = relatedEdge(label.edge);
              return label.x === route.x && label.y === route.y ? null : (
                <path
                  key={"caption-" + label.edge.id}
                  data-canvas-caption-for={label.edge.id}
                  data-canvas-related={related ? "true" : "false"}
                  d={
                    edgeRouting === "curved"
                      ? `M${route.x} ${route.y} L${label.x} ${label.y}`
                      : `M${route.x} ${route.y} V${label.y}`
                  }
                  className={
                    (edgeRouting === "curved" ? "is-caption" : "is-uncertain") +
                    (edgeRouting === "curved" && related ? " is-related" : "")
                  }
                />
              );
            })}
            {placed
              .filter((n) => n.anchor)
              .map((n) => (
                <g className="free-canvas-anchor" key={n.id}>
                  <path
                    d={`M${n.anchor!.x} ${n.anchor!.y} L${n.x + n.width / 2} ${n.y + n.height}`}
                  />
                  <circle cx={n.anchor!.x} cy={n.anchor!.y} r="5" />
                  <text x={n.anchor!.x + 9} y={n.anchor!.y + 4}>
                    {n.anchor!.label || "基线位置"}
                  </text>
                </g>
              ))}
          </svg>
          {placed.map((node) => (
            <button
              type="button"
              key={node.id}
              className={`board-node free-canvas-node${selectedId === node.id ? " selected" : ""}${emphasizing ? (highlightedNodes.has(node.id) ? " is-related" : " is-muted") : ""}`}
              style={
                {
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  minHeight: node.height,
                  "--node-tone": node.tone || canvasTone(node.group),
                } as CSSProperties
              }
              data-canvas-node-id={node.id}
              data-canvas-node-related={
                preserveOverview
                  ? emphasizing
                    ? highlightedNodes.has(node.id)
                      ? "true"
                      : "false"
                    : "none"
                  : undefined
              }
              data-canvas-node-x={node.x.toFixed(1)}
              data-canvas-node-y={node.y.toFixed(1)}
              aria-label={node.label}
              aria-pressed={selectedId === node.id}
              title={node.label + (node.detail ? " · " + node.detail : "")}
              onClick={(event) => {
                if (
                  (event.detail && performance.now() < suppressClick.current) ||
                  (onOpenNode && event.detail > 1)
                )
                  return;
                onSelect(node.id);
              }}
              onDoubleClick={
                onOpenNode
                  ? () => {
                      if (performance.now() < suppressClick.current) return;
                      onOpenNode(node.id);
                    }
                  : undefined
              }
              aria-keyshortcuts={onOpenNode ? "Enter Shift+Enter" : undefined}
              onKeyDown={(event) => {
                if (onOpenNode && event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(node.id);
                  onOpenNode(node.id);
                  return;
                }
                if (
                  event.altKey &&
                  node.draggable !== false &&
                  ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  savePosition(node.id, {
                    x:
                      node.x +
                      (event.key === "ArrowLeft"
                        ? -20
                        : event.key === "ArrowRight"
                          ? 20
                          : 0),
                    y:
                      node.y +
                      (event.key === "ArrowUp"
                        ? -20
                        : event.key === "ArrowDown"
                          ? 20
                          : 0),
                  });
                }
              }}
            >
              <span className="free-canvas-symbol">
                <CanvasSymbol kind={node.icon} />
              </span>
              <span className="free-canvas-node-copy">
                <small>{node.group}</small>
                <strong>{node.label}</strong>
                {node.detail && <span>{node.detail}</span>}
                {node.facts?.map((fact, index) => (
                  <span key={index} className="free-canvas-business-fact">
                    {fact}
                  </span>
                ))}
                {node.badge && (
                  <span
                    className="free-canvas-node-badge"
                    data-canvas-badge={node.badge.value}
                    style={
                      {
                        "--material-progress-tone": node.badge.tone,
                      } as CSSProperties
                    }
                  >
                    <CanvasSymbol kind={node.badge.icon} />
                    {node.badge.label}
                  </span>
                )}
              </span>
            </button>
          ))}
          {labels.map(({ edge, x, y, width }) => (
            <button
              type="button"
              className={`board-edge-label free-canvas-edge-label${edge.uncertain ? " is-uncertain" : ""}${edgeRouting === "curved" && relatedEdge(edge) ? " is-related" : ""}`}
              key={edge.id}
              data-canvas-edge={edge.id}
              aria-pressed={
                onSelectEdge ? selectedEdge?.id === edge.id : undefined
              }
              style={{ left: x - width / 2, top: y - 17, width }}
              aria-label={`${positions.get(edge.from)?.label}，${edge.label}，${positions.get(edge.to)?.label}`}
              disabled={!onSelectEdge}
              onClick={() => onSelectEdge?.(edge.id)}
              title={edge.label}
            >
              {edge.uncertain && <span aria-hidden="true">┄ </span>}
              {edge.label}
            </button>
          ))}
        </div>
      </div>
      {showReadableList && (
        <details className="board-readable-list">
          <summary>按列表浏览全部实体与关系</summary>
          <div>
            {nodes.map((node) => (
              <button
                type="button"
                key={node.id}
                aria-pressed={selectedId === node.id}
                onClick={() => onSelect(node.id)}
              >
                {node.label}
                <small>{node.group}</small>
              </button>
            ))}
          </div>
          {listEdges.map((edge) => (
            <p key={edge.id}>
              <button type="button" onClick={() => onSelect(edge.from)}>
                {positions.get(edge.from)?.label || edge.from}
              </button>{" "}
              <button
                type="button"
                disabled={!onSelectEdge}
                onClick={() => onSelectEdge?.(edge.id)}
              >
                {edge.label}
              </button>{" "}
              {edge.directed ? "→" : "—"}{" "}
              <button type="button" onClick={() => onSelect(edge.to)}>
                {positions.get(edge.to)?.label || edge.to}
              </button>
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
