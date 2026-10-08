import type { DocumentSelector } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Session } from './session';
import { conflicts, contains, unsupportedEnvironment } from './policy';

let sessions = new Map<string, Session>();
let queue = Promise.resolve();
let output: vscode.LogOutputChannel;
let context: vscode.ExtensionContext;
let reportedEnvironment: string | undefined;
let reportedBudget = '';
let reportedConflicts = '';
async function reconcile(): Promise<void> {
  const wanted = new Map<string, {folder?: vscode.WorkspaceFolder, selector: DocumentSelector, documents?: readonly vscode.TextDocument[]}>();
  const folders = [...(vscode.workspace.workspaceFolders ?? [])].filter(f => f.uri.scheme === 'file');
  const roots = await Promise.all(folders.map(async f => {
    try {return await fs.realpath(path.join(f.uri.fsPath, 'src'));}
    catch {return path.resolve(f.uri.fsPath, 'src');}
  }));
  const rejected = conflicts(roots);
  const environment = unsupportedEnvironment(process.platform, process.arch, vscode.env.remoteName);
  if (environment !== reportedEnvironment) {
    if (environment) output.warn(environment + ' Only lexical highlighting is available.');
    reportedEnvironment = environment;
  }
  if (vscode.workspace.isTrusted && !environment) {
    folders.forEach((folder, i) => {
      if (!rejected.has(i)) wanted.set(folder.uri.toString(), {folder,
        selector: [{language: 'mognitio', scheme: 'file', pattern: {baseUri: folder.uri.toString(), pattern: 'src/**/*.mgn'}}]});
    });
    const rootless = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && d.languageId === 'mognitio'
      && !folders.some(f => contains(path.join(f.uri.fsPath, 'src'), d.uri.fsPath)));
    if (rootless.length) wanted.set('rootless', {selector: [], documents: rootless});
  }
  const conflictState = [...rejected].map(i => folders[i].uri.toString() + ' -> ' + roots[i]).sort().join('; ');
  if (conflictState && conflictState !== reportedConflicts) output.warn(
    'Overlapping source roots (equal or containing another source root): ' + conflictState +
    '. Project analysis is disabled for these folders. Remove a conflicting folder or use independent source roots.');
  reportedConflicts = conflictState;
  const skipped = [...wanted.entries()].slice(4);
  const budget = skipped.map(([key, config]) => config.folder
    ? 'workspace ' + config.folder.uri.toString()
    : 'standalone files: ' + config.documents!.map(d => d.uri.toString()).sort().join(', ')).join('; ');
  if (budget && budget !== reportedBudget) output.warn(
    'The four-session / 4 GiB window budget is reached. Not started: ' + budget +
    '. Workspace folder order is used, followed by standalone files. Close a workspace folder to free a slot.');
  reportedBudget = budget;
  skipped.forEach(([key]) => wanted.delete(key));
  for (const [key, session] of sessions) if (!wanted.has(key)) {sessions.delete(key); await session.stop();}
  // Release old ownership before a newly admitted project can open the same file.
  for (const [key, config] of wanted) {
    if (config.documents) await sessions.get(key)?.setRootlessDocuments(config.documents);
  }
  let expected: string | undefined;
  if (context.extensionMode !== vscode.ExtensionMode.Production && process.env.MOGNITIO_EXPECTED_IDENTITY) {
    expected = JSON.parse(await fs.readFile(process.env.MOGNITIO_EXPECTED_IDENTITY, 'utf8')).version;
  }
  for (const [key, config] of wanted) if (!sessions.has(key)) {
    const session = new Session(key, config.folder, config.selector, output, expected);
    sessions.set(key, session);
    try {
      await session.start();
      if (config.documents) await session.setRootlessDocuments(config.documents);
    }
    catch (error) {
      output.error(String(error));
      await session.stop();
      void showLaunchFailure(error).catch(e => output.error(String(e)));
    }
  }
}
async function showLaunchFailure(error: unknown): Promise<void> {
  const choice = await vscode.window.showWarningMessage('Mognitio: ' + String(error), 'Installation Guide', 'Open Settings');
  if (choice === 'Installation Guide') await vscode.env.openExternal(vscode.Uri.parse('https://github.com/ProjectCuriositas/Mognitio#readme'));
  else if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'mognitio.serverPath');
}
function schedule(): void {queue = queue.then(reconcile).catch(e => output.error(String(e)));}
export function activate(extensionContext: vscode.ExtensionContext): void {
  context = extensionContext;
  output = vscode.window.createOutputChannel('Mognitio', {log: true});
  context.subscriptions.push(output,
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.workspace.onDidGrantWorkspaceTrust(schedule),
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument(doc => {sessions.forEach(s => {void s.restoreManifest(doc.uri);}); schedule();}),
    vscode.workspace.onDidChangeTextDocument(event => {sessions.forEach(s => {void s.restoreManifest(event.document.uri);});}),
    vscode.workspace.onDidSaveTextDocument(doc => {sessions.forEach(s => {void s.restoreManifest(doc.uri);});}),
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
