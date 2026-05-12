import * as vscode from 'vscode';
import { detectTools, routeTask, DetectedTool } from './toolDetector';
import { TeamContext } from './teamContext';
import { WorkflowRunner } from './workflowRunner';
import { WORKFLOWS, runWorkflowById } from './workflows';
import { ToolsTreeProvider, WorkflowsTreeProvider, ActivityTreeProvider } from './treeProviders';
import { ChatPanel } from './chatPanel';

let detectedTools: DetectedTool[] = [];

const VALID_TOOLS = new Set(['auto', 'claude-code', 'codex', 'copilot', 'claude-web']);
const VALID_ROLES = new Set(['engineer', 'pm', 'designer', 'qa', 'other']);

function validateTeamContextPath(raw: string | undefined): string {
  if (typeof raw !== 'string' || !raw) return '.kernal';
  // Block absolute paths, parent traversal, and non-safe characters.
  if (raw.includes('..') || raw.startsWith('/') || /[^A-Za-z0-9._\-/]/.test(raw)) return '.kernal';
  return raw;
}

function validatePreferredTool(raw: string | undefined): string {
  return (typeof raw === 'string' && VALID_TOOLS.has(raw)) ? raw : 'auto';
}

function validateUserRole(raw: string | undefined): string {
  return (typeof raw === 'string' && VALID_ROLES.has(raw)) ? raw : 'engineer';
}

