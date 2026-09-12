"use client";
import { useEffect, useState } from "react";
export function useSession<T>(
  key: string,
  initial: T,
): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(key);
      setValue(stored ? JSON.parse(stored) : initial);
    } catch {}
  }, [key]);
  return [
    value,
    (next) =>
      setValue((previous) => {
        const result =
          typeof next === "function" ? (next as (p: T) => T)(previous) : next;
        try {
          sessionStorage.setItem(key, JSON.stringify(result));
        } catch {}
        return result;
      }),
  ];
}
export const readingPositions = new Map<string, number>();
export function rememberPosition(key: string, value: number) {
  readingPositions.delete(key);
  readingPositions.set(key, value);
  if (readingPositions.size > 1000)
    readingPositions.delete(readingPositions.keys().next().value!);
}

type SelectionAnchor = { path: number[]; offset: number };
function selectionAnchor(root: Node, node: Node, offset: number): SelectionAnchor {
  const path: number[] = [];
  for (let current = node; current !== root; current = current.parentNode!)
    path.unshift(Array.prototype.indexOf.call(current.parentNode!.childNodes, current));
  return { path, offset };
}
const selections = new Map<
  string,
  { start: number; end: number; text: string; startAnchor: SelectionAnchor; endAnchor: SelectionAnchor }
>();
export function captureSelection(key: string, root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const text = range.toString();
  if (text.length > 64000) return;
  selections.delete(key);
  selections.set(key, {
    start: before.toString().length,
    end: before.toString().length + text.length,
    text,
    startAnchor: selectionAnchor(root, range.startContainer, range.startOffset),
    endAnchor: selectionAnchor(root, range.endContainer, range.endOffset),
  });
  if (selections.size > 1000)
    selections.delete(selections.keys().next().value!);
}
export function restoreSelection(key: string, root: HTMLElement) {
  const saved = selections.get(key);
  if (!saved || root.textContent?.slice(saved.start, saved.end) !== saved.text)
    return;
  const locate = (anchor: SelectionAnchor): Node | undefined =>
    anchor.path.reduce<Node | undefined>((node, index) => node?.childNodes[index], root);
  const startNode = locate(saved.startAnchor), endNode = locate(saved.endAnchor);
  if (startNode && endNode) {
    try {
      const exact = document.createRange();
      exact.setStart(startNode, saved.startAnchor.offset);
      exact.setEnd(endNode, saved.endAnchor.offset);
      if (exact.toString() === saved.text) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(exact);
        return;
      }
    } catch { /* Changed DOM shape: restore validated character offsets below. */ }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    range = document.createRange();
  let offset = 0,
    start = false,
    node;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (!start && offset + length > saved.start) {
      range.setStart(node, saved.start - offset);
      start = true;
    }
    if (start && offset + length >= saved.end) {
      range.setEnd(node, saved.end - offset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    offset += length;
  }
}
