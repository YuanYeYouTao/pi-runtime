export type ComposeSegment = {
  /** Stable identifier, used in the manifest and later for budgeting rules. */
  kind: "memory" | "short_state" | "summary" | "window" | "current" | string;
  /** Section header, rendered above the body. Omitted for segments that are their own header. */
  title?: string;
  body: string;
  /** Anything worth recording: selected ids, counts, reasons. Never rendered. */
  meta?: Record<string, unknown>;
};

export type ComposeOptions = {
  /** Soft budget, reported in the manifest. P1 does not enforce it yet. */
  budgetChars?: number;
  /** Chars per token for the estimate; Chinese-heavy text sits near 3.5. */
  charsPerToken?: number;
};

export type SegmentReport = {
  kind: string;
  chars: number;
  meta?: Record<string, unknown>;
};

export type ComposeManifest = {
  budgetChars: number;
  usedChars: number;
  estimatedTokens: number;
  charsPerToken: number;
  segments: SegmentReport[];
  /** Segments dropped because they were empty. */
  skipped: string[];
};

/**
 * Assemble the prompt from prepared segments.
 *
 * Deliberately dumb: it joins what it is given and reports what it did. Selection, budgeting
 * and eviction live in the callers (and, from P2 on, in this module) so that "what the model
 * saw" can always be reconstructed from the manifest alone.
 */
export function compose(
  segments: ComposeSegment[],
  options: ComposeOptions = {},
): { prompt: string; manifest: ComposeManifest } {
  const charsPerToken = options.charsPerToken ?? 3.5;
  const rendered: string[] = [];
  const reports: SegmentReport[] = [];
  const skipped: string[] = [];

  for (const segment of segments) {
    const body = (segment.body ?? "").trim();
    if (!body) {
      skipped.push(segment.kind);
      continue;
    }
    const text = segment.title ? `${segment.title}\n${body}` : body;
    rendered.push(text);
    reports.push({ kind: segment.kind, chars: text.length, meta: segment.meta });
  }

  const prompt = rendered.join("\n\n---\n\n");
  const usedChars = prompt.length;

  return {
    prompt,
    manifest: {
      budgetChars: options.budgetChars ?? 0,
      usedChars,
      estimatedTokens: Math.ceil(usedChars / charsPerToken),
      charsPerToken,
      segments: reports,
      skipped,
    },
  };
}
