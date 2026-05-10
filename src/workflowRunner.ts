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

export class WorkflowRunner {
  private context: TeamContext;

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

  private runClaudeCode(fullPrompt: string, onChunk?: (chunk: string) => void): Promise<WorkflowResult> {
    return new Promise(resolve => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const proc = spawn('claude', ['-p', fullPrompt], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onChunk?.(text);
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          // Only open an editor tab when not streaming to a panel
          if (!onChunk) this.showOutput(stdout, 'Claude Code Output');
          resolve({ ok: true, output: stdout });
        } else {
          resolve({ ok: false, error: stderr || `claude exited with code ${code}` });
        }
      });

      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
    });
  }

  private runCodex(fullPrompt: string, onChunk?: (chunk: string) => void): Promise<WorkflowResult> {
    return new Promise(resolve => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const proc = spawn('codex', ['exec', fullPrompt], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onChunk?.(text);
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          if (!onChunk) this.showOutput(stdout, 'Codex Output');
          resolve({ ok: true, output: stdout });
        } else {
          resolve({ ok: false, error: stderr || `codex exited with code ${code}` });
        }
      });

      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
    });
  }

  private async runCopilot(fullPrompt: string): Promise<WorkflowResult> {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: fullPrompt });
      return { ok: true, output: 'Prompt sent to GitHub Copilot Chat.' };
    } catch {
      await vscode.env.clipboard.writeText(fullPrompt);
      return { ok: true, output: 'Copilot Chat unavailable — prompt copied to clipboard.' };
    }
  }

  private async runClaudeWeb(fullPrompt: string): Promise<WorkflowResult> {
    await vscode.env.clipboard.writeText(fullPrompt);
    await vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/new'));
    return { ok: true, output: 'Prompt copied to clipboard. claude.ai/new opened in browser — paste to run.' };
  }

  private showOutput(content: string, title: string): void {
    void vscode.workspace.openTextDocument({ content, language: 'markdown' }).then(doc => {
      void vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    });
    void title; // used as intent label; VS Code doesn't support tab titles for untitled docs
  }

  private async logActivity(tool: DetectedTool, workflowName: string, result: WorkflowResult): Promise<void> {
    const config = vscode.workspace.getConfiguration('kernal');
    const role = config.get<string>('userRole', 'engineer');

    let username = 'unknown';
    try {
      const out = execSync('git config user.name', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      username = (typeof out === 'string' ? out : '').trim() || os.userInfo().username;
    } catch {
      username = os.userInfo().username;
    }

    const raw = result.ok ? (result.output ?? '') : (result.error ?? '');
    const summary = raw.slice(0, 140).replace(/\n/g, ' ');

    const entry: ActivityEntry = {
      timestamp: new Date().toISOString(),
      user: username,
      role,
      tool: tool.id,
      workflow: workflowName,
      summary,
    };

    await this.context.appendActivity(entry);
  }
}
