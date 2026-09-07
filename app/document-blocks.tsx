import type { ReactNode } from 'react';

export type DocumentBlock = {
  id: string;
  type: 'divider' | 'heading' | 'quote' | 'list' | 'table' | 'dialogue' | 'titleCard' | 'emphasis' | 'paragraph';
  text?: string;
  level?: number;
  speaker?: string;
  performanceNote?: string | null;
  ordered?: boolean;
  items?: string[];
  headers?: string[];
  rows?: string[][];
  sourceLineStart: number;
  sourceLineEnd: number;
};

export type DocumentTextAnnotation = {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  state?: string;
};

export function annotatedText(
  text: string | undefined,
  blockId: string,
  annotations: DocumentTextAnnotation[],
  selectedAnnotationId?: string | null,
  onAnnotationClick?: (annotationId: string) => void,
): ReactNode {
  const value = text || '';
  const applicable = annotations.filter((item) => (
    item.blockId === blockId
    && Number.isInteger(item.startOffset)
    && Number.isInteger(item.endOffset)
    && item.startOffset >= 0
    && item.endOffset > item.startOffset
    && item.endOffset <= value.length
  ));
  if (!applicable.length) return value;
  const boundaries = [...new Set([0, value.length, ...applicable.flatMap((item) => [item.startOffset, item.endOffset])])]
    .sort((left, right) => left - right);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const content = value.slice(start, end);
    const active = applicable.filter((item) => item.startOffset < end && item.endOffset > start);
    if (!active.length) return <span key={`${blockId}:${start}`}>{content}</span>;
    const selected = active.find((item) => item.id === selectedAnnotationId);
    const primary = selected || active[0];
    const annotationIds = active.map((item) => item.id);
    return <mark
      key={`${blockId}:${start}`}
      className={`script-comment-anchor ${selected ? 'is-selected' : ''}`}
      data-comment-state={primary.state || 'OPEN'}
      data-script-comment-id={primary.id}
      data-script-comment-ids={annotationIds.join(' ')}
      title={active.length > 1 ? `${active.length}条评论` : '查看评论'}
      tabIndex={onAnnotationClick ? 0 : undefined}
      role={onAnnotationClick ? 'button' : undefined}
      aria-pressed={onAnnotationClick ? Boolean(selected) : undefined}
      onClick={onAnnotationClick ? () => onAnnotationClick(primary.id) : undefined}
      onKeyDown={onAnnotationClick ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onAnnotationClick(primary.id);
        }
      } : undefined}
    >{content}</mark>;
  });
}

export function DocumentBlocks({
  blocks,
  anchorPrefix = '',
  highlightedAnchor,
  textAnnotations = [],
  selectedAnnotationId,
  onAnnotationClick,
}: {
  blocks: DocumentBlock[];
  anchorPrefix?: string;
  highlightedAnchor?: string | null;
  textAnnotations?: DocumentTextAnnotation[];
  selectedAnnotationId?: string | null;
  onAnnotationClick?: (annotationId: string) => void;
}) {
  return <div className="reader-blocks">{blocks.map((block) => {
    const anchorId = `${anchorPrefix}${block.id}`;
    const className = `reader-block block-${block.type} ${highlightedAnchor === anchorId || highlightedAnchor === block.id ? 'reader-search-hit' : ''}`;
    if (block.type === 'divider') return <hr id={anchorId} className={className} key={block.id} />;
    if (block.type === 'heading') {
      if ((block.level ?? 3) <= 2) return <h2 id={anchorId} className={className} data-reader-block-id={block.id} key={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</h2>;
      if (block.level === 3) return <h3 id={anchorId} className={className} data-reader-block-id={block.id} key={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</h3>;
      return <h4 id={anchorId} className={className} data-reader-block-id={block.id} key={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</h4>;
    }
    if (block.type === 'quote') return <blockquote id={anchorId} className={className} data-reader-block-id={block.id} key={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</blockquote>;
    if (block.type === 'list') {
      const items = block.items ?? [];
      return block.ordered
        ? <ol id={anchorId} className={className} key={block.id}>{items.map((item, index) => <li key={`${block.id}-${index}`}>{item}</li>)}</ol>
        : <ul id={anchorId} className={className} key={block.id}>{items.map((item, index) => <li key={`${block.id}-${index}`}>{item}</li>)}</ul>;
    }
    if (block.type === 'table') return <div id={anchorId} className={`${className} reader-table-wrap`} key={block.id}><table><thead><tr>{(block.headers ?? []).map((cell, index) => <th key={`${block.id}-h${index}`}>{cell}</th>)}</tr></thead><tbody>{(block.rows ?? []).map((row, rowIndex) => <tr key={`${block.id}-r${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${block.id}-r${rowIndex}c${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>;
    if (block.type === 'dialogue') return <div id={anchorId} className={`${className} script-dialogue`} key={block.id}><b>{block.speaker}{block.performanceNote ? <small>（{block.performanceNote}）</small> : null}</b><p data-reader-block-id={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</p></div>;
    if (block.type === 'titleCard') return <p id={anchorId} className={`${className} script-title-card`} key={block.id}><span>字幕</span><span data-reader-block-id={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</span></p>;
    if (block.type === 'emphasis') return <p id={anchorId} className={className} key={block.id}><strong data-reader-block-id={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</strong></p>;
    return <p id={anchorId} className={className} data-reader-block-id={block.id} key={block.id}>{annotatedText(block.text, block.id, textAnnotations, selectedAnnotationId, onAnnotationClick)}</p>;
  })}</div>;
}
