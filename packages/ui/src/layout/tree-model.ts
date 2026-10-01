export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  file: boolean;
}

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [], file: false };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    parts.forEach((part, index) => {
      const file = index === parts.length - 1;
      const childPath = parts.slice(0, index + 1).join('/');
      let child = node.children.find((candidate) => candidate.name === part && candidate.file === file);
      if (!child) {
        child = { name: part, path: childPath, children: [], file };
        node.children.push(child);
      }
      node = child;
    });
  }
  const order = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const node of nodes) order(node.children);
  };
  order(root.children);
  return root.children;
}

export function matchesFilter(text: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === '' || text.toLowerCase().includes(needle);
}
