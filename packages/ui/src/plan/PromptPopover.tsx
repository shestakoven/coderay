import { NodeToolbar, Position } from '@xyflow/react';
import { useEffect } from 'react';
import { usePlanOverlay } from './overlay';
import { PromptBody } from './PromptBody';

export function PromptPopover({ nodeId }: { nodeId: string | null }) {
  const { prompt, answerPrompt, onAnchor } = usePlanOverlay();
  const anchored = prompt !== null && nodeId !== null;
  useEffect(() => {
    onAnchor(anchored);
    return () => onAnchor(false);
  }, [anchored, onAnchor]);
  if (!prompt || !nodeId) return null;
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Top} offset={12}>
      <div className="oop-popover" data-testid="gate-popover">
        <PromptBody prompt={prompt} onAnswer={answerPrompt} />
      </div>
    </NodeToolbar>
  );
}
