import * as vscode from 'vscode';
import { execSync } from 'child_process';

export interface DetectedTool {
  id: 'claude-code' | 'codex' | 'copilot' | 'claude-web';
  name: string;
  available: boolean;
  invokeMethod: 'cli' | 'extension' | 'manual';
  detail: string;
}

function checkCliTool(command: string): boolean {
  try {
    execSync(`${command} --version`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export async function detectTools(): Promise<DetectedTool[]> {
  const claudeCode: DetectedTool = {
    id: 'claude-code',
    name: 'Claude Code',
    available: checkCliTool('claude'),
    invokeMethod: 'cli',
    detail: 'Claude Code CLI — invoked via `claude -p <prompt>`',
  };

  const codex: DetectedTool = {
    id: 'codex',
    name: 'Codex CLI',
    available: checkCliTool('codex'),
    invokeMethod: 'cli',
    detail: 'OpenAI Codex CLI — invoked via `codex exec <prompt>`',
  };

  const copilotExt = vscode.extensions.getExtension('GitHub.copilot');
  const copilotChatExt = vscode.extensions.getExtension('GitHub.copilot-chat');
  const copilotInstalled = !!(copilotExt || copilotChatExt);
  const copilotActive = !!(copilotExt?.isActive || copilotChatExt?.isActive);
  const copilot: DetectedTool = {
    id: 'copilot',
    name: 'GitHub Copilot',
    available: copilotInstalled,
    invokeMethod: 'extension',
    detail: copilotInstalled
      ? copilotActive
        ? 'GitHub Copilot extension is installed and active'
        : 'GitHub Copilot extension is installed but not yet active'
      : 'GitHub Copilot extension is not installed',
  };

  const claudeWeb: DetectedTool = {
    id: 'claude-web',
    name: 'Claude.ai (web)',
    available: true,
    invokeMethod: 'manual',
    detail: 'Loom will copy a prompt to your clipboard for pasting into claude.ai',
  };

  return [claudeCode, codex, copilot, claudeWeb];
}

const TASK_PREFERENCE: Record<string, ReadonlyArray<DetectedTool['id']>> = {
  'code-edit': ['claude-code', 'codex', 'copilot', 'claude-web'],
  'review':    ['claude-code', 'copilot', 'codex', 'claude-web'],
  'explain':   ['copilot', 'claude-code', 'claude-web', 'codex'],
  'chat':      ['claude-code', 'copilot', 'claude-web', 'codex'],
};

export function routeTask(
  tools: DetectedTool[],
  taskKind: 'code-edit' | 'review' | 'explain' | 'chat',
  preferred: string
): DetectedTool | undefined {
  const available = tools.filter(t => t.available);
  if (available.length === 0) return undefined;

  if (preferred !== 'auto') {
    const match = available.find(t => t.id === preferred);
    if (match) return match;
  }

  const order = TASK_PREFERENCE[taskKind] ?? TASK_PREFERENCE['chat'];
  for (const id of order) {
    const match = available.find(t => t.id === id);
    if (match) return match;
  }

  return available[0];
}
