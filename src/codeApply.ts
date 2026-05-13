import * as vscode from 'vscode';
import * as path from 'path';

export interface FileEdit {
  relativePath: string;
  uri: vscode.Uri;
  code: string;
  exists: boolean;
}

// In-memory store for kernal-edit:// virtual documents (diff view).
const proposalStore = new Map<string, string>();
let proposalSeq = 0;

// Call once from activate() to register the virtual document provider.
export function registerProposalProvider(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('kernal-edit', {
      provideTextDocumentContent(uri: vscode.Uri): string {
        return proposalStore.get(uri.path.slice(1)) ?? '';
      },
    })
  );
}

// Returns the content of the largest code fence in output, or the full text if none.
export function extractCode(output: string): string {
  const matches = [...output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (matches.length === 0) return output.trim();
  return matches.reduce((a, b) => (a[1].length >= b[1].length ? a : b))[1];
}

// Parses (file path, code) pairs from AI output.
// Handles the four patterns AI tools typically use:
//   1. ```lang:src/foo.ts    — fence tag with path
//   2. **src/foo.ts**        — bold/backtick line immediately before a fence
//   3. ### src/foo.ts        — heading line immediately before a fence
//   4. // src/foo.ts         — first-line comment inside a fence
export async function parseFileEdits(output: string, workspaceRoot: vscode.Uri): Promise<FileEdit[]> {
  const edits: FileEdit[] = [];
  const seen = new Set<string>();

  async function tryAdd(rawPath: string, code: string): Promise<void> {
    const p = rawPath.trim()
      .replace(/^['"`*]+|['"`*]+$/g, '')
      .replace(/^[./\\]+/, '');
    // Must look like a relative file path with an extension and no dangerous chars.
    if (!p || seen.has(p) || p.includes('..') || /\s/.test(p)) return;
    if (!/\.[a-zA-Z0-9]{1,10}$/.test(p)) return;
    if (!/^[\w][\w.\-/]*$/.test(p)) return;
    seen.add(p);
    const uri = vscode.Uri.joinPath(workspaceRoot, p);
    let exists = false;
    try { await vscode.workspace.fs.stat(uri); exists = true; } catch { /* new file */ }
    edits.push({ relativePath: p, uri, code: code.trimEnd(), exists });
  }

  // Pattern 1: ```lang:path/to/file.ts
  for (const m of output.matchAll(/```[a-z]*:([^\s\n`]+)\n([\s\S]*?)```/g)) {
    await tryAdd(m[1], m[2]);
  }

  // Pattern 2: **path/to/file.ts** or `path/to/file.ts` line directly before a fence
  for (const m of output.matchAll(/(?:^|\n)\*{0,2}`{0,1}([\w][\w.\-/]+\.[a-zA-Z0-9]{1,10})`{0,1}\*{0,2}\n```[^\n]*\n([\s\S]*?)```/g)) {
    await tryAdd(m[1], m[2]);
  }

  // Pattern 3: ## Heading with a file path directly before a fence
  for (const m of output.matchAll(/(?:^|\n)#{1,4}\s+([\w][\w.\-/]+\.[a-zA-Z0-9]{1,10})\s*\n```[^\n]*\n([\s\S]*?)```/g)) {
    await tryAdd(m[1], m[2]);
  }

  // Pattern 4: First-line comment in fence: // path, # path, <!-- path -->
  for (const m of output.matchAll(/```[^\n]*\n(?:\/\/|#|<!--)\s*(?:(?:file|path|source):?\s*)?([\w][\w.\-/]+\.[a-zA-Z0-9]{1,10})[^\n]*\n([\s\S]*?)```/gi)) {
    await tryAdd(m[1], m[2]);
  }

  return edits;
}

// Shows a diff + Apply/Skip notification for each detected file edit.
// Falls back to the active editor when no file paths are detected in the output.
// Falls back to a plain output tab if no editor is open either.
export async function applyCodeEditFlow(
  workflowLabel: string,
  output: string,
  workspaceRoot: vscode.Uri,
  fallbackFile?: vscode.Uri
): Promise<void> {
  let edits = await parseFileEdits(output, workspaceRoot);

  if (edits.length === 0) {
    const target = fallbackFile ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      // Nothing to target — open output as a read-only markdown tab.
      const doc = await vscode.workspace.openTextDocument({ content: output, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    edits = [{
      relativePath: path.basename(target.fsPath),
      uri: target,
      code: extractCode(output),
      exists: true,
    }];
  }

  for (const edit of edits) {
    const key = String(++proposalSeq);
    proposalStore.set(key, edit.code);
    const proposalUri = vscode.Uri.parse(`kernal-edit:/${key}`);

    if (edit.exists) {
      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          edit.uri,
          proposalUri,
          `Kernal: ${workflowLabel} → ${edit.relativePath}`
        );
      } catch { /* binary or unavailable — skip diff */ }
    }

    const action = edit.exists ? 'Apply' : 'Create';
    const choice = await vscode.window.showInformationMessage(
      `Kernal wants to ${action.toLowerCase()} ${edit.relativePath}`,
      { modal: false },
      action,
      'Skip'
    );

    proposalStore.delete(key);

    if (choice === action) {
      if (!edit.exists) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(edit.uri, '..'));
      }
      await vscode.workspace.fs.writeFile(edit.uri, Buffer.from(edit.code + '\n', 'utf8'));
      void vscode.window.showInformationMessage(
        `Kernal: ${edit.exists ? 'updated' : 'created'} ${edit.relativePath}`
      );
    }
  }
}
