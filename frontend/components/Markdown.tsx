import { Fragment } from "react";

/// A tiny Markdown renderer for AI text: headings, bold, lists and links to
/// our own pages. Builds React nodes — never raw HTML.

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(\/[^)\s]*\))/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    const link = part.match(/^\[([^\]]+)\]\((\/[^)\s]*)\)$/);
    if (link) return <a key={i} href={link[2]}>{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;
  const flush = () => {
    if (list.length) {
      const items = list.map((l, i) => <li key={i}>{inline(l)}</li>);
      out.push(ordered ? <ol key={`l${out.length}`}>{items}</ol> : <ul key={`l${out.length}`}>{items}</ul>);
    }
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      if (list.length && ordered !== Boolean(num)) flush();
      ordered = Boolean(num);
      list.push((bullet ?? num)![1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    out.push(h ? <h4 key={out.length}>{inline(h[1])}</h4> : <p key={out.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="md">{out}</div>;
}
