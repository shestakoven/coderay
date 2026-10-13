import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type Edge, type EdgeProps } from '@xyflow/react';
import type { ReviewLink, ReviewLinkState } from '@ide/protocol';
import { Icon } from '../../layout/Icon';
import { Pop, Tool } from '../../plan-flow/SteerControls';
import type { MapQuestion } from './review-map-questions';

export interface ReviewMapLinkData extends Record<string, unknown> {
  link: ReviewLink;
  index: number;
  label: string;
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
    const name = at.path.slice(at.path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }
  if (link.count === 0) return 'planned';
  return `${link.count} ${link.count === 1 ? 'file' : 'files'}`;
}

const CURVATURE = 0.35;
const offset = (distance: number): number => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance));

// Same control points the canvas draws the curve with, so a label can sit at any point of it.
function control(position: Position, x: number, y: number, x2: number, y2: number): [number, number] {
  if (position === Position.Left) return [x - offset(x - x2), y];
  if (position === Position.Right) return [x + offset(x2 - x), y];
  if (position === Position.Top) return [x, y - offset(y - y2)];
  return [x, y + offset(y2 - y)];
}

// A link that skips a layer passes behind the cards in between; its label waits just after the source instead of the middle.
function labelAt(sx: number, sy: number, tx: number, ty: number, sp: Position, tp: Position, fallback: [number, number]): [number, number] {
  const horizontal = sp === Position.Left || sp === Position.Right;
  const span = horizontal ? Math.abs(tx - sx) : Math.abs(ty - sy);
  if (span < (horizontal ? 440 : 300)) return fallback;
  const [c1x, c1y] = control(sp, sx, sy, tx, ty);
  const [c2x, c2y] = control(tp, tx, ty, sx, sy);
  const wanted = horizontal ? sx + Math.sign(tx - sx) * 84 : sy + Math.sign(ty - sy) * 56;
  let best = fallback;
  let gap = Infinity;
  for (let t = 0.02; t <= 0.5; t += 0.01) {
    const u = 1 - t;
    const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx;
    const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty;
    const distance = Math.abs((horizontal ? x : y) - wanted);
    if (distance < gap) {
      gap = distance;
      best = [x, y];
    }
  }
  return best;
}

const CLASS: Record<ReviewLinkState, string> = {
  existing: 'ed-existing', new: 'ed-new run-done', removed: 'ed-removed', unplanned: 'ed-unplanned', missing: 'ed-missing', broken: 'ed-broken',
};
const FLAGGED: ReadonlySet<ReviewLinkState> = new Set(['unplanned', 'broken', 'missing']);

export function ReviewMapLink({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<ReviewMapLinkEdge>) {
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: CURVATURE });
  const [labelX, labelY] = labelAt(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, [midX, midY]);
  const { link, index, label, title, hot, active, dim, selected, question, editing, onHover, onSelect, onAsk, onSave, onCancel } = data!;
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
            {FLAGGED.has(link.state) && <Icon name="alert" size={10} />}
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
