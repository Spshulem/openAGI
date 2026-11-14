// Word-level similarity between an original text and its edited version:
// 1 - levenshtein(words) / max(len). 1 means untouched, 0 means rewritten.
// Each side is capped at its first maxWords words so the O(n*m) distance
// stays cheap.
export function editSimilarity(a, b, { maxWords = 2000 } = {}) {
  const wa = String(a ?? "").split(/\s+/).filter(Boolean).slice(0, maxWords);
  const wb = String(b ?? "").split(/\s+/).filter(Boolean).slice(0, maxWords);
  const longest = Math.max(wa.length, wb.length);
  if (longest === 0) return 1;
  let prev = new Array(wb.length + 1);
  let cur = new Array(wb.length + 1);
  for (let j = 0; j <= wb.length; j += 1) prev[j] = j;
  for (let i = 1; i <= wa.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= wb.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (wa[i - 1] === wb[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[wb.length] / longest;
}
