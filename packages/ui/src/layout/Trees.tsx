import { useState } from 'react';
import type { MapSnapshot } from '@ide/protocol';
import { nodeStateClass, type NodeChanges } from '../history/history-state';
import type { Marks } from '../plan/plan-state';
import { buildFileTree, matchesFilter, type FileTreeNode } from './tree-model';

interface TreeProps {
  snapshot: MapSnapshot;
  changes: Map<string, NodeChanges>;
  marks: Marks;
  selected: string | null;
  onSelectComponent: (id: string) => void;
  onSelectFile: (path: string) => void;
}

const stateOf = (changes: Map<string, NodeChanges>, id: string): string => {
  const changed = changes.get(id);
  return changed ? nodeStateClass(changed.states) : '';
};

export function ComponentTree({ snapshot, changes, marks, selected, onSelectComponent, onSelectFile }: TreeProps) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const components = snapshot.components.filter((component) => matchesFilter(component.name, filter) || component.files.some((file) => matchesFilter(file, filter)));
  return (
    <div className="tree-pane">
      <input className="tree-filter" placeholder="Filter…" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter components" />
      <div className="tree" role="tree">
        {components.length === 0 && <div className="tree-empty muted">Nothing matches.</div>}
        {components.map((component) => {
          const expanded = open.has(component.id) || filter.trim() !== '';
          const mark = marks.components.get(component.id);
          return (
            <div key={component.id}>
              <div role="treeitem" aria-expanded={expanded} className={`tree-row ${stateOf(changes, component.id)} ${mark ? 'in-plan' : ''} ${selected === component.id ? 'selected' : ''}`}>
                <button className="tree-caret" onClick={() => toggle(component.id)} aria-label={expanded ? 'Collapse' : 'Expand'}>{expanded ? '▾' : '▸'}</button>
                <button className="tree-label" onClick={() => onSelectComponent(component.id)} title={component.summary}>{component.name}</button>
                {mark && <span className="tag plan">{mark.steps.map((step) => step.n).join(',')}</span>}
                <span className="tree-count">{component.files.length}</span>
              </div>
              {expanded && component.files.filter((file) => matchesFilter(file, filter) || matchesFilter(component.name, filter)).map((file) => (
                <div key={file} role="treeitem" className={`tree-row sub ${stateOf(changes, file)} ${selected === file ? 'selected' : ''}`}>
                  <button className="tree-label mono" onClick={() => onSelectFile(file)} title={file}>{file.slice(file.lastIndexOf('/') + 1)}</button>
                  <FileMark state={stateOf(changes, file)} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileMark({ state }: { state: string }) {
  if (state === '') return null;
  const text = state === 'out-of-plan' ? '!' : state === 'in-progress' ? '●' : 'M';
  return <span className={`tree-mark ${state}`} title={state}>{text}</span>;
}

export function FileTree({ snapshot, changes, selected, onSelectFile }: Omit<TreeProps, 'marks' | 'onSelectComponent'>) {
  const [filter, setFilter] = useState('');
  const tree = buildFileTree(snapshot.files.map((file) => file.path).filter((path) => matchesFilter(path, filter)));
  return (
    <div className="tree-pane">
      <input className="tree-filter" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter files" />
      <div className="tree" role="tree">
        {tree.length === 0 && <div className="tree-empty muted">Nothing matches.</div>}
        {tree.map((node) => <FileNodeRow key={node.path} node={node} depth={0} forceOpen={filter.trim() !== ''} changes={changes} selected={selected} onSelectFile={onSelectFile} />)}
      </div>
    </div>
  );
}

function FileNodeRow({ node, depth, forceOpen, changes, selected, onSelectFile }: { node: FileTreeNode; depth: number; forceOpen: boolean; changes: Map<string, NodeChanges>; selected: string | null; onSelectFile: (path: string) => void }) {
  const [open, setOpen] = useState(depth === 0);
  const expanded = open || forceOpen;
  const style = { paddingLeft: 8 + depth * 14 };
  if (node.file) {
    const state = stateOf(changes, node.path);
    return (
      <div role="treeitem" className={`tree-row ${state} ${selected === node.path ? 'selected' : ''}`} style={style}>
        <button className="tree-label mono" onClick={() => onSelectFile(node.path)} title={node.path}>{node.name}</button>
        <FileMark state={state} />
      </div>
    );
  }
  return (
    <>
      <div role="treeitem" aria-expanded={expanded} className="tree-row" style={style}>
        <button className="tree-caret" onClick={() => setOpen(!open)} aria-label={expanded ? 'Collapse' : 'Expand'}>{expanded ? '▾' : '▸'}</button>
        <button className="tree-label" onClick={() => setOpen(!open)}>{node.name}</button>
      </div>
      {expanded && node.children.map((child) => <FileNodeRow key={child.path} node={child} depth={depth + 1} forceOpen={forceOpen} changes={changes} selected={selected} onSelectFile={onSelectFile} />)}
    </>
  );
}
