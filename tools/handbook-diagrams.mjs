// Deliberately small declarative diagram format: no executable markup or browser.
import { createHash } from "node:crypto";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const palette = {
  story: ["#e5edf4", "#365c78"],
  settings: ["#ece8f2", "#655078"],
  materials: ["#e8eee1", "#4c6940"],
  production: ["#f3e8d8", "#886129"],
  collaboration: ["#f2e3e2", "#8c4d4a"],
  project: ["#e6ebe9", "#48645e"],
};
export function diagramDimensions(diagram) {
  return {
    width: (Math.max(...diagram.nodes.map((n) => n.col)) + 1) * 320 + 48,
    height: (Math.max(...diagram.nodes.map((n) => n.row)) + 1) * 160 + 155,
  };
}
export function renderDiagram(diagram) {
  const { id, title, description, nodes, edges = [] } = diagram;
  if (!/^[a-z][a-z0-9-]+$/.test(id) || !nodes.length)
    throw Error("Invalid diagram identity");
  const ids = new Map(nodes.map((n) => [n.id, n]));
  if (ids.size !== nodes.length) throw Error("Duplicate diagram node");
  const cols = Math.max(...nodes.map((n) => n.col)) + 1,
    rows = Math.max(...nodes.map((n) => n.row)) + 1;
  const { width: w, height: h } = diagramDimensions(diagram);
  const pos = (n) => ({ x: 40 + n.col * 320, y: 100 + n.row * 160 });
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#827766"/></marker></defs><rect width="100%" height="100%" fill="#fcfaf5" rx="8"/><g font-family="system-ui,-apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif"><text x="40" y="40" fill="#332f29" font-size="23" font-weight="650">${escape(title)}</text><text x="40" y="68" fill="#726a5f" font-size="13">实线箭头：流向或精确依赖　·　虚线：关联／可选路径</text>`;
  for (const edge of edges) {
    const a = ids.get(edge.from),
      b = ids.get(edge.to);
    if (!a || !b) throw Error("Unknown diagram endpoint");
    const p = pos(a),
      q = pos(b);
    let x1, y1, x2, y2, d, lx, ly;
    if (a.row === b.row && Math.abs(a.col - b.col) > 1) {
      x1 = p.x + 110;
      y1 = p.y + 98;
      x2 = q.x + 55;
      y2 = q.y + 98;
      const lane = y1 + 24;
      d = `M${x1} ${y1} V${lane} H${x2} V${y2}`;
      lx = (x1 + x2) / 2;
      ly = lane - 6;
    } else if (a.row === b.row) {
      const right = b.col > a.col;
      x1 = p.x + (right ? 220 : 0);
      y1 = p.y + 48;
      x2 = q.x + (right ? 0 : 220);
      y2 = q.y + 48;
      d = `M${x1} ${y1} L${x2} ${y2}`;
      lx = (x1 + x2) / 2;
      ly = y1 - 12;
    } else {
      const down = b.row > a.row;
      x1 = p.x + 110;
      y1 = p.y + (down ? 98 : 0);
      x2 = q.x + 110;
      y2 = q.y + (down ? 0 : 98);
      const mid = (y1 + y2) / 2;
      d = `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
      lx = (x1 + x2) / 2 + 8;
      ly = mid - 6;
    }
    svg += `<path d="${d}" fill="none" stroke="#827766" stroke-width="1.6" ${edge.type === "relation" ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#arrow)"/>`;
    if (edge.label)
      svg += `<text x="${lx}" y="${ly}" text-anchor="${a.row === b.row ? "middle" : "start"}" font-size="11" fill="#6b6256" paint-order="stroke" stroke="#fcfaf5" stroke-width="5" stroke-linejoin="round">${escape(edge.label)}</text>`;
  }
  for (const n of nodes) {
    if (
      !Number.isInteger(n.col) ||
      !Number.isInteger(n.row) ||
      n.col < 0 ||
      n.row < 0 ||
      (n.lines || []).length > 3
    )
      throw Error("Invalid diagram layout");
    const p = pos(n),
      [bg, fg] = palette[n.domain || "project"];
    svg += `<g><rect x="${p.x}" y="${p.y}" width="220" height="98" rx="7" fill="${bg}" stroke="${fg}" stroke-opacity=".3"/><rect x="${p.x}" y="${p.y}" width="4" height="98" rx="2" fill="${fg}"/><text x="${p.x + 16}" y="${p.y + 29}" font-size="17" font-weight="650" fill="${fg}">${escape(n.label)}</text>`;
    for (const [i, line] of (n.lines || []).entries())
      svg += `<text x="${p.x + 16}" y="${p.y + 52 + i * 17}" font-size="12" fill="#4f4a42">${escape(line)}</text>`;
    svg += "</g>";
  }
  return (
    svg +
    `<text x="40" y="${h - 22}" font-size="12" fill="#807568">审阅台 · 系统架构手册</text></g></svg>\n`
  );
}
