const MIN_WORDS = 2;
const MAX_WORDS = 5;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<2–5 word kebab slug>-<identifier lowercased>`, e.g. `fix-login-redirect-eng-4821`. */
export function branchPattern(identifier: string): RegExp {
  return new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+){${MIN_WORDS - 1},${MAX_WORDS - 1}}-${escape(identifier.toLowerCase())}$`);
}

export function isValidBranch(branch: string, identifier: string): boolean {
  return branchPattern(identifier).test(branch);
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

/** Removes every occurrence of the identifier (as `eng 1234` or `eng1234`) from a word list. */
function stripIdentifier(ws: string[], identifier: string): string[] {
  const id = words(identifier);
  const joined = id.join("");
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === joined) continue;
    if (id.length > 1 && id.every((w, j) => ws[i + j] === w)) {
      i += id.length - 1;
      continue;
    }
    out.push(ws[i]);
  }
  return out;
}

const FILLER = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "be"]);

/**
 * Deterministically repairs a proposed branch name so it matches `branchPattern`:
 * kebab-cases it, drops any identifier already in it, keeps 2–5 words (topping up
 * from the ticket title), and appends the lowercased identifier.
 */
export function normalizeBranch(raw: string, identifier: string, title: string): string {
  if (isValidBranch(raw, identifier)) return raw;
  let slug = stripIdentifier(words(raw), identifier);
  if (slug.length < MIN_WORDS) {
    const extra = stripIdentifier(words(title), identifier).filter((w) => !FILLER.has(w) && !slug.includes(w));
    slug = [...slug, ...extra];
  }
  while (slug.length < MIN_WORDS) slug.push(slug.length === 0 ? "ticket" : "work");
  return [...slug.slice(0, MAX_WORDS), identifier.toLowerCase()].join("-");
}
