export type StateDirective = { key: string; value: string; ttl?: string };

/**
 * Extract short-state directives from an assistant reply.
 *
 * A tool call would be cleaner, but it requires an extension round-trip through pi's RPC. A
 * directive is a control token the model can emit with the tools it already has, and it is
 * parsed deterministically on our side — so the write is atomic with the reply and never
 * depends on a second model turn.
 *
 * Syntax: `<!--state: deploy_port=8080; ttl=7d-->` (one per line, several allowed).
 */
const DIRECTIVE = /<!--\s*state:\s*([a-z0-9][a-z0-9_.:-]{0,63})\s*=\s*([^;>]+?)\s*(?:;\s*ttl\s*=\s*([0-9]+\s*[a-z]+)\s*)?-->/gi;

export function extractStateDirectives(text: string): { directives: StateDirective[]; cleaned: string } {
  const directives: StateDirective[] = [];
  const cleaned = (text ?? "").replace(DIRECTIVE, (_match, key: string, value: string, ttl?: string) => {
    const trimmed = String(value).trim();
    if (!trimmed) return _match;
    directives.push({ key: key.toLowerCase(), value: trimmed, ttl: ttl ? ttl.replace(/\s+/g, "") : undefined });
    return "";
  });

  // Collapse the blank line the removed directive leaves behind.
  return { directives, cleaned: cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
}
