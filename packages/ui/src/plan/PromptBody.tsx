import type { GateAnswer, GatePreview, GatePromptView } from '@ide/protocol';
import { agentReason, prefixed, promptHint, promptTarget, targetLabel } from './prompt-text';

export function PromptBody({ prompt, onAnswer }: { prompt: GatePromptView; onAnswer: (answer: GateAnswer) => void }) {
  const target = promptTarget(prompt);
  return (
    <>
      <div className="oop-head">
        <span className="oop-tag">Out of plan</span> {prompt.tool} <code>{targetLabel(target, prompt.summary)}</code>
      </div>
      <div className="oop-reason">
        <span className="muted">Agent: </span>
        {agentReason(prompt)}
      </div>
      <Preview preview={prompt.preview} />
      <div className="muted oop-hint">{promptHint(prompt)}</div>
      <div className="prompt-actions">
        <button onClick={() => onAnswer('deny')}>Deny</button>
        {prompt.canExpand && (
          <button title="Adds the files to the active step as a new version of the plan" onClick={() => onAnswer('expand-plan')}>
            Expand plan
          </button>
        )}
        <button className="primary" onClick={() => onAnswer('allow-once')}>Allow once</button>
      </div>
    </>
  );
}

function Preview({ preview }: { preview: GatePreview }) {
  const more = preview.truncated ? '\n…' : '';
  if (preview.kind === 'edit') {
    return (
      <pre className="oop-diff">
        <span className="del">{prefixed('- ', preview.oldString)}</span>
        {'\n'}
        <span className="add">{prefixed('+ ', preview.newString)}</span>
        {more}
      </pre>
    );
  }
  if (preview.kind === 'write') return <pre className="oop-diff"><span className="add">{prefixed('+ ', preview.content)}</span>{more}</pre>;
  if (preview.kind === 'command') return <pre className="oop-diff">{preview.command}{more}</pre>;
  return <pre className="oop-diff">{preview.text}{more}</pre>;
}
