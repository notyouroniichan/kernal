import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { TeamContext } from './teamContext';
import { WorkflowRunner } from './workflowRunner';
import { DetectedTool, routeTask } from './toolDetector';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type WebviewMessage =
  | { type: 'send'; text: string }
  | { type: 'clear' };

export class ChatPanel {
  static currentPanel: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private history: ChatMessage[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: TeamContext,
    private readonly runner: WorkflowRunner,
    private readonly getTools: () => DetectedTool[]
  ) {
    this.panel = panel;
    panel.webview.html = this.getHtml();
    panel.onDidDispose(() => { ChatPanel.currentPanel = undefined; });
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.handleMessage(msg));
    void this.pushStatusUpdate();
  }

  static createOrShow(
    context: TeamContext,
    runner: WorkflowRunner,
    getTools: () => DetectedTool[]
  ): void {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kernalChat',
      'Kernal Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatPanel.currentPanel = new ChatPanel(panel, context, runner, getTools);
  }

  // Called externally when tool detection runs so the badge updates.
  updateStatus(): void {
    void this.pushStatusUpdate();
  }

  private async pushStatusUpdate(): Promise<void> {
    const preferred = vscode.workspace.getConfiguration('kernal').get<string>('preferredTool', 'auto');
    const tool = routeTask(this.getTools(), 'chat', preferred);
    const hasSkill = await this.context.hasRootSkill();
    await this.panel.webview.postMessage({ type: 'toolUpdate', tool: tool?.name ?? 'No tool found' });
    await this.panel.webview.postMessage({ type: 'skillUpdate', hasSkill });
  }

  private static readonly MAX_MESSAGE_BYTES = 100_000;

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    if (msg.type === 'clear') {
      this.history = [];
      return;
    }
    if (msg.type !== 'send' || !msg.text) return;

    if (msg.text.length > ChatPanel.MAX_MESSAGE_BYTES) {
      await this.panel.webview.postMessage({
        type: 'error',
        text: `Message too large (${msg.text.length.toLocaleString()} chars). Keep it under ${ChatPanel.MAX_MESSAGE_BYTES.toLocaleString()} characters.`,
      });
      return;
    }

    const VALID_TOOLS = new Set(['auto', 'claude-code', 'codex', 'copilot', 'claude-web']);
    const rawTool = vscode.workspace.getConfiguration('kernal').get<string>('preferredTool');
    const preferred = (typeof rawTool === 'string' && VALID_TOOLS.has(rawTool)) ? rawTool : 'auto';
    const tool = routeTask(this.getTools(), 'chat', preferred);
    if (!tool) {
      await this.panel.webview.postMessage({ type: 'error', text: 'No AI tools available. Run "Kernal: Detect Available AI Tools" first.' });
      return;
    }

    const userMessage = msg.text;
    this.history.push({ role: 'user', content: userMessage });

    // Build conversation payload — cap at last 20 turns to keep prompts manageable.
    const historyText = this.history
      .slice(-21, -1)  // up to 20 prior turns, exclude just-added user message
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const taskPrompt = 'You are a helpful AI teammate for this project. Continue the conversation below, following the PROJECT SKILL and context above.';
    const payload = historyText
      ? `${historyText}\n\nUser: ${userMessage}`
      : `User: ${userMessage}`;

    const fullPrompt = await this.runner.assemblePrompt(taskPrompt, payload);

    if (tool.invokeMethod === 'manual') {
      // claude-web: copy + open browser, no streaming possible
      const result = await this.runner.invoke(tool, 'chat', fullPrompt);
      await this.panel.webview.postMessage({ type: 'info', text: result.output ?? 'Prompt copied to clipboard.' });
      this.history.push({ role: 'assistant', content: '(sent to claude.ai via clipboard)' });
      return;
    }

    // CLI tools: stream chunks progressively into the panel.
    let accumulated = '';
    const result = await this.runner.invoke(tool, 'chat', fullPrompt, (chunk) => {
      accumulated += chunk;
      void this.panel.webview.postMessage({ type: 'chunk', text: chunk });
    });

    if (result.ok) {
      this.history.push({ role: 'assistant', content: accumulated || (result.output ?? '') });
      // Signal end-of-stream so the panel finalises the message bubble.
      await this.panel.webview.postMessage({ type: 'streamEnd' });
    } else {
      await this.panel.webview.postMessage({ type: 'error', text: result.error ?? 'Unknown error' });
    }
  }

  private getHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Kernal Chat</title>
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0; padding: 0;
      height: 100vh;
      display: flex; flex-direction: column;
    }
    #header {
      padding: 6px 12px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--vscode-sideBarSectionHeader-foreground);
    }
    #tool-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 7px; border-radius: 10px;
      font-size: 10px; font-weight: normal; letter-spacing: 0;
      text-transform: none;
    }
    #skill-indicator {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      font-weight: normal; letter-spacing: 0; text-transform: none;
    }
    #messages {
      flex: 1; overflow-y: auto;
      padding: 12px; display: flex; flex-direction: column; gap: 10px;
    }
    .msg {
      padding: 8px 11px; border-radius: 4px;
      line-height: 1.55; white-space: pre-wrap; word-break: break-word;
    }
    .msg.user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      align-self: flex-end; max-width: 82%;
    }
    .msg.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground);
      align-self: flex-start; width: 100%;
    }
    .msg.assistant.streaming { opacity: 0.85; }
    .msg.system {
      color: var(--vscode-descriptionForeground);
      font-size: 11px; text-align: center;
      background: transparent; padding: 2px;
    }
    .msg.error {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .cursor {
      display: inline-block; width: 7px; height: 1em;
      background: var(--vscode-foreground); vertical-align: text-bottom;
      animation: blink 0.9s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    #input-area {
      padding: 8px 10px 10px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      display: flex; flex-direction: column; gap: 6px;
    }
    #msg-input {
      width: 100%; min-height: 58px; max-height: 160px; resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 6px 8px; font-family: inherit; font-size: inherit;
      border-radius: 3px; outline: none;
    }
    #msg-input:focus { border-color: var(--vscode-focusBorder); }
    #msg-input:disabled { opacity: 0.55; }
    #actions { display: flex; gap: 6px; justify-content: space-between; align-items: center; }
    #hint { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 4px 14px; cursor: pointer;
      font-size: 12px; border-radius: 2px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.sec {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn.sec:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:disabled { opacity: 0.45; cursor: default; pointer-events: none; }
  </style>
</head>
<body>
  <div id="header">
    Kernal Chat
    <span id="tool-badge">—</span>
    <span id="skill-indicator"></span>
  </div>
  <div id="messages">
    <div class="msg system">SKILL.md + team context is automatically included in every message. Type below to start.</div>
  </div>
  <div id="input-area">
    <textarea id="msg-input" placeholder="Ask anything… (Cmd/Ctrl+Enter to send)"></textarea>
    <div id="actions">
      <span id="hint">Cmd+Enter to send</span>
      <div style="display:flex;gap:6px">
        <button class="btn sec" id="clear-btn">Clear</button>
        <button class="btn" id="send-btn">Send</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl   = document.getElementById('msg-input');
    const sendBtn   = document.getElementById('send-btn');
    const clearBtn  = document.getElementById('clear-btn');
    const toolBadge = document.getElementById('tool-badge');
    const skillEl   = document.getElementById('skill-indicator');
    const hintEl    = document.getElementById('hint');

    let streaming = null; // current streaming bubble

    function scrollBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addMsg(cls, text) {
      const d = document.createElement('div');
      d.className = 'msg ' + cls;
      d.textContent = text;
      messagesEl.appendChild(d);
      scrollBottom();
      return d;
    }

    function setLoading(on) {
      sendBtn.disabled = on;
      inputEl.disabled = on;
      sendBtn.textContent = on ? 'Sending…' : 'Send';
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      addMsg('user', text);
      inputEl.value = '';
      setLoading(true);
      streaming = null;
      vscode.postMessage({ type: 'send', text });
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
    clearBtn.addEventListener('click', () => {
      // keep only the first system message
      while (messagesEl.children.length > 1) messagesEl.removeChild(messagesEl.lastChild);
      streaming = null;
      vscode.postMessage({ type: 'clear' });
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      switch (msg.type) {
        case 'chunk':
          if (!streaming) {
            streaming = document.createElement('div');
            streaming.className = 'msg assistant streaming';
            const cursor = document.createElement('span');
            cursor.className = 'cursor';
            streaming.appendChild(cursor);
            messagesEl.appendChild(streaming);
          }
          // insert text before the blinking cursor
          streaming.insertBefore(document.createTextNode(msg.text), streaming.lastChild);
          scrollBottom();
          break;
        case 'streamEnd':
          if (streaming) {
            streaming.classList.remove('streaming');
            streaming.removeChild(streaming.lastChild); // remove cursor
            streaming = null;
          }
          setLoading(false);
          break;
        case 'response':
          setLoading(false);
          if (streaming) {
            streaming.classList.remove('streaming');
            streaming.removeChild(streaming.lastChild);
            streaming = null;
          } else {
            addMsg('assistant', msg.text);
          }
          break;
        case 'info':
          setLoading(false);
          streaming = null;
          addMsg('system', msg.text);
          break;
        case 'error':
          setLoading(false);
          streaming = null;
          addMsg('error', msg.text);
          break;
        case 'toolUpdate':
          toolBadge.textContent = msg.tool;
          break;
        case 'skillUpdate':
          skillEl.textContent = msg.hasSkill ? '📖 SKILL.md' : '';
          break;
      }
    });

    // detect OS for hint
    if (!navigator.platform.includes('Mac')) hintEl.textContent = 'Ctrl+Enter to send';

    window.onerror = (_msg, _src, _line, _col, err) => {
      setLoading(false);
      addMsg('error', 'Panel error: ' + (err ? err.message : 'unknown'));
    };
    window.addEventListener('unhandledrejection', e => {
      setLoading(false);
      addMsg('error', 'Panel error: ' + (e.reason?.message ?? String(e.reason)));
    });
  </script>
</body>
</html>`;
  }
}
