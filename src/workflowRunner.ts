import * as vscode from 'vscode';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { TeamContext, ActivityEntry } from './teamContext';
import { DetectedTool } from './toolDetector';

export interface WorkflowResult {
  ok: boolean;
  output?: string;
  error?: string;
}

const CLI_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class WorkflowRunner {
  private readonly context: TeamContext;
  private cachedUsername: string | undefined;

  constructor(context: TeamContext) {
    this.context = context;
  }

  // Builds the full prompt with context bundle — exposed so callers can preview before sending.
  async assemblePrompt(taskPrompt: string, payload: string): Promise<string> {
    const activeFile = vscode.window.activeTextEditor?.document.uri;
    const contextBundle = await this.context.loadContextBundle(activeFile);
    return this.buildFullPrompt(contextBundle, taskPrompt, payload);
  }

  // Invokes the chosen tool with a pre-assembled prompt. onChunk receives stdout as it streams.
  async invoke(
    tool: DetectedTool,
    workflowName: string,
    fullPrompt: string,
    onChunk?: (chunk: string) => void
  ): Promise<WorkflowResult> {
    let result: WorkflowResult;

    switch (tool.id) {
      case 'claude-code':
        result = await this.runClaudeCode(fullPrompt, onChunk);
        break;
      case 'codex':
        result = await this.runCodex(fullPrompt, onChunk);
        break;
      case 'copilot':
        result = await this.runCopilot(fullPrompt);
        break;
      case 'claude-web':
        result = await this.runClaudeWeb(fullPrompt);
        break;
      default: {
        const _unreachable: never = tool.id;
        result = { ok: false, error: `Unknown tool: ${_unreachable}` };
      }
    }

    await this.logActivity(tool, workflowName, result);
    return result;
  }

  // Convenience: assemble then invoke. Used by standard workflow commands.
  async run(
    tool: DetectedTool,
    workflowName: string,
    taskPrompt: string,
    payload: string
  ): Promise<WorkflowResult> {
    const fullPrompt = await this.assemblePrompt(taskPrompt, payload);
    return this.invoke(tool, workflowName, fullPrompt);
  }

  private buildFullPrompt(contextBundle: string, taskPrompt: string, payload: string): string {
    const lines: string[] = [
      'You are operating as a teammate on this project. The PROJECT SKILL block',
      'below defines how this project is built and reviewed; treat it as authoritative.',
      'If anything in the user task contradicts the skill, follow the skill and flag',
      'the conflict.',
      '',
    ];

    if (contextBundle) {
      lines.push(`## Context\n${contextBundle}`, '');
    }

    lines.push(`## Task\n${taskPrompt}`, '', `## Input\n${payload}`);
    return lines.join('\n');
  }

  // Spawns a CLI tool, pipes the prompt via stdin to avoid OS argument-length limits,
  // and enforces a 5-minute hard timeout.
  private spawnCli(
    command: string,
    args: string[],
    fullPrompt: string,
    onChunk?: (chunk: string) => void,
    outputTitle?: string
  ): Promise<WorkflowResult> {
    return new Promise(resolve => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

      // Pipe prompt via stdin — avoids OS ARG_MAX limits on large diffs/files.
      proc.stdin?.write(fullPrompt, 'utf8');
      proc.stdin?.end();

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: WorkflowResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        proc.kill();
        finish({ ok: false, error: `${command} timed out after 5 minutes.` });
      }, CLI_TIMEOUT_MS);

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onChunk?.(text);
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          // Open a tab only for workflow runs, not when streaming to the chat panel.
          if (!onChunk && outputTitle) this.showOutput(stdout);
          finish({ ok: true, output: stdout });
        } else {
          finish({ ok: false, error: stderr || `${command} exited with code ${code}` });
        }
      });

      proc.on('error', (err: Error) => {
        finish({ ok: false, error: err.message });
      });
    });
  }

  private runClaudeCode(fullPrompt: string, onChunk?: (chunk: string) => void): Promise<WorkflowResult> {
    return this.spawnCli('claude', ['-p'], fullPrompt, onChunk, 'Claude Code Output');
  }

  private runCodex(fullPrompt: string, onChunk?: (chunk: string) => void): Promise<WorkflowResult> {
    return this.spawnCli('codex', ['exec'], fullPrompt, onChunk, 'Codex Output');
  }

  private async runCopilot(fullPrompt: string): Promise<WorkflowResult> {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: fullPrompt });
      return { ok: true, output: 'Prompt sent to GitHub Copilot Chat.' };
    } catch {
      return this.copyToClipboardWithWarning(fullPrompt, 'Copilot Chat unavailable — prompt copied to clipboard.');
    }
  }

  private async runClaudeWeb(fullPrompt: string): Promise<WorkflowResult> {
    const copied = await this.copyToClipboardWithWarning(fullPrompt, 'Prompt copied to clipboard.');
    if (!copied.ok) return copied;
    const opened = await vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/new'));
    if (!opened) {
      return { ok: true, output: 'Prompt copied to clipboard. Could not open browser — navigate to claude.ai/new manually.' };
    }
    return { ok: true, output: 'Prompt copied to clipboard. claude.ai/new opened in browser — paste to run.' };
  }

  private async copyToClipboardWithWarning(prompt: string, successMessage: string): Promise<WorkflowResult> {
    const choice = await vscode.window.showWarningMessage(
      'The prompt includes your SKILL.md, team context, and code. Copy to clipboard?',
      'Copy', 'Cancel'
    );
    if (choice !== 'Copy') return { ok: false, error: 'Cancelled.' };
    await vscode.env.clipboard.writeText(prompt);
    return { ok: true, output: successMessage };
  }

  private showOutput(content: string): void {
    void vscode.workspace.openTextDocument({ content, language: 'markdown' }).then(doc => {
      void vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    });
  }

  // Cache the username — git config user.name is a sync disk read we don't need to repeat.
  private getUsername(): string {
    if (this.cachedUsername !== undefined) return this.cachedUsername;
    try {
      const out = execSync('git config user.name', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.cachedUsername = (typeof out === 'string' ? out : '').trim() || os.userInfo().username;
    } catch {
      this.cachedUsername = os.userInfo().username;
    }
    return this.cachedUsername;
  }

  private static readonly VALID_ROLES = new Set(['engineer', 'pm', 'designer', 'qa', 'other']);
  private static readonly SECRET_PATTERN = /(?:api[_-]?key|token|password|secret|bearer)\s*[=:]\s*['"]?\S+/gi;

  private async logActivity(tool: DetectedTool, workflowName: string, result: WorkflowResult): Promise<void> {
    const config = vscode.workspace.getConfiguration('kernal');
    const rawRole = config.get<string>('userRole');
    const role = (typeof rawRole === 'string' && WorkflowRunner.VALID_ROLES.has(rawRole)) ? rawRole : 'engineer';
    const raw = result.ok ? (result.output ?? '') : (result.error ?? '');
    const scrubbed = raw.replace(WorkflowRunner.SECRET_PATTERN, '[REDACTED]');
    const summary = scrubbed.slice(0, 140).replace(/\n/g, ' ');

    const entry: ActivityEntry = {
      timestamp: new Date().toISOString(),
      user: this.getUsername(),
      role,
      tool: tool.id,
      workflow: workflowName,
      summary,
    };

    await this.context.appendActivity(entry);
  }
}
