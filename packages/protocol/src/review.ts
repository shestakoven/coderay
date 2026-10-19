export type ReviewPartStatus = 'created' | 'modified' | 'deleted' | 'untouched' | 'missing';
export type ReviewLinkState = 'existing' | 'new' | 'removed' | 'unplanned' | 'missing' | 'broken';

export interface ReviewPartFile {
  path: string;
  op: '+' | '~' | '-';
  added: number;
  removed: number;
  step: string | null;
  external: boolean;
}

export interface ReviewEvidence { path: string; line: number; text: string }

export interface ReviewPart {
  id: string;
  title: string;
  status: ReviewPartStatus;
  steps: string[];
  // A plan exists and no changed file of the part is listed by a step.
  outside: boolean;
  files: ReviewPartFile[];
  // Imports inside the part that point at a removed file.
  broken: ReviewEvidence[];
}

export interface ReviewLink {
  from: string;
  to: string;
  state: ReviewLinkState;
  // File edges behind the link.
  count: number;
  evidence: ReviewEvidence[];
}

export interface ReviewGraph { parts: ReviewPart[]; links: ReviewLink[]; partial: string | null }

export interface ReviewGraphFile {
  path: string;
  // Content hash; null: the file is new.
  before: string | null;
  // Content hash; null: the file is gone.
  after: string | null;
  step: string | null;
  external: boolean;
  added: number;
  removed: number;
}

export const MAX_REVIEW_GRAPH_FILES = 500;
