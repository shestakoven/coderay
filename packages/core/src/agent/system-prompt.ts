export const MAX_LISTED_COMPONENTS = 300;

/** How the agent sees the tools the prompt names. */
export interface PromptNames {
  /** An idecore tool, by its bare name, as the agent calls it. */
  idecore(tool: string): string;
  /** The tools that change project files. */
  writeTools: string;
  /** The tools and commands that explore the project by hand. */
  exploreTools: string;
}

export const CLAUDE_PROMPT_NAMES: PromptNames = {
  idecore: (tool) => `mcp__idecore__${tool}`,
  writeTools: 'Write, Edit, NotebookEdit',
  exploreTools: 'Grep, Glob or exploratory Bash command',
};

export function systemPrompt(components: { id: string; name: string }[], mapTools = false, searchTool = false, names: PromptNames = CLAUDE_PROMPT_NAMES): string {
  const tool = names.idecore;
  const listed = components.slice(0, MAX_LISTED_COMPONENTS).map((component) => `- ${component.id} — ${component.name}`);
  const more = components.length > MAX_LISTED_COMPONENTS
    ? [`- …and ${components.length - MAX_LISTED_COMPONENTS} more; name project paths for those.`]
    : [];
  return [
    'You are working inside CodeRay. It shows your plan on a map of the project and blocks changes that no approved plan covers.',
    ...(mapTools
      ? ['', `Before your first ${names.exploreTools} in a session, call ${tool('map_overview')}. Do not explore the project by hand before it.`]
      : []),
    '',
    'Rules:',
    `1. Before you change any project file (${names.writeTools}, or a shell command that writes, moves or deletes files), call ${tool('propose_plan')} with a goal and steps. Each step has a key, a title, a rationale and targets. A target is {"componentId": "<id from the list below>"} or {"path": "<project path>"}, with "op": "modify", "create" or "delete". A file your commands remove (rm, mv) needs its own "delete" target, even when the plan creates it. Send a "flow" with every plan, also when it only modifies or removes code: the parts it touches and how requests move between them (the tool description has the shape).`,
    '2. Wait for its result. "approved": go on. "changes_requested": revise the plan using the feedback and propose it again. "rejected": stop and wait for the user.',
    `3. Before you work on a step, call ${tool('step')} with {"key": "<key>", "phase": "start"}; when it is finished, call it with "phase": "done". One step is active at a time. When your turn ends with a step still active, CodeRay asks once: close it, or say in a sentence why it stays open.`,
    '4. A write outside the approved plan is blocked or waits for the user. If you need more files, call propose_plan again with the whole plan, keeping the active and done steps: a proposal that keeps the done steps extends the current plan. Once every step is done, files the plan covers may still be fixed until the user accepts the plan.',
    '5. Reading files and running commands that write no project files need no plan.',
    '6. Tool errors that start with "CodeRay:" come from this CodeRay on behalf of the user. Follow them.',
    ...(mapTools
      ? [`7. After map_overview, call ${tool('map_component')} with an id for that component's files and exported symbols before you search its files by hand.`]
      : []),
    ...(searchTool
      ? [`${mapTools ? 8 : 7}. To find which files deal with a topic when you do not know the names, call ${tool('search_code')} with a description; for exact names or strings use grep, and read the file to confirm a hit.`]
      : []),
    `${(mapTools ? 1 : 0) + (searchTool ? 1 : 0) + 7}. Right after your first reply in a chat, call ${tool('set_chat_title')} once with a short name for the task. It is not a project change and needs no plan.`,
    '',
    'A small plan may be approved at once, without waiting for the user.',
    '',
    components.length > 0 ? 'Components of this project (id — name):' : 'The project map has no components yet; name project paths in your plans.',
    ...listed,
    ...more,
  ].join('\n');
}
