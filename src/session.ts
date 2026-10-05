import type { DocumentSelector } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import {
  LanguageClient, InitializeParams, ErrorAction, CloseAction, State,
  SemanticTokensRegistrationType, SemanticTokensRefreshRequest
} from 'vscode-languageclient/node';
import { compatibleVersion, compatibleCapabilities } from './policy';

const execute = promisify(execFile);
class Client extends LanguageClient {
  folder?: vscode.WorkspaceFolder;
  protected fillInitializeParams(params: InitializeParams): void {
    super.fillInitializeParams(params);
    params.processId = process.pid;
    params.rootUri = this.folder?.uri.toString() ?? null;
    params.workspaceFolders = this.folder ? [{uri: this.folder.uri.toString(), name: this.folder.name}] : null;
  }
}
export async function executable(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('mognitio').get<string>('serverPath', '').trim();
  if (configured && !path.isAbsolute(configured)) throw new Error('mognitio.serverPath must be absolute.');
  const candidates = configured ? [configured] :
    (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'mognitio-lsp'));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch { /* Inspect the next PATH candidate. */ }
  }
  throw new Error(configured ? 'Server is not executable: ' + configured : 'mognitio-lsp is not installed on PATH.');
}
export class Session {
  client?: Client;
  child?: ChildProcess;
  generation = 0;
  epoch = 0;
  stopped = false;
  cache = new Map<string, readonly vscode.Diagnostic[]>();
  private watchers: vscode.Disposable[] = [];
  private cancellations = new Set<NodeJS.Timeout>();
  constructor(
    readonly key: string,
    readonly folder: vscode.WorkspaceFolder | undefined,
    readonly selector: DocumentSelector,
    readonly output: vscode.LogOutputChannel,
    readonly expected: string | undefined,
  ) {}
  private refresh(): void {
    if (!this.client || this.client.state !== State.Running) return;
    const providers = new Set(vscode.workspace.textDocuments.map(d =>
      this.client!.getFeature(SemanticTokensRegistrationType.method).getProvider(d)));
    providers.forEach(provider => provider?.onDidChangeSemanticTokensEmitter.fire());
  }
  invalidate(): void {if (!this.stopped) {this.generation++; this.refresh();}}
  manifest(uri: vscode.Uri): boolean {
    return !!this.folder && uri.fsPath === path.join(this.folder.uri.fsPath, 'mognitio.toml');
  }
  restoreManifest(): void {
    if (!this.client) return;
    for (const [uri, diagnostics] of this.cache) {
      const parsed = vscode.Uri.parse(uri);
      if (!this.manifest(parsed)) continue;
      const dirty = vscode.workspace.textDocuments.some(d => d.uri.toString() === uri && d.isDirty);
      this.client.diagnostics?.set(parsed, dirty ? [] : diagnostics);
    }
  }
  async start(): Promise<void> {
    const command = await executable();
    this.output.info('Selected language server: ' + command);
    const {stdout} = await execute(command, ['--version'], {timeout: 10000, maxBuffer: 4096});
    const match = /^mognitio-lsp ([^\r\n]+)\n$/.exec(stdout);
    if (!match || !compatibleVersion(match[1], this.expected)) throw new Error('Incompatible server at ' + command + ': ' + stdout.trim());
    const epoch = ++this.epoch;
    const client = new Client('mognitio:' + this.key, 'Mognitio', async () => {
      const child = spawn(command, ['--stdio'], {detached: true, stdio: 'pipe', shell: false});
      this.child = child;
      return {process: child, detached: true};
    }, {
      documentSelector: this.selector,
      workspaceFolder: this.folder,
      outputChannel: this.output,
      diagnosticCollectionName: 'Mognitio',
      initializationFailedHandler: () => false,
      errorHandler: {
        error: () => ({action: ErrorAction.Shutdown}),
        closed: () => {
          if (this.stopped) return {action: CloseAction.DoNotRestart};
          this.generation++;
          this.cache.clear();
          void this.stop();
          void vscode.window.showWarningMessage('Mognitio server stopped. Use Restart Language Server after resolving the cause.');
          return {action: CloseAction.DoNotRestart};
        }
      },
      middleware: {
        didOpen: async (doc, next) => {this.invalidate(); await next(doc);},
        didChange: async (event, next) => {this.invalidate(); await next(event);},
        didClose: async (doc, next) => {this.invalidate(); await next(doc);},
        handleDiagnostics: (uri, diagnostics, next) => {
          if (this.stopped || epoch !== this.epoch) return;
          this.cache.set(uri.toString(), diagnostics);
          const dirty = this.manifest(uri) && vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
          next(uri, dirty ? [] : diagnostics);
        },
        provideDocumentSemanticTokens: async (document, token, next) => {
          const generation = this.generation, version = document.version;
          let watchdog: NodeJS.Timeout | undefined;
          const cancellation = token.onCancellationRequested(() => {
            watchdog = setTimeout(() => {void this.stop();}, 3000);
            this.cancellations.add(watchdog);
          });
          try {
            const result = await next(document, token);
            if (this.stopped || epoch !== this.epoch || generation !== this.generation ||
                version !== document.version || token.isCancellationRequested) return null;
            return result;
          } finally {
            cancellation.dispose();
            if (watchdog) {clearTimeout(watchdog); this.cancellations.delete(watchdog);}
          }
        }
      }
    });
    client.folder = this.folder;
    this.client = client;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([client.start(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Language server startup timed out.')), 10000);
      })]);
      const result = client.initializeResult;
      if (!result || result.serverInfo?.version !== match[1] ||
          !compatibleVersion(result.serverInfo?.version, this.expected) ||
          !compatibleCapabilities(result.capabilities)) throw new Error('Language server identity or required capabilities do not match.');
    } catch (error) {
      await this.stop();
      throw error;
    } finally {if (timer) clearTimeout(timer);}
    this.watchers.push(client.onRequest(SemanticTokensRefreshRequest.type, async () => {
      this.invalidate();
    }));
    if (this.folder) {
      for (const glob of ['src/**/*', 'mognitio.toml']) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, glob));
        const changed = async (uri: vscode.Uri, type: number) => {
          if (this.stopped) return;
          this.invalidate();
          await client.sendNotification('workspace/didChangeWatchedFiles', {changes: [{uri: uri.toString(), type}]});
        };
        this.watchers.push(watcher, watcher.onDidCreate(u => {void changed(u, 1);}),
          watcher.onDidChange(u => {void changed(u, 2);}), watcher.onDidDelete(u => {void changed(u, 3);}));
      }
    }
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; ++this.epoch; this.cache.clear();
    this.watchers.forEach(w => w.dispose());
    this.cancellations.forEach(clearTimeout);
    const child = this.child;
    let timer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {process.kill(-child.pid, 'SIGKILL');} catch { /* Already exited. */ }
      }
    };
    try {
      await Promise.race([this.client?.stop(2500), new Promise<void>(resolve => {
        timer = setTimeout(() => {kill(); resolve();}, 3000);
      })]);
    } catch {kill();}
    finally {if (timer) clearTimeout(timer); kill(); this.client?.diagnostics?.clear(); await this.client?.dispose();}
  }
}
