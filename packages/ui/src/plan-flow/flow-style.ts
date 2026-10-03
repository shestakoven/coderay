import type { PlanFlowFileOp, PlanFlowNodeKind, PlanFlowNodeState } from '@ide/protocol';

export const KIND_ICON: Record<PlanFlowNodeKind, string> = {
  actor: '<circle cx="8" cy="5" r="3" fill="currentColor"/><path d="M2 15c0-3.3 2.7-5 6-5s6 1.7 6 5z" fill="currentColor"/>',
  endpoint: '<path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4"/>',
  schema: '<path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3M5.5 8h5M5.5 11h5"/>',
  service: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  module: '<path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v7"/>',
  model: '<rect x="2.5" y="6" width="11" height="7.5" rx="1.5"/><path d="M4 4h8M5.5 2h5"/>',
  store: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  external: '<path d="M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12v2.5"/>',
  test: '<path d="M5 3l8 5-8 5z" fill="currentColor"/>',
};

export const KIND_ACCENT: Record<PlanFlowNodeKind, string> = {
  actor: 'var(--added)', endpoint: 'var(--accent-hover)', schema: '#4fb3bf', service: 'var(--warn)', module: 'var(--muted)',
  model: '#b392f0', store: '#4fb3bf', external: '#e8946a', test: 'var(--muted)',
};

export const KIND_LABEL: Record<PlanFlowNodeKind, string> = {
  actor: 'person', endpoint: 'endpoint', schema: 'schema', service: 'service', module: 'module', model: 'model', store: 'store', external: 'external', test: 'tests',
};

export const STATE_TAG: Record<Exclude<PlanFlowNodeState, 'existing'>, string> = { create: 'NEW', modify: 'MODIFY', delete: 'REMOVE' };

export const OP_CLASS: Record<PlanFlowFileOp, string> = { '+': 'op-add', '~': 'op-mod', '-': 'op-del' };

export const EDGE_COLOR = { existing: '#868a91', new: '#548af7', removed: '#f75464', done: '#73c991' } as const;
