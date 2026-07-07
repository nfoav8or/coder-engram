/**
 * canvas-extractor — text extraction from Obsidian Canvas (.canvas) files.
 *
 * A canvas is JSON (the JSON Canvas format): text cards, group labels, file
 * embeds, and labeled edges. The text people write on cards is real note
 * content, but it is invisible to search because a canvas is not Markdown.
 * This extractor renders the canvas's own text as markdown — cards in reading
 * order (top-to-bottom, then left-to-right), group labels as headings context,
 * edge labels as a connections list. File-embed nodes are listed by path only
 * (their content is indexed from the files themselves).
 *
 * Pure JSON parsing — no dependencies, nothing leaves the machine.
 */

import { TextExtractor, attachmentTitle } from "./text-extractor";

interface CanvasNode {
  id?: string;
  type?: string;
  text?: string;
  label?: string;
  file?: string;
  x?: number;
  y?: number;
}

interface CanvasEdge {
  fromNode?: string;
  toNode?: string;
  label?: string;
}

export class CanvasExtractor implements TextExtractor {
  readonly extensions = [".canvas"];

  async extract(path: string, data: ArrayBuffer): Promise<string | null> {
    let parsed: { nodes?: CanvasNode[]; edges?: CanvasEdge[] };
    try {
      parsed = JSON.parse(new TextDecoder().decode(data)) as typeof parsed;
    } catch {
      return null; // not valid JSON — skip, never throw
    }
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];

    // Reading order: top-to-bottom, then left-to-right.
    const ordered = [...nodes].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

    const cards: string[] = [];
    const groups: string[] = [];
    const embeds: string[] = [];
    for (const n of ordered) {
      if (n.type === "text" && typeof n.text === "string" && n.text.trim()) {
        cards.push(n.text.trim());
      } else if (n.type === "group" && typeof n.label === "string" && n.label.trim()) {
        groups.push(n.label.trim());
      } else if (n.type === "file" && typeof n.file === "string" && n.file.trim()) {
        embeds.push(n.file.trim());
      }
    }

    const labeledEdges = edges
      .map((e) => (typeof e.label === "string" ? e.label.trim() : ""))
      .filter(Boolean);

    if (cards.length === 0 && groups.length === 0 && labeledEdges.length === 0) return null;

    const parts: string[] = [`# ${attachmentTitle(path)}`];
    if (groups.length) parts.push(`Groups: ${groups.join(" · ")}`);
    parts.push(...cards);
    if (labeledEdges.length) parts.push(`Connections: ${labeledEdges.join(" · ")}`);
    if (embeds.length) parts.push(`Embedded files: ${embeds.join(", ")}`);
    return parts.join("\n\n");
  }
}
