import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { TeamContext } from './teamContext';

export interface Workflow {
  id: string;
  label: string;
  description: string;
  forRoles: string[];
  taskKind: 'code-edit' | 'review' | 'explain' | 'chat';
  build: (ctx: TeamContext) => Promise<{ prompt: string; payload: string }>;
}

// Uses execFileSync with array args to avoid shell interpretation.
function gitExec(args: string[], cwd: string): string {
  try {
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
    });
    return typeof out === 'string' ? out : '';
  } catch {
    return '';
  }
}

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function getActiveSelection(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return '';
  const sel = editor.selection;
  return sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
}

export const WORKFLOWS: Workflow[] = [
  {
    id: 'review-branch',
    label: 'Review current branch as a PR',
    description: 'Review all changes on this branch vs origin/main',
    forRoles: ['engineer', 'qa'],
    taskKind: 'review',
    async build(ctx) {
      const prompt = (await ctx.readPrompt('review.md')) ?? 'Review the following diff carefully.';
      const cwd = getWorkspaceRoot();
      let payload = gitExec(['diff', 'origin/main...HEAD'], cwd);
      if (!payload.trim()) {
        payload = gitExec(['diff', 'HEAD~1'], cwd);
      }
      if (!payload.trim()) {
        payload = '(no diff found)';
      }
      return { prompt, payload };
    },
  },

  {
    id: 'standup',
    label: 'Generate my standup',
    description: 'Summarise recent git activity into a standup update',
    forRoles: [],
    taskKind: 'chat',
    async build(ctx) {
      const prompt = (await ctx.readPrompt('standup.md')) ?? 'Write a standup update.';
      const cwd = getWorkspaceRoot();
      const log = gitExec(['log', '--oneline', '-10'], cwd) || '(no commits found)';
      const status = gitExec(['status', '--short'], cwd) || '(clean working tree)';
      const payload = `Recent commits:\n${log}\nWorking tree status:\n${status}`;
      return { prompt, payload };
    },
  },

  {
    id: 'explain-selection',
    label: 'Explain selected code',
    description: 'Explain what the current selection does and why it exists',
    forRoles: [],
    taskKind: 'explain',
    async build(ctx) {
      const prompt = (await ctx.readPrompt('explain.md')) ?? 'Explain the following code.';
      const payload = getActiveSelection() || '(no selection — open a file and select some code)';
      return { prompt, payload };
    },
  },

  {
    id: 'pm-spec-to-tasks',
    label: 'Break a spec into engineering tasks',
    description: 'Convert a selected spec or requirement into a sprint-ready task list',
    forRoles: ['pm'],
    taskKind: 'chat',
    async build(_ctx) {
      const prompt = [
        'You are a senior engineer on this project. A PM has provided a feature spec below.',
        '',
        'Break it into a list of engineering tasks suitable for a sprint board. For each task:',
        '- Give it a short, imperative title (e.g. "Add user avatar upload endpoint")',
        '- Note the task kind: backend, frontend, infra, or cross-cutting',
        '- Estimate rough complexity: XS / S / M / L / XL',
        '- Flag any unknowns or decisions needed before the task can start',
        '',
        'Be exhaustive but avoid unnecessary granularity. Group related tasks.',
      ].join('\n');
      const payload = getActiveSelection() || '(no selection — select the spec text first)';
      return { prompt, payload };
    },
  },

  {
    id: 'design-handoff',
    label: 'Design handoff checklist',
    description: 'Generate a developer handoff checklist from a design description',
    forRoles: ['designer'],
    taskKind: 'chat',
    async build(_ctx) {
      const prompt = [
        'You are reviewing a design handoff on behalf of the engineering team.',
        'Given the design description below, produce a handoff checklist that engineers will use to implement it.',
        '',
        'For each item in the checklist:',
        '- Be specific about what needs to be built or decided',
        '- Flag anything that needs a design clarification before implementation can begin',
        '- Note any accessibility requirements',
        '- Note any responsive behaviour or breakpoint decisions',
        '',
        'Format as a markdown checklist.',
      ].join('\n');
      const payload = getActiveSelection() || '(no selection — select a design description first)';
      return { prompt, payload };
    },
  },

  {
    id: 'doc-current-file',
    label: 'Document current file',
    description: 'Add or improve documentation for the active file',
    forRoles: ['engineer'],
    taskKind: 'code-edit',
    async build(_ctx) {
      const prompt = [
        'You are a senior engineer on this project. Add or improve the documentation for the file below.',
        '',
        'Rules:',
        '- Add a brief file-level header comment explaining what the module is and why it exists (if missing)',
        '- Add or improve function/method doc comments for exported symbols only',
        '- Do not add inline comments that just restate the code',
        '- Preserve existing meaningful comments',
        '- Return the complete updated file',
      ].join('\n');
      const editor = vscode.window.activeTextEditor;
      const payload = editor ? editor.document.getText() : '(no active file)';
      return { prompt, payload };
    },
  },

  {
    id: 'write-tests',
    label: 'Write tests for current file',
    description: 'Generate a test suite for the active file following project conventions',
    forRoles: ['engineer', 'qa'],
    taskKind: 'code-edit',
    async build(_ctx) {
      const prompt = [
        'You are a senior engineer on this project. Write a thorough test suite for the code below.',
        '',
        'Rules:',
        '- Follow the testing conventions in the project skill and conventions files',
        '- Cover the happy path, edge cases, and error conditions for every exported function/class',
        '- Use the same testing framework and patterns already present in the project (infer from the code)',
        '- Do not test private/internal implementation details',
        '- Return only the test file content, ready to save',
      ].join('\n');
      const editor = vscode.window.activeTextEditor;
      const payload = editor ? editor.document.getText() : '(no active file)';
      return { prompt, payload };
    },
  },

  {
    id: 'generate-changelog',
    label: 'Generate changelog from git log',
    description: 'Produce a human-readable changelog from recent commits',
    forRoles: [],
    taskKind: 'chat',
    async build(_ctx) {
      const prompt = [
        'You are a technical writer for this project. Based on the git log below, write a concise, human-readable changelog.',
        '',
        'Format as markdown with sections: **Features**, **Fixes**, **Chores** (skip empty sections).',
        'Each entry is one line starting with a dash. Group related commits into a single entry.',
        'Ignore merge commits and version bumps. Focus on what changed for the user or team.',
      ].join('\n');
      const cwd = getWorkspaceRoot();
      const log = gitExec(['log', '--oneline', '--no-merges', '-30'], cwd) || '(no commits found)';
      return { prompt, payload: log };
    },
  },

  {
    id: 'triage-bug',
    label: 'Triage bug report',
    description: 'Analyse a bug description and suggest causes, severity, and next steps',
    forRoles: ['engineer', 'qa'],
    taskKind: 'chat',
    async build(_ctx) {
      const prompt = [
        'You are a senior engineer triaging a bug for this project.',
        '',
        'Given the bug report below, produce a structured triage:',
        '- **Likely cause(s)** — where in the codebase to look first',
        '- **Severity** — critical / high / medium / low, with one-line justification',
        '- **Reproduction steps** — if not already clear, suggest how to reliably reproduce',
        '- **Suggested fix** — a concrete starting point (file, function, approach)',
        '- **Questions to ask the reporter** — if key info is missing',
      ].join('\n');
      const payload = getActiveSelection() || '(no selection — paste or select a bug report first)';
      return { prompt, payload };
    },
  },
];

export async function runWorkflowById(
  id: string,
  ctx: TeamContext
): Promise<{ workflow: Workflow; prompt: string; payload: string } | undefined> {
  const workflow = WORKFLOWS.find(w => w.id === id);
  if (!workflow) return undefined;
  const { prompt, payload } = await workflow.build(ctx);
  return { workflow, prompt, payload };
}
