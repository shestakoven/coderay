import { codeImagePath, isLocalUrl, linkImagePath, textImagePaths } from './image-paths';

export const MAX_PREVIEWS = 6;
export const PREVIEWS_ELEMENT = 'image-previews';

export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

export interface ChatImagesOptions {
  // Ties a file's preview to the message that names it, so a later message reads the file again.
  scope: string | null;
  previews: boolean;
}

const SKIPPED = new Set(['code', 'html', 'image', 'imageReference', 'definition']);

function setProperties(node: MdNode, properties: Record<string, unknown>): void {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, ...properties } };
}

function localImages(node: MdNode, found: MdNode[]): MdNode[] {
  if (node.type === 'image' && node.url !== undefined && isLocalUrl(node.url)) found.push(node);
  for (const child of node.children ?? []) localImages(child, found);
  return found;
}

function mentionsOf(node: MdNode): string[] {
  if (node.type === 'inlineCode') return [codeImagePath(node.value ?? '')].filter((path) => path !== null);
  if (node.type === 'text') return textImagePaths(node.value ?? '');
  if (node.type === 'link') return [linkImagePath(node.url ?? '')].filter((path) => path !== null);
  return [];
}

interface Anchor {
  node: MdNode;
  parent: MdNode;
  paths: string[];
}

// Image files a message names in prose, inline code or a link get a preview after the paragraph, heading or table naming them.
export function addImagePreviews(tree: MdNode, scope: string | null): void {
  const seen = new Set(localImages(tree, []).map((image) => image.url ?? ''));
  const anchors: Anchor[] = [];
  let count = 0;
  const visit = (node: MdNode, parent: MdNode | null, anchor: Anchor | null): void => {
    if (SKIPPED.has(node.type) || count >= MAX_PREVIEWS) return;
    let here = anchor;
    if (parent && (node.type === 'table' || (anchor === null && (node.type === 'paragraph' || node.type === 'heading')))) {
      here = { node, parent, paths: [] };
      anchors.push(here);
    }
    for (const path of mentionsOf(node)) {
      if (here === null || seen.has(path) || count >= MAX_PREVIEWS) continue;
      seen.add(path);
      here.paths.push(path);
      count += 1;
    }
    if (node.type === 'link') return;
    for (const child of node.children ?? []) visit(child, node, here);
  };
  visit(tree, null, null);
  for (const { node, parent, paths } of anchors) {
    if (paths.length === 0 || !parent.children) continue;
    const previews: MdNode = { type: 'chatImagePreviews', children: [], data: { hName: PREVIEWS_ELEMENT } };
    setProperties(previews, { dataPaths: JSON.stringify(paths), dataScope: scope ?? '' });
    parent.children.splice(parent.children.indexOf(node) + 1, 0, previews);
  }
}

export function remarkChatImages(options: ChatImagesOptions) {
  return (tree: MdNode): void => {
    for (const image of localImages(tree, [])) setProperties(image, { dataScope: options.scope ?? '' });
    if (options.previews) addImagePreviews(tree, options.scope);
  };
}
