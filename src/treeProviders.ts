import * as vscode from 'vscode';
import { DetectedTool } from './toolDetector';
import { WORKFLOWS } from './workflows';
import { TeamContext, ActivityEntry } from './teamContext';

export class ToolsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private tools: DetectedTool[] = [];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  setTools(tools: DetectedTool[]): void {
    this.tools = tools;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.tools.length === 0) {
      const item = new vscode.TreeItem('Detecting tools…');
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      return [item];
    }

    return this.tools.map(tool => {
      const item = new vscode.TreeItem(tool.name);
      item.description = tool.available ? '✓ available' : '✗ not found';
      item.tooltip = new vscode.MarkdownString(tool.detail);
      item.iconPath = new vscode.ThemeIcon(
        tool.available ? 'pass-filled' : 'error',
        new vscode.ThemeColor(tool.available ? 'testing.iconPassed' : 'testing.iconFailed')
      );
      return item;
    });
  }
}

export class WorkflowsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const config = vscode.workspace.getConfiguration('kernal');
    const userRole = config.get<string>('userRole', 'engineer');

    return WORKFLOWS
      .filter(w => w.forRoles.length === 0 || w.forRoles.includes(userRole))
      .map(w => {
        const item = new vscode.TreeItem(w.label);
        item.description = w.description;
        item.tooltip = new vscode.MarkdownString(
          `**${w.label}**\n\n${w.description}\n\nTask kind: \`${w.taskKind}\``
        );
        item.iconPath = new vscode.ThemeIcon('play');
        item.command = {
          command: 'kernal.runWorkflow',
          title: 'Run Workflow',
          arguments: [w.id],
        };
        return item;
      });
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export class ActivityTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private entries: ActivityEntry[] = [];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: TeamContext) {}

  async refresh(): Promise<void> {
    this.entries = await this.context.readActivity(50);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.entries.length === 0) {
      const item = new vscode.TreeItem('No activity yet');
      item.iconPath = new vscode.ThemeIcon('history');
      return [item];
    }

    return this.entries.map(entry => {
      const item = new vscode.TreeItem(`${entry.user} · ${entry.workflow}`);
      item.description = `${entry.tool} · ${relativeTime(entry.timestamp)}`;
      item.tooltip = new vscode.MarkdownString(
        `**${entry.user}** (${entry.role}) ran \`${entry.workflow}\` via ${entry.tool}\n\n${entry.timestamp}\n\n${entry.summary}`
      );
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      return item;
    });
  }
}
