import type { ReactNode } from "react";

interface FormattedTextProps {
  text: string;
  compact?: boolean;
}

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|https?:\/\/[^\s]+)/gu).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^https?:\/\//u.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>;
    return part;
  });
}

export function FormattedText({ text, compact = false }: FormattedTextProps) {
  const lines = text.replace(/\r\n?/gu, "\n").trim().split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.trim().startsWith("```")) code.push(lines[index++] ?? "");
      index += 1;
      blocks.push(<pre key={`code:${index}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (/^[-*•]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*•]\s+/u.test(lines[index]?.trim() ?? "")) {
        items.push((lines[index++]?.trim() ?? "").replace(/^[-*•]\s+/u, ""));
      }
      blocks.push(<ul key={`ul:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/u.test(lines[index]?.trim() ?? "")) {
        items.push((lines[index++]?.trim() ?? "").replace(/^\d+[.)]\s+/u, ""));
      }
      blocks.push(<ol key={`ol:${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol>);
      continue;
    }
    if (/^#{1,4}\s+/u.test(line)) {
      blocks.push(<h4 key={`heading:${index}`}>{inline(line.replace(/^#{1,4}\s+/u, ""))}</h4>);
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]?.trim() ?? "";
      if (!next || /^(?:```|[-*•]\s+|\d+[.)]\s+|#{1,4}\s+)/u.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(<p key={`p:${index}`}>{inline(paragraph.join(" "))}</p>);
  }
  return <div className={`formatted-text ${compact ? "formatted-text-compact" : ""}`}>{blocks}</div>;
}
