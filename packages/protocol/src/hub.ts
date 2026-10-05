import type { RecentProject } from './project';

export type HubProjectState = 'starting' | 'running' | 'failed';

export interface HubProject {
  id: string;
  root: string;
  name: string;
  state: HubProjectState;
  // The UI opens its own socket to the project core at this loopback port; both are set once the state is 'running'.
  port: number | null;
  token: string | null;
  error: string | null;
}

export interface HubSnapshot {
  projects: HubProject[];
  activeId: string | null;
  home: string;
  recent: RecentProject[];
}

export type HubClientMessage =
  | { type: 'hub.activate'; id: string }
  | { type: 'hub.order'; ids: string[] }
  | { type: 'hub.close'; requestId: string; id: string }
  | { type: 'hub.restart'; requestId: string; id: string };

export type HubServerMessage =
  | { type: 'hub.snapshot'; hub: HubSnapshot }
  | { type: 'hub.close.result'; requestId: string; error: string | null }
  | { type: 'hub.restart.result'; requestId: string; error: string | null };
