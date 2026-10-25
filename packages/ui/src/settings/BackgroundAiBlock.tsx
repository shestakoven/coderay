import { ENGINE_PRODUCT_NAMES, type BackgroundAiChoice, type BackgroundAiView, type EngineId } from '@ide/protocol';
import { useEffect, useState } from 'react';
import { stateLabel, statusLine } from './background-ai';
import { BLOCKS } from './categories';
import { Dot, Segmented, Setting } from './controls';

type Mode = BackgroundAiChoice['mode'];
type Pick = Extract<BackgroundAiChoice, { mode: 'engine' }>;

const MODES: { value: Mode; label: string }[] = [{ value: 'auto', label: 'Auto' }, { value: 'engine', label: 'Choose an engine' }, { value: 'off', label: 'Off' }];

export function BackgroundAiBlock({ view, onSave, onShowFirstRun }: {
  view: BackgroundAiView;
  onSave: (choice: BackgroundAiChoice) => void;
  onShowFirstRun: () => void;
}) {
  const block = BLOCKS.find((candidate) => candidate.id === 'background-ai')!;
  const [draft, setDraft] = useState<BackgroundAiChoice>(view.choice);
  // Back on "Choose an engine" after Auto or Off, the engine and model picked last come back.
  const [pick, setPick] = useState<Pick | null>(view.choice.mode === 'engine' ? view.choice : null);
  // A choice made in another window arrives in a later snapshot.
  const saved = JSON.stringify(view.choice);
  useEffect(() => {
    setDraft(view.choice);
    if (view.choice.mode === 'engine') setPick(view.choice);
  }, [saved]);
  const option = draft.mode === 'engine' ? view.options.find((candidate) => candidate.engine === draft.engine) : undefined;
  const choose = (next: BackgroundAiChoice): void => {
    setDraft(next);
    if (next.mode === 'engine') setPick(next);
    onSave(next);
  };
  const fromMode = (mode: Mode): BackgroundAiChoice => (mode === 'engine' ? pick ?? { mode, engine: firstEngine(view), model: null } : { mode });
  // A saved model the engine no longer lists still shows as itself, not as the first entry.
  const unlisted = draft.mode === 'engine' && draft.model !== null && !option?.models.some((model) => model.value === draft.model) ? draft.model : null;
  const line = statusLine(view.status);
  return (
    <Setting id="background-ai" title={block.title} help={block.help}>
      <div className="bg-ai">
        <Segmented<Mode> label="Background AI" value={draft.mode} onChange={(mode) => mode !== draft.mode && choose(fromMode(mode))} options={MODES} />
        <div className="bg-ai-panel">
          {draft.mode === 'engine' && (
            <div className="bg-ai-pick">
              <label className="sw-field">
                <span className="sw-field-label">Engine</span>
                <select value={draft.engine} onChange={(event) => choose({ mode: 'engine', engine: event.target.value as EngineId, model: null })}>
                  {view.options.map((candidate) => (
                    <option key={candidate.engine} value={candidate.engine}>{ENGINE_PRODUCT_NAMES[candidate.engine]} · {stateLabel(candidate.status)}</option>
                  ))}
                </select>
              </label>
              <label className="sw-field">
                <span className="sw-field-label">Model</span>
                <select value={draft.model ?? ''} disabled={!option || (option.models.length === 0 && unlisted === null)} onChange={(event) => choose({ mode: 'engine', engine: draft.engine, model: event.target.value || null })}>
                  <option value="">Default for this engine</option>
                  {option?.models.map((model) => <option key={model.value} value={model.value}>{model.name}</option>)}
                  {unlisted !== null && <option value={unlisted}>{unlisted}</option>}
                </select>
              </label>
            </div>
          )}
          <div className={`bg-ai-status ${view.status.state}`} role="status" aria-live="polite">
            <Dot tone={line.tone} />
            <div className="bg-ai-status-text">
              {line.text}
              {line.details.map((detail) => <span key={detail} className="bg-ai-note">{detail}</span>)}
            </div>
          </div>
        </div>
        <button type="button" className="sw-link bg-ai-again" onClick={onShowFirstRun}>Show the first-run screen again</button>
      </div>
    </Setting>
  );
}

// The engine Auto runs on now, else the first one the probe calls ready: Auto may have passed over a ready-looking engine that failed.
const firstEngine = (view: BackgroundAiView): EngineId =>
  (view.status.state === 'ready' ? view.status.engine : undefined)
  ?? view.options.find((candidate) => candidate.status?.state === 'ready')?.engine
  ?? view.options[0]?.engine
  ?? 'claude';
