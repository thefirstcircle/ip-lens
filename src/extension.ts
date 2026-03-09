import * as vscode from 'vscode';
import { findAddresses, AddressMatch, MatchKind } from './patterns';
import { resolve, clearCache as clearResolverCache, setCacheTTL, setDohProvider, setIpInfoProvider, setLocalDnsResolver, ResolvedInfo } from './resolver';

// ── Decoration types (created in activate) ────────────────────────────────
let underlineDecIPv4: vscode.TextEditorDecorationType;
let underlineDecIPv6: vscode.TextEditorDecorationType;
let underlineDecHostname: vscode.TextEditorDecorationType;
let gutterDec: vscode.TextEditorDecorationType;

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_DECORATIONS = 10_000; // cap to keep editor responsive on large files
const RESOLVE_CONCURRENCY = 8;  // max simultaneous network requests in Resolve All

// ── Batch offset→position conversion (avoids per-match positionAt IPC) ────
function batchPositions(text: string, offsets: number[]): Map<number, vscode.Position> {
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const map = new Map<number, vscode.Position>();
  let line = 0, lineStart = 0, si = 0;
  for (let i = 0; i <= text.length && si < sorted.length; i++) {
    while (si < sorted.length && sorted[si] === i) {
      map.set(sorted[si], new vscode.Position(line, i - lineStart));
      si++;
    }
    if (text[i] === '\n') { line++; lineStart = i + 1; }
  }
  return map;
}

// ── Debounce timers ───────────────────────────────────────────────────────
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function decorateEditorDebounced(editor: vscode.TextEditor) {
  const key = editor.document.uri.toString();
  const existing = debounceTimers.get(key);
  if (existing) { clearTimeout(existing); }
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    decorateEditor(editor);
  }, 300));
}

// ── Per-document match cache ──────────────────────────────────────────────
const docMatches = new Map<string, AddressMatch[]>();

// ── Status bar ────────────────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;

// ── Config helpers ────────────────────────────────────────────────────────
function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('ipLens').get<T>(key) as T;
}

function isActiveLanguage(langId: string): boolean {
  const langs = cfg<string[]>('activateOnLanguages');
  return langs.includes(langId) || langs.includes('*');
}

// ── Country flag emoji from ISO 3166-1 alpha-2 code ───────────────────────
function flagEmoji(code?: string): string {
  if (!code || code.length !== 2) { return '🌐'; }
  const offset = 0x1f1e6 - 65;
  return (
    String.fromCodePoint(code.charCodeAt(0) + offset) +
    String.fromCodePoint(code.charCodeAt(1) + offset)
  );
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Apply decorations to an editor ────────────────────────────────────────
function decorateEditor(editor: vscode.TextEditor) {
  const { document } = editor;
  if (!isActiveLanguage(document.languageId)) {
    editor.setDecorations(underlineDecIPv4, []);
    editor.setDecorations(underlineDecIPv6, []);
    editor.setDecorations(underlineDecHostname, []);
    editor.setDecorations(gutterDec, []);
    return;
  }

  const text = document.getText();
  const allMatches = findAddresses(text);
  const truncated = allMatches.length > MAX_DECORATIONS;
  const matches = truncated ? allMatches.slice(0, MAX_DECORATIONS) : allMatches;
  docMatches.set(document.uri.toString(), matches);

  const offsets = matches.flatMap(m => [m.start, m.end]);
  const posMap = batchPositions(text, offsets);

  const rangesIPv4: vscode.DecorationOptions[] = [];
  const rangesIPv6: vscode.DecorationOptions[] = [];
  const rangesHostname: vscode.DecorationOptions[] = [];
  const gutterLines = new Set<number>();

  for (const m of matches) {
    const start = posMap.get(m.start)!;
    const end = posMap.get(m.end)!;
    const decoration = { range: new vscode.Range(start, end) };
    if (m.kind === 'ipv4') { rangesIPv4.push(decoration); }
    else if (m.kind === 'ipv6') { rangesIPv6.push(decoration); }
    else { rangesHostname.push(decoration); }
    gutterLines.add(start.line);
  }

  editor.setDecorations(underlineDecIPv4, rangesIPv4);
  editor.setDecorations(underlineDecIPv6, rangesIPv6);
  editor.setDecorations(underlineDecHostname, rangesHostname);

  if (cfg<boolean>('enableGutterIcon')) {
    const gutterRanges = Array.from(gutterLines).map(
      (line) => new vscode.Range(line, 0, line, 0)
    );
    editor.setDecorations(gutterDec, gutterRanges);
  } else {
    editor.setDecorations(gutterDec, []);
  }

  // Update status bar if this is the active editor
  if (editor === vscode.window.activeTextEditor) {
    updateStatusBar(matches.length, truncated ? allMatches.length : undefined);
  }
}

function updateStatusBar(shown: number, total?: number) {
  if (shown > 0) {
    const truncated = total !== undefined && total > shown;
    statusBarItem.text = truncated
      ? `$(globe) ${shown} of ${total} IPs`
      : `$(globe) ${shown} IP${shown !== 1 ? 's' : ''}`;
    statusBarItem.tooltip = truncated
      ? `IP Lens: showing first ${shown} of ${total} addresses — file too large for full decoration`
      : 'IP Lens: Run "Resolve All IPs in File" to inspect';
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
}

// ── Hover content builder ─────────────────────────────────────────────────
function buildHoverContent(
  info: ResolvedInfo,
  address: string,
  kind: MatchKind
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;

  const kindLabel = kind === 'ipv4' ? 'IPv4' : kind === 'ipv6' ? 'IPv6' : 'Hostname';
  md.appendMarkdown(`**IP Lens** — ${kindLabel}\n\n`);
  md.appendMarkdown(`\`${address}\`\n\n`);

  if (info.isPrivate) {
    md.appendMarkdown(`$(lock) **Private** — ${info.privateKind ?? 'RFC 1918'}\n\n`);
  }

  if (info.error && !info.isPrivate) {
    md.appendMarkdown(`$(warning) _${info.error}_\n`);
    if (info.resolvedVia) {
      md.appendMarkdown(`\n---\n_via ${info.resolvedVia}_\n`);
    }
    return md;
  }

  const rows: [string, string][] = [];

  if (info.ptr) {
    rows.push(['PTR / Hostname', `\`${info.ptr}\``]);
  }
  if (info.asn) {
    rows.push(['ASN', info.asn]);
  }
  if (info.org) {
    rows.push(['Org', info.org]);
  }
  if (info.isp && info.isp !== info.org) {
    rows.push(['ISP', info.isp]);
  }
  if (info.countryName) {
    const prefix = info.country ? `[${info.country}]` : '';
    const loc = [prefix, info.countryName, info.region, info.city]
      .filter(Boolean)
      .join(' ');
    rows.push(['Location', loc]);
  }
  if (info.cloudProvider) {
    rows.push(['Cloud', `$(cloud) ${info.cloudProvider}`]);
  }

  if (rows.length > 0) {
    md.appendMarkdown('\n| | |\n|:--|:--|\n');
    for (const [k, v] of rows) {
      md.appendMarkdown(`| **${k}** | ${v} |\n`);
    }
  } else if (info.isPrivate) {
    md.appendMarkdown('_No external info available for private addresses._\n');
  }

  if (info.resolvedVia) {
    md.appendMarkdown(`\n---\n_via ${info.resolvedVia}_\n`);
  }

  return md;
}

// ── Hover provider ────────────────────────────────────────────────────────
class IpLensHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const matches = docMatches.get(document.uri.toString());
    if (!matches?.length) { return undefined; }

    const offset = document.offsetAt(position);
    const match = matches.find((m) => offset >= m.start && offset < m.end);
    if (!match) { return undefined; }

    const range = new vscode.Range(
      document.positionAt(match.start),
      document.positionAt(match.end)
    );

    const info = await resolve(match.value, match.kind);
    return new vscode.Hover(buildHoverContent(info, match.value, match.kind), range);
  }
}


