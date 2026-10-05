import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Session } from './session';
import { conflicts, contains } from './policy';

let sessions = new Map<string, Session>();
let queue = Promise.resolve();
let output: vscode.LogOutputChannel;
let context: vscode.ExtensionContext;
async function reconcile(): Promise<void> {
  const wanted = new Map<string, {folder?: vscode.WorkspaceFolder, selector: vscode.DocumentSelector}>();
  const folders = [...(vscode.workspace.workspaceFolders ?? [])].filter(f => f.uri.scheme === 'file');
  const roots = await Promise.all(folders.map(async f => {
    try {return await fs.realpath(path.join(f.uri.fsPath, 'src'));}
    catch {return path.resolve(f.uri.fsPath, 'src');}
  }));
  const rejected = conflicts(roots);
  if (vscode.workspace.isTrusted && process.platform === 'linux' && process.arch === 'x64' && !vscode.env.remoteName) {
    folders.forEach((folder, i) => {
      if (!rejected.has(i)) wanted.set(folder.uri.toString(), {folder,
        selector: [{language: 'mognitio', scheme: 'file', pattern: new vscode.RelativePattern(folder, 'src/**/*.mgn')}]});
    });
    const rootless = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && d.languageId === 'mognitio'
      && !folders.some(f => contains(path.join(f.uri.fsPath, 'src'), d.uri.fsPath)));
    if (rootless.length) {
      const uris = rootless.map(d => d.uri.toString()).sort();
      wanted.set('rootless:' + uris.join('|'), {selector: rootless.map(d => ({
        language: 'mognitio', scheme: 'file',
        pattern: new vscode.RelativePattern(path.dirname(d.uri.fsPath), path.basename(d.uri.fsPath).replace(/[?*[\]{}]/g, '[$&]'))
      }))});
    }
  }
  if (rejected.size) output.warn('Overlapping source roots: project analysis is disabled for all conflicting folders.');
  while (wanted.size > 4) {
    const key = [...wanted.keys()].pop()!;
    wanted.delete(key);
    output.warn('The four-session / 4 GiB window budget is reached. Additional sessions were not started.');
  }
  for (const [key, session] of sessions) if (!wanted.has(key)) {sessions.delete(key); await session.stop();}
  let expected: string | undefined;
  if (context.extensionMode !== vscode.ExtensionMode.Production && process.env.MOGNITIO_EXPECTED_IDENTITY) {
    expected = JSON.parse(await fs.readFile(process.env.MOGNITIO_EXPECTED_IDENTITY, 'utf8')).version;
  }
  for (const [key, config] of wanted) if (!sessions.has(key)) {
    const session = new Session(key, config.folder, config.selector, output, expected);
    sessions.set(key, session);
    try {await session.start();}
    catch (error) {
      output.error(String(error));
      await session.stop();
      void vscode.window.showWarningMessage('Mognitio: ' + String(error));
    }
  }
}
function schedule(): void {queue = queue.then(reconcile).catch(e => output.error(String(e)));}
export function activate(extensionContext: vscode.ExtensionContext): void {
  context = extensionContext;
  output = vscode.window.createOutputChannel('Mognitio', {log: true});
  context.subscriptions.push(output,
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.workspace.onDidGrantWorkspaceTrust(schedule),
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument(() => {sessions.forEach(s => s.restoreManifest()); schedule();}),
    vscode.workspace.onDidChangeTextDocument(() => {sessions.forEach(s => s.restoreManifest());}),
    vscode.workspace.onDidSaveTextDocument(() => {sessions.forEach(s => s.restoreManifest());}),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('mognitio.serverPath')) void restart();
      else if (e.affectsConfiguration('editor.semanticHighlighting')) sessions.forEach(s => s.invalidate());
    }),
    vscode.commands.registerCommand('mognitio.restartServer', restart));
  schedule();
}
async function restart(): Promise<void> {
  queue = queue.then(async () => {
    await Promise.all([...sessions.values()].map(s => s.stop()));
    sessions.clear(); await reconcile();
  });
  await queue;
}
export async function deactivate(): Promise<void> {
  await queue;
  await Promise.all([...sessions.values()].map(s => s.stop()));
  sessions.clear();
}
