import contract from "../../../contract.json";

// Word-bounded, case-insensitive prompt denylist — same semantics as the
// Python Denylist in wagmiphotos.common.denylist; terms live in contract.json
// so both sides share one list. Trademark/IP guardrail, not a safety filter.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TERMS: string[] = (contract as any).denylist_terms;
const PATTERN = new RegExp("\\b(" + TERMS.map(escapeRe).join("|") + ")\\b", "i");

export function deniedTerm(prompt: string): string | null {
  const m = PATTERN.exec(prompt ?? "");
  return m ? m[0].toLowerCase() : null;
}