// ── Resolve All panel ─────────────────────────────────────────────────────
async function resolveAllPanel(editor: vscode.TextEditor) {
  const uri = editor.document.uri.toString();
  const matches = docMatches.get(uri);

  if (!matches?.length) {
    vscode.window.showInformationMessage('IP Lens: No IPs or hostnames found in this file.');
    return;
  }

  const sourceDocument = editor.document;

  const panel = vscode.window.createWebviewPanel(
    'ipLensResults',
    'IP Lens: Resolve All',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  // Deduplicate before resolving — no point resolving the same IP 500 times
  const seen = new Set<string>();
  const uniqueMatches = matches.filter(m => {
    if (seen.has(m.value)) { return false; }
    seen.add(m.value);
    return true;
  });

  panel.webview.html = buildLoadingHtml(uniqueMatches.length);

  // Resolve in batches to avoid exhausting the network / hitting rate limits
  const unique: Array<{ match: AddressMatch; info: ResolvedInfo }> = [];
  for (let i = 0; i < uniqueMatches.length; i += RESOLVE_CONCURRENCY) {
    const batch = uniqueMatches.slice(i, i + RESOLVE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async m => ({ match: m, info: await resolve(m.value, m.kind) }))
    );
    unique.push(...batchResults);
  }

  panel.webview.html = buildResultsHtml(unique);

  // Reveal + select the match in the source editor when a row is clicked
  panel.webview.onDidReceiveMessage(async (msg: { start: number; end: number }) => {
    const targetEditor = await vscode.window.showTextDocument(
      sourceDocument,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true }
    );
    const start = targetEditor.document.positionAt(msg.start);
    const end = targetEditor.document.positionAt(msg.end);
    targetEditor.selection = new vscode.Selection(start, end);
    targetEditor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
}

function buildLoadingHtml(count: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:20px">
  <h2>Resolving ${count} address${count !== 1 ? 'es' : ''}…</h2>
  <p>Please wait.</p>
</body></html>`;
}

function buildResultsHtml(
  results: Array<{ match: AddressMatch; info: ResolvedInfo }>
): string {
  const rows = results
    .map(({ match, info }) => {
      const flag = info.country ? flagEmoji(info.country) : '🌐';
      const ptr = info.ptr ?? (info.isPrivate ? '(private)' : '—');
      const org = info.org ?? '—';
      const asn = info.asn ?? '—';
      const locParts = [info.countryName, info.region, info.city].filter(Boolean);
      const location = locParts.length
        ? `${flag} ${locParts.join(', ')}`
        : info.isPrivate
        ? '—'
        : '—';
      const cloud = info.cloudProvider ? `☁️ ${info.cloudProvider}` : '—';
      const errorCell = info.error && !info.isPrivate
        ? `<span class="err">⚠ ${escHtml(info.error)}</span>`
        : escHtml(ptr);
      const kindClass = match.kind;
      const kindLabel =
        match.kind === 'ipv4' ? 'IPv4' : match.kind === 'ipv6' ? 'IPv6' : 'Host';

      return `<tr data-start="${match.start}" data-end="${match.end}">
        <td><code>${escHtml(match.value)}</code></td>
        <td><span class="badge ${kindClass}">${kindLabel}</span></td>
        <td>${errorCell}</td>
        <td>${escHtml(asn)}</td>
        <td>${escHtml(org)}</td>
        <td>${location}</td>
        <td>${cloud}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 13px;
    padding: 16px 20px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }
  h2 { font-size: 1.1em; margin-bottom: 14px; opacity: .85; }
  table { border-collapse: collapse; width: 100%; }
  th {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 2px solid var(--vscode-panel-border, #444);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .05em;
    opacity: .7;
    white-space: nowrap;
  }
  td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
    vertical-align: middle;
  }
  tbody tr { cursor: pointer; }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }
  tbody tr.active td { background: var(--vscode-list-activeSelectionBackground, rgba(100,160,255,.15)); }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .04em;
  }
  .ipv4   { background: #1a4080; color: #9ecfff; }
  .ipv6   { background: #1e3a1a; color: #9fda80; }
  .hostname { background: #3a2a10; color: #ffb870; }
  .err { color: var(--vscode-errorForeground, #f48771); }
</style>
</head>
<body>
<h2>🌐 IP Lens — ${results.length} unique address${results.length !== 1 ? 'es' : ''} resolved</h2>
<table>
  <thead>
    <tr>
      <th>Address</th>
      <th>Type</th>
      <th>PTR / Resolved</th>
      <th>ASN</th>
      <th>Organization</th>
      <th>Location</th>
      <th>Cloud</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelector('tbody').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-start]');
    if (!row) return;
    document.querySelectorAll('tbody tr.active').forEach(r => r.classList.remove('active'));
    row.classList.add('active');
    vscode.postMessage({ start: Number(row.dataset.start), end: Number(row.dataset.end) });
  });
</script>
</body>
</html>`;
}

// ── Extension lifecycle ───────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  setCacheTTL(cfg<number>('cacheTTLSeconds'));
  setDohProvider(cfg<string>('dnsProvider'));
  setIpInfoProvider(cfg<string>('ipInfoProvider'));
  setLocalDnsResolver(cfg<string>('localDnsResolver') ?? '');

  underlineDecIPv4 = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline dotted rgba(100, 160, 255, 0.7) 1.5px',
    cursor: 'pointer',
  });
  underlineDecIPv6 = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline dotted rgba(100, 220, 130, 0.7) 1.5px',
    cursor: 'pointer',
  });
  underlineDecHostname = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline dotted rgba(255, 180, 100, 0.7) 1.5px',
    cursor: 'pointer',
  });

  gutterDec = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath('images/gutter.svg'),
    gutterIconSize: '65%',
  });

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ipLens.resolveAll';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    // Hover — all file-based documents
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new IpLensHoverProvider()),
    vscode.languages.registerHoverProvider({ scheme: 'untitled' }, new IpLensHoverProvider()),

    // Commands
    vscode.commands.registerCommand('ipLens.resolveAll', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) { resolveAllPanel(editor); }
    }),

    vscode.commands.registerCommand('ipLens.clearCache', () => {
      clearResolverCache();
      vscode.window.showInformationMessage('IP Lens: Cache cleared.');
      vscode.window.visibleTextEditors.forEach(decorateEditor);
    }),

    // Re-decorate when switching editors or editing text
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) { decorateEditor(editor); }
    }),

    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.visibleTextEditors.find(
        (ed) => ed.document === e.document
      );
      if (editor) { decorateEditorDebounced(editor); }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ipLens')) {
        setCacheTTL(cfg<number>('cacheTTLSeconds'));
        setDohProvider(cfg<string>('dnsProvider'));
        setIpInfoProvider(cfg<string>('ipInfoProvider'));
        setLocalDnsResolver(cfg<string>('localDnsResolver') ?? '');
        clearResolverCache(); // stale results from old provider are invalid
        vscode.window.visibleTextEditors.forEach(decorateEditor);
      }
    })
  );

  // Decorate all editors already open at activation time
  vscode.window.visibleTextEditors.forEach(decorateEditor);
}

export function deactivate() {
  underlineDecIPv4?.dispose();
  underlineDecIPv6?.dispose();
  underlineDecHostname?.dispose();
  gutterDec?.dispose();
}
