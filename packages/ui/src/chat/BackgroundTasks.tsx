import { useState } from 'react';
import type { ClientMessage, TaskView } from '@ide/protocol';
import { Icon } from '../layout/Icon';

export function BackgroundTasks({ tasks, send, canStop }: { tasks: TaskView[]; send: (message: ClientMessage) => boolean; canStop: boolean }) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
  return (
    <div className="bg-tasks">
      <button className="bg-tasks-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="bg-tasks-spin">⟳</span> {tasks.length} running in background
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {open && (
        <ul className="bg-tasks-list">
          {canStop && tasks.length > 1 && (
            <li className="bg-tasks-all">
              <button onClick={() => tasks.forEach((task) => send({ type: 'task.stop', id: task.id }))}>Stop all</button>
            </li>
          )}
          {tasks.map((task) => (
            <li key={task.id}>
              <span className="bg-task-kind">{task.kind}</span>
              <span className="bg-task-desc" title={task.description}>{task.description}</span>
              <span className="bg-task-status muted">{task.status}</span>
              {canStop && (
                <button className="bg-task-stop" onClick={() => send({ type: 'task.stop', id: task.id })} title="Stop this task" aria-label={`Stop ${task.description}`}>
                  <Icon name="stop" size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