const SKILL_TEMPLATE = `# Project Skill

> This file is the **authoritative playbook** for this project. Kernal prepends
> it to every AI operation — code edits, reviews, explanations, standups —
> across every teammate's tool (Claude Code, Codex, Copilot, Claude.ai free).
> Edit it whenever the project's rules change; the next AI call picks it up.

## What this project is
Briefly describe the product, the audience, and the current phase.

## Stack and structure
- Language(s):
- Framework(s):
- Key folders and what lives in each:

## How we write code here
- Style rules that override defaults:
- Patterns we prefer (and why):
- Patterns we avoid (and why):

## How we review
- What every PR must include:
- What blocks a merge:

## What "done" looks like
- Tests required:
- Docs required:
- Telemetry / observability required:

## Known gotchas
- Things that look wrong but are intentional:
- Things that look right but are bugs waiting to happen:

## When in doubt
- Who to ask:
- Which doc to read:
`;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  // 1. Require a workspace folder
  const rootFolder = vscode.workspace.workspaceFolders?.[0];
  if (!rootFolder) {
    void vscode.window.showWarningMessage('Kernal requires an open workspace folder to function.');
    return;
  }
  const root = rootFolder.uri;

  // 2. Build team context and scaffold .kernal/
  const config = vscode.workspace.getConfiguration('kernal');
  const subdirName = validateTeamContextPath(config.get<string>('teamContextPath'));
  const teamContext = new TeamContext(root, subdirName);
  await teamContext.ensureScaffold();

  // 3. Build the workflow runner
  const runner = new WorkflowRunner(teamContext);

  // 4. Build and register tree providers
  const toolsTree = new ToolsTreeProvider();
  const workflowsTree = new WorkflowsTreeProvider();
  const activityTree = new ActivityTreeProvider(teamContext);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('kernal.tools', toolsTree),
    vscode.window.registerTreeDataProvider('kernal.workflows', workflowsTree),
    vscode.window.registerTreeDataProvider('kernal.activity', activityTree),
  );

  // 5. Detect tools on activation
  detectedTools = await detectTools();
  toolsTree.setTools(detectedTools);
  await activityTree.refresh();

  // 6. Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  ctx.subscriptions.push(statusBarItem);

  async function updateStatusBar(): Promise<void> {
    const preferred = validatePreferredTool(vscode.workspace.getConfiguration('kernal').get<string>('preferredTool'));
    const activeTool = routeTask(detectedTools, 'chat', preferred);
    const hasSkill = await teamContext.hasRootSkill();
    const toolName = activeTool?.name ?? 'No tool found';

    statusBarItem.text = `$(rocket) Kernal: ${toolName}${hasSkill ? ' $(book)' : ''}`;
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**Kernal**\n\nActive tool: ${toolName}\nSKILL.md: ${hasSkill ? 'loaded ✓' : 'not found'}\n\nClick to re-detect tools.`
    );
    statusBarItem.command = 'kernal.detectTools';
    statusBarItem.show();
  }

  // 7. Initial status bar render
  await updateStatusBar();

  // 8. Watch for SKILL.md create/change/delete (debounced 500ms)
  const skillWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, '**/[Ss][Kk][Ii][Ll][Ll].[Mm][Dd]')
  );
  let skillDebounce: ReturnType<typeof setTimeout> | undefined;
  const onSkillChanged = (): void => {
    if (skillDebounce) clearTimeout(skillDebounce);
    skillDebounce = setTimeout(() => {
      void teamContext.refreshSkillCache().then(() => updateStatusBar());
    }, 500);
  };
  ctx.subscriptions.push(
    skillWatcher,
    skillWatcher.onDidCreate(onSkillChanged),
    skillWatcher.onDidChange(onSkillChanged),
    skillWatcher.onDidDelete(onSkillChanged),
  );

  // 9. Register all commands
  ctx.subscriptions.push(

    vscode.commands.registerCommand('kernal.openPanel', () => {
      void vscode.commands.executeCommand('workbench.view.extension.kernal');
    }),

    vscode.commands.registerCommand('kernal.detectTools', async () => {
      detectedTools = await detectTools();
      toolsTree.setTools(detectedTools);
      await updateStatusBar();
      ChatPanel.currentPanel?.updateStatus();
      const count = detectedTools.filter(t => t.available).length;
      void vscode.window.showInformationMessage(`Kernal: detected ${count} available AI tool(s).`);
    }),

    vscode.commands.registerCommand('kernal.syncContext', async () => {
      await teamContext.ensureScaffold();
      await teamContext.refreshSkillCache();
      await updateStatusBar();
      void vscode.window.showInformationMessage('Kernal: team context synced.');
    }),

    vscode.commands.registerCommand('kernal.runWorkflow', async (workflowId?: string) => {
      const preferred = validatePreferredTool(vscode.workspace.getConfiguration('kernal').get<string>('preferredTool'));

      let selectedId = workflowId;
      if (!selectedId) {
        const role = validateUserRole(vscode.workspace.getConfiguration('kernal').get<string>('userRole'));
        const visible = WORKFLOWS.filter(w => w.forRoles.length === 0 || w.forRoles.includes(role));
        const picked = await vscode.window.showQuickPick(
          visible.map(w => ({ label: w.label, description: w.description, id: w.id })),
          { placeHolder: 'Pick a workflow to run' }
        );
        if (!picked) return;
        selectedId = picked.id;
      }

      const built = await runWorkflowById(selectedId, teamContext);
      if (!built) {
        void vscode.window.showErrorMessage(`Kernal: unknown workflow "${selectedId}".`);
        return;
      }

      const tool = routeTask(detectedTools, built.workflow.taskKind, preferred);
      if (!tool) {
        void vscode.window.showErrorMessage(
          'Kernal: no AI tools available. Install Claude Code, Codex, or GitHub Copilot.'
        );
        return;
      }

      const previewEnabled = vscode.workspace.getConfiguration('kernal').get<boolean>('previewBeforeSend', false);
      let fullPrompt: string;

      if (previewEnabled) {
        fullPrompt = await runner.assemblePrompt(built.prompt, built.payload);
        const doc = await vscode.workspace.openTextDocument({ content: fullPrompt, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        const choice = await vscode.window.showInformationMessage(
          `Send to ${tool.name}?`,
          { modal: false },
          'Send',
          'Cancel'
        );
        if (choice !== 'Send') return;
      } else {
        fullPrompt = await runner.assemblePrompt(built.prompt, built.payload);
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Kernal: running ${built.workflow.label}…`,
          cancellable: false,
        },
        () => runner.invoke(tool, built.workflow.id, fullPrompt)
      );
      await activityTree.refresh();

      if (!result.ok) {
        void vscode.window.showErrorMessage(`Kernal: workflow failed — ${result.error}`);
      } else if (result.output && result.output.includes('clipboard')) {
        void vscode.window.showInformationMessage(result.output);
      }
    }),

    vscode.commands.registerCommand('kernal.sendToActiveTool', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Kernal: no active editor.');
        return;
      }
      const sel = editor.selection;
      const text = editor.document.getText(sel.isEmpty ? undefined : sel);
      const preferred = validatePreferredTool(vscode.workspace.getConfiguration('kernal').get<string>('preferredTool'));
      const tool = routeTask(detectedTools, 'explain', preferred);
      if (!tool) {
        void vscode.window.showErrorMessage('Kernal: no AI tools available.');
        return;
      }
      const result = await runner.run(tool, 'send-selection', 'Please help with the following:', text);
      await activityTree.refresh();
      if (!result.ok) {
        void vscode.window.showErrorMessage(`Kernal: ${result.error}`);
      }
    }),

    vscode.commands.registerCommand('kernal.standup', () => {
      void vscode.commands.executeCommand('kernal.runWorkflow', 'standup');
    }),

    vscode.commands.registerCommand('kernal.reviewPR', () => {
      void vscode.commands.executeCommand('kernal.runWorkflow', 'review-branch');
    }),

    vscode.commands.registerCommand('kernal.chat', () => {
      ChatPanel.createOrShow(teamContext, runner, () => detectedTools);
    }),

    vscode.commands.registerCommand('kernal.showSkill', async () => {
      const skillUri = vscode.Uri.joinPath(root, 'SKILL.md');
      try {
        await vscode.workspace.fs.stat(skillUri);
        const doc = await vscode.workspace.openTextDocument(skillUri);
        await vscode.window.showTextDocument(doc);
      } catch {
        const choice = await vscode.window.showInformationMessage(
          'No SKILL.md at the repo root. Create one?',
          'Create',
          'Cancel'
        );
        if (choice === 'Create') {
          await vscode.workspace.fs.writeFile(skillUri, Buffer.from(SKILL_TEMPLATE, 'utf8'));
          const doc = await vscode.workspace.openTextDocument(skillUri);
          await vscode.window.showTextDocument(doc);
        }
      }
    }),

  );

  // 10. Respond to configuration changes
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('kernal')) {
        void updateStatusBar();
        workflowsTree.refresh();
      }
    })
  );
}

export function deactivate(): void {
  // Subscriptions in ctx are disposed automatically
}
