"use client";
import { Fragment } from "react";
// Original bytes stay unchanged. Only the reading presentation recognizes common
// Markdown syntax; raw HTML and executable URLs are never injected into the page.
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
        .map((t, i) =>
          t.startsWith("**") ? (
            <strong key={i}>{t.slice(2, -2)}</strong>
          ) : t.startsWith("`") ? (
            <code key={i}>{t.slice(1, -1)}</code>
          ) : (
            <Fragment key={i}>{t}</Fragment>
          ),
        )}
    </>
  );
}
export function SourceText({ text }: { text: string }) {
  return (
    <div className="original-source-text">
      {text.split(/\n\s*\n/).map((block, i) => {
        if (/^\s*---\s*$/.test(block)) return <hr key={i} />;
        if (/^#{1,6} /.test(block)) {
          const title = block.replace(/^#{1,6} /, "");
          return (
            <h3 key={i}>
              <Inline text={title} />
            </h3>
          );
        }
        if (block.startsWith(">"))
          return (
            <blockquote key={i}>
              <Inline text={block.replace(/^> ?/gm, "")} />
            </blockquote>
          );
        return (
          <p key={i}>
            <Inline text={block} />
          </p>
        );
      })}
    </div>
  );
}
