import type { DiffHunk, FileDiff } from '@ide/protocol';

interface Row {
  op: 'context' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

function rowsOf(hunk: DiffHunk): Row[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.op === 'del') return { op: 'del', oldNo: oldNo++, newNo: null, text: line.text };
    if (line.op === 'add') return { op: 'add', oldNo: null, newNo: newNo++, text: line.text };
    return { op: 'context', oldNo: oldNo++, newNo: newNo++, text: line.text };
  });
}

const MARK = { add: '+', del: '−', context: '' } as const;

export function DiffView({ diff }: { diff: FileDiff }) {
  return (
    <div className="diff-view">
      {diff.hunks.map((hunk) => (
        <div key={`${hunk.oldStart}:${hunk.newStart}`} className="diff-hunk">
          <div className="diff-hunk-head">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
          {rowsOf(hunk).map((row, i) => (
            <div key={i} className={`diff-row ${row.op}`}>
              <span className="diff-no">{row.oldNo}</span>
              <span className="diff-no">{row.newNo}</span>
              <span className="diff-mark">{MARK[row.op]}</span>
              <span className="diff-text">{row.text}</span>
            </div>
          ))}
        </div>
      ))}
      {diff.truncated && <div className="diff-hunk-head">… truncated</div>}
    </div>
  );
}
