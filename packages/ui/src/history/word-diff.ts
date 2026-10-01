export interface Segment {
  text: string;
  changed: boolean;
}

const TOKEN = /\s+|\w+|[^\w\s]/g;
const MAX_TOKENS = 300;

// Longest-common-subsequence over word/punctuation/space tokens; lines too long for it fall back to no marking.
export function wordDiff(before: string, after: string): { before: Segment[]; after: Segment[] } | null {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const left: Segment[] = [];
  const right: Segment[] = [];
  const push = (list: Segment[], text: string, changed: boolean): void => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(left, a[i]!, false);
      push(right, b[j]!, false);
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      push(left, a[i]!, true);
      i++;
    } else {
      push(right, b[j]!, true);
      j++;
    }
  }
  return { before: left, after: right };
}
