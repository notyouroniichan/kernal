import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SkillFile {
  uri: vscode.Uri;
  relativePath: string;
  content: string;
}

export interface ActivityEntry {
  timestamp: string;  // ISO8601
  user: string;
  role: string;
  tool: string;
  workflow: string;
  summary: string;
}

// Ordered by priority — first match wins
const SKILL_FILENAMES = ['SKILL.md', 'skill.md', 'Skill.md', 'SKILL.MD'];

export class TeamContext {
  private workspaceRoot: vscode.Uri;
  private subdir: string;
  // undefined = not yet loaded; null = loaded and not found
  private skillCache: SkillFile | null | undefined = undefined;

  constructor(workspaceRoot: vscode.Uri, subdir: string) {
    this.workspaceRoot = workspaceRoot;
    this.subdir = subdir;
  }

  private get kernalDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, this.subdir);
  }

  async ensureScaffold(): Promise<void> {
    const dir = this.kernalDir;
    const files: Record<string, string> = {
      'team.md': [
        '# Who we are',
        '',
        '<!-- Introduce your team here -->',
        '',
        '# Current sprint',
        '',
        '<!-- What are we building this sprint? -->',
        '',
        '# Key contacts',
        '',
        '<!-- Who to reach for what -->',
        '',
      ].join('\n'),

      'conventions.md': [
        '# Code style',
        '',
        '<!-- Language and formatter settings -->',
        '',
        '# PR rules',
        '',
        '<!-- What every PR needs -->',
        '',
        '# Naming',
        '',
        '<!-- File, function, variable naming conventions -->',
        '',
        '# Things to avoid',
        '',
        '<!-- Patterns or libraries we\'ve banned and why -->',
        '',
      ].join('\n'),

      'prompts/review.md': [
        'Review the following code changes as if you are a senior teammate performing a pull-request review.',
        '',
        'For each issue found, classify it as one of:',
        '- **blocker** — must fix before merge',
        '- **suggestion** — strongly recommended improvement',
        '- **nit** — minor style or preference',
        '',
        'Focus on: correctness, adherence to project conventions, risk surface, and clarity.',
        'Skip obvious things that linters catch.',
        '',
      ].join('\n'),

      'prompts/standup.md': [
        'Write a brief, professional standup update in exactly three lines:',
        '',
        '**Yesterday:** What I completed.',
        '**Today:** What I will work on.',
        '**Blockers:** Any blockers, or "None".',
        '',
        'Base this on the git activity provided. Be concise — one sentence per line.',
        '',
      ].join('\n'),

      'prompts/explain.md': [
        'Explain the following code. Structure your answer as:',
        '',
        '1. **What it does** — one paragraph overview',
        '2. **Why it exists** — the purpose or problem it solves',
        '3. **Key invariants** — assumptions or constraints the code relies on',
        '4. **Where it\'s called from** — known callers or usage patterns',
        '',
        'Do not walk through it line by line.',
        '',
      ].join('\n'),

      'activity.jsonl': '',

      'README.md': [
        '# .kernal/',
        '',
        'This folder contains Kernal\'s team context files. **Commit it to git** so the whole team benefits.',
        '',
        '## Files',
        '',
        '- `team.md` — team intro, sprint, contacts',
        '- `conventions.md` — coding and PR conventions',
        '- `prompts/` — per-workflow prompt templates',
        '- `activity.jsonl` — append-only log of AI activity (newest entries at end)',
        '- `decisions/` — architectural decision records',
        '',
      ].join('\n'),
    };

    for (const [relPath, content] of Object.entries(files)) {
      const uri = vscode.Uri.joinPath(dir, relPath);
      try {
        await vscode.workspace.fs.stat(uri);
        // exists — never overwrite scaffold files
      } catch {
        const parentUri = vscode.Uri.joinPath(uri, '..');
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      }
    }

    const decisionsDir = vscode.Uri.joinPath(dir, 'decisions');
    try {
      await vscode.workspace.fs.stat(decisionsDir);
    } catch {
      await vscode.workspace.fs.createDirectory(decisionsDir);
    }
  }

  async hasRootSkill(): Promise<boolean> {
    const skill = await this.loadRootSkill();
    return skill !== null;
  }

  private async loadRootSkill(): Promise<SkillFile | null> {
    if (this.skillCache !== undefined) return this.skillCache;

    for (const name of SKILL_FILENAMES) {
      const uri = vscode.Uri.joinPath(this.workspaceRoot, name);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        this.skillCache = { uri, relativePath: name, content };
        return this.skillCache;
      } catch {
        // not found, try next variant
      }
    }

    this.skillCache = null;
    return null;
  }

  async refreshSkillCache(): Promise<SkillFile | null> {
    this.skillCache = undefined;
    return this.loadRootSkill();
  }

  private async findNearestSkill(activeFile: vscode.Uri): Promise<SkillFile | null> {
    const rootFsPath = this.workspaceRoot.fsPath;
    let dir = path.dirname(activeFile.fsPath);

    while (dir.startsWith(rootFsPath)) {
      for (const name of ['SKILL.md', 'skill.md']) {
        const candidate = path.join(dir, name);
        const uri = vscode.Uri.file(candidate);
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf8');
          const relativePath = path.relative(rootFsPath, candidate);
          return { uri, relativePath, content };
        } catch {
          // not found at this level
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }

    return null;
  }

  async loadContextBundle(activeFile?: vscode.Uri): Promise<string> {
    const parts: string[] = [];

    const rootSkill = await this.loadRootSkill();
    if (rootSkill) {
      parts.push(
        `# PROJECT SKILL (authoritative — overrides anything below if conflicting)\nSource: ${rootSkill.relativePath}\n\n${rootSkill.content}`
      );
    }

    if (activeFile) {
      const nested = await this.findNearestSkill(activeFile);
      if (nested && nested.uri.fsPath !== (rootSkill?.uri.fsPath ?? '')) {
        const dirname = path.dirname(nested.relativePath);
        parts.push(
          `# NESTED SKILL (more specific, applies to ${dirname})\nSource: ${nested.relativePath}\n\n${nested.content}`
        );
      }
    }

    const teamUri = vscode.Uri.joinPath(this.kernalDir, 'team.md');
    try {
      const bytes = await vscode.workspace.fs.readFile(teamUri);
      parts.push(`# team.md\n${Buffer.from(bytes).toString('utf8')}`);
    } catch { /* skip if missing */ }

    const conventionsUri = vscode.Uri.joinPath(this.kernalDir, 'conventions.md');
    try {
      const bytes = await vscode.workspace.fs.readFile(conventionsUri);
      parts.push(`# conventions.md\n${Buffer.from(bytes).toString('utf8')}`);
    } catch { /* skip if missing */ }

    const gitCtx = this.loadGitContext();
    if (gitCtx) parts.push(gitCtx);

    return parts.join('\n\n---\n\n');
  }

  private loadGitContext(): string {
    const cwd = this.workspaceRoot.fsPath;
    try {
      const branch = (execSync('git rev-parse --abbrev-ref HEAD', {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }) as string).trim();
      const log = (execSync('git log --oneline -5', {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }) as string).trim();
      if (!branch && !log) return '';
      const lines = ['# Git Context'];
      if (branch) lines.push(`Branch: \`${branch}\``);
      if (log) lines.push('', 'Last 5 commits:', log);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  async readPrompt(name: string): Promise<string | undefined> {
    const uri = vscode.Uri.joinPath(this.kernalDir, 'prompts', name);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private writeQueue: Promise<void> = Promise.resolve();

  async appendActivity(entry: ActivityEntry): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.doAppendActivity(entry));
    await this.writeQueue;
  }

  private async doAppendActivity(entry: ActivityEntry): Promise<void> {
    const uri = vscode.Uri.joinPath(this.kernalDir, 'activity.jsonl');
    let lines: string[] = [];
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      lines = Buffer.from(bytes).toString('utf8').split('\n').filter(l => l.trim());
    } catch { /* file may not exist yet */ }
    lines.push(JSON.stringify(entry));
    if (lines.length > 1000) lines = lines.slice(-1000);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\n') + '\n', 'utf8'));
  }

  async readActivity(limit = 50): Promise<ActivityEntry[]> {
    const uri = vscode.Uri.joinPath(this.kernalDir, 'activity.jsonl');
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const lines = Buffer.from(bytes).toString('utf8').split('\n').filter(l => l.trim());
      const entries: ActivityEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ActivityEntry);
        } catch { /* ignore malformed lines */ }
      }
      return entries.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
}
