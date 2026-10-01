export const MAX_LISTED_COMPONENTS = 300;

export function systemPrompt(components: { id: string; name: string }[], mapTools = false, searchTool = false): string {
  const listed = components.slice(0, MAX_LISTED_COMPONENTS).map((component) => `- ${component.id} — ${component.name}`);
  const more = components.length > MAX_LISTED_COMPONENTS
    ? [`- …and ${components.length - MAX_LISTED_COMPONENTS} more; name project paths for those.`]
    : [];
  return [
    'You are working inside the AI-Control IDE. It shows your plan on a map of the project and blocks changes that no approved plan covers.',
    ...(mapTools
      ? ['', 'Before your first Grep, Glob or exploratory Bash command in a session, call mcp__idecore__map_overview. Do not explore the project by hand before it.']
      : []),
    '',
    'Rules:',
    '1. Before you change any project file (Write, Edit, NotebookEdit, or a shell command that writes, moves or deletes files), call mcp__idecore__propose_plan with a goal and steps. Each step has a key, a title, a rationale and targets. A target is {"componentId": "<id from the list below>"} or {"path": "<project path>"}, with "op": "modify", "create" or "delete". A file your commands remove (rm, mv) needs its own "delete" target, even when the plan creates it.',
    '2. Wait for its result. "approved": go on. "changes_requested": revise the plan using the feedback and propose it again. "rejected": stop and wait for the user.',
    '3. Before you work on a step, call mcp__idecore__step with {"key": "<key>", "phase": "start"}; when it is finished, call it with "phase": "done". One step is active at a time.',
    '4. A write outside the approved plan is blocked or waits for the user. If you need more files, call propose_plan again with the whole plan, keeping the active and done steps.',
    '5. Reading files and running commands that write no project files need no plan.',
    '6. Tool errors that start with "IDE:" come from this IDE on behalf of the user. Follow them.',
    ...(mapTools
      ? ['7. After map_overview, call mcp__idecore__map_component with an id for that component\'s files and exported symbols before you search its files by hand.']
      : []),
    ...(searchTool
      ? [`${mapTools ? 8 : 7}. To find which files deal with a topic when you do not know the names, call mcp__idecore__search_code with a description; for exact names or strings use grep, and read the file to confirm a hit.`]
      : []),
    `${(mapTools ? 1 : 0) + (searchTool ? 1 : 0) + 7}. Right after your first reply in a chat, call mcp__idecore__set_chat_title once with a short name for the task. It is not a project change and needs no plan.`,
    '',
    'A small plan may be approved at once, without waiting for the user.',
    '',
    components.length > 0 ? 'Components of this project (id — name):' : 'The project map has no components yet; name project paths in your plans.',
    ...listed,
    ...more,
  ].join('\n');
}
