import DiffMatchPatch from "diff-match-patch";

/** Word-level diff (Folio's ins/del rendering). Returns [op, text] with op -1 delete, 0 equal, 1 insert. */
export function wordDiff(a: string, b: string): [number, string][] {
  const dmp = new DiffMatchPatch();
  const tokens: string[] = [];
  const index = new Map<string, number>();
  const encode = (s: string) =>
    (s.match(/\s+|[^\s]+/g) ?? [])
      .map((tok) => {
        let i = index.get(tok);
        if (i === undefined) {
          i = tokens.length;
          tokens.push(tok);
          index.set(tok, i);
        }
        return String.fromCharCode(i + 32);
      })
      .join("");
  const ea = encode(a);
  const eb = encode(b);
  const diffs = dmp.diff_main(ea, eb, false);
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, chars]) => [op, Array.from(chars).map((c) => tokens[c.charCodeAt(0) - 32]).join("")]);
}
