import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import type { ReviewLink, ReviewLinkState } from '@ide/protocol';
import { Icon } from '../../layout/Icon';
import { Pop, Tool } from '../../plan-flow/SteerControls';
import { CURVATURE, pointAt } from './review-map-labels';
import { importedName } from './review-map-model';
import type { MapQuestion } from './review-map-questions';

export interface ReviewMapLinkData extends Record<string, unknown> {
  link: ReviewLink;
  index: number;
  label: string;
  // Where along the curve the label sits, chosen with the other labels in view; the middle until the layout is known.
  labelT: number | undefined;
  title: string;
  hot: boolean;
  active: boolean;
  dim: boolean;
  selected: boolean;
  question: MapQuestion | undefined;
  editing: boolean;
  onHover: (index: number | null) => void;
  onSelect: () => void;
  onAsk: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export type ReviewMapLinkEdge = Edge<ReviewMapLinkData, 'link'>;

export function linkLabel(link: ReviewLink): string {
  const at = link.evidence[0];
  if (at !== undefined) {
    const name = importedName(at.text);
    if (name !== null) return name;
    const file = at.path.slice(at.path.lastIndexOf('/') + 1);
    const dot = file.lastIndexOf('.');
    return dot > 0 ? file.slice(0, dot) : file;
  }
  if (link.count === 0) return 'planned';
  return `${link.count} ${link.count === 1 ? 'file' : 'files'}`;
}

const CLASS: Record<ReviewLinkState, string> = {
  existing: 'ed-existing', new: 'ed-new run-done', removed: 'ed-removed', unplanned: 'ed-unplanned', missing: 'ed-missing', broken: 'ed-broken',
};
const WARNED: ReadonlySet<ReviewLinkState> = new Set(['unplanned', 'broken', 'missing']);

export function ReviewMapLink({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<ReviewMapLinkEdge>) {
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: CURVATURE });
  const { link, index, label, labelT, title, hot, active, dim, selected, question, editing, onHover, onSelect, onAsk, onSave, onCancel } = data!;
  const [labelX, labelY] = labelT === undefined ? [midX, midY] : pointAt({ sx: sourceX, sy: sourceY, tx: targetX, ty: targetY, sp: sourcePosition, tp: targetPosition }, labelT);
  const cls = ['pf-edge', CLASS[link.state], hot && 'hot', dim && 'dim', selected && 'sel'].filter(Boolean).join(' ');
  const labelled = link.state !== 'existing' || hot || selected || question !== undefined;
  const live = active || editing;
  const asked = question !== undefined && question.sentAt !== null;
  const draft = question !== undefined && !asked ? question.text : '';
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} interactionWidth={22} />
      {labelled && (
        <EdgeLabelRenderer>
          <div
            className={`pf-elabel steer ${CLASS[link.state]}${hot ? ' hot' : ''}${dim ? ' dim' : ''}${selected ? ' sel' : ''}${live ? ' live' : ''} nodrag nopan`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => onHover(index)}
            onMouseLeave={() => onHover(null)}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            data-testid={`review-map-link-${index}`}
          >
            {WARNED.has(link.state) && <Icon name="alert" size={10} />}
            <span className="pf-elabel-text">{label}</span>
            {question !== undefined && !live && <span className="rm-ask-mark"><Icon name={asked ? 'check' : 'help'} size={10} /></span>}
            {live && (
              <span className="pf-etools">
                <Tool tip={question === undefined ? 'Ask about this' : asked ? 'Ask again' : 'Edit the question'} kbd="Q" icon="help" on={question !== undefined} onClick={onAsk} />
              </span>
            )}
            {editing && <Pop below label={`Ask about ${title}`} placeholder="What do you want to know about this link?" initial={draft} action="Save" onSave={onSave} onCancel={onCancel} />}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
