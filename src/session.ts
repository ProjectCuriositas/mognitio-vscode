import type { DocumentSelector } from 'vscode-languageclient/node';
import * as vscode from 'vscode';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  LanguageClient, InitializeParams, ErrorAction, CloseAction, State,
  DidOpenTextDocumentNotification, DidChangeTextDocumentNotification, DidCloseTextDocumentNotification,
  TextDocumentSyncKind,
  SemanticTokensRegistrationType, SemanticTokensRefreshRequest, PublishDiagnosticsNotification
} from 'vscode-languageclient/node';
import { compatibleVersion, compatibleCapabilities, contains } from './policy';
import { DiagnosticGate } from './diagnostics';
import { ManifestBaseline, ManifestDiagnostics } from './manifest';

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
  private diagnostics = new DiagnosticGate();
  private manifestDiagnostics = new ManifestDiagnostics<readonly vscode.Diagnostic[]>();
  private manifestRead = 0;
  private manifestReceive = 0;
  private manifestObservation?: Promise<void>;
  private manifestBaseline?: ManifestBaseline;
  private watchers: vscode.Disposable[] = [];
  private rootless = new Map<string, {document: vscode.TextDocument}>();
  private cancellations = new Set<NodeJS.Timeout>();
  constructor(
    readonly key: string,
    readonly folder: vscode.WorkspaceFolder | undefined,
    readonly selector: DocumentSelector,
    readonly output: vscode.LogOutputChannel,
    readonly expected: string | undefined,
  ) {}
  async setRootlessDocuments(documents: readonly vscode.TextDocument[]): Promise<void> {
    const client = this.client;
    if (this.folder || this.stopped || !client) return;
    const desired = new Map(documents.map(document => [document.uri.toString(), document]));
    const open = client.getFeature(DidOpenTextDocumentNotification.method);
    const change = client.getFeature(DidChangeTextDocumentNotification.method);
    const close = client.getFeature(DidCloseTextDocumentNotification.method);
    const semantic = client.getFeature(SemanticTokensRegistrationType.method);
    for (const [key, owned] of this.rootless) if (desired.get(key) !== owned.document) {
      this.rootless.delete(key);
      this.invalidate();
      const id = 'rootless:' + key;
      semantic.unregister(id);
      // Await close before another session can acquire this document. The send
      // provider also updates the client's synchronized-document bookkeeping.
      if ([...open.openDocuments].includes(owned.document)) await close.getProvider(owned.document)?.send(owned.document);
      open.unregister(id); change.unregister(id); close.unregister(id);
      this.cache.delete(key);
      this.diagnostics.forget(key);
      client.diagnostics?.delete(owned.document.uri);
    }
    for (const [key, document] of desired) if (!this.rootless.has(key)) {
      this.rootless.set(key, {document});
      this.invalidate();
      const id = 'rootless:' + key;
      const documentSelector: DocumentSelector = [{language: 'mognitio', scheme: 'file', pattern: {
        baseUri: vscode.Uri.file(path.dirname(document.uri.fsPath)).toString(),
        pattern: path.basename(document.uri.fsPath).replace(/[?*[\]{}]/g, '[$&]')
      }}];
      const registerOptions = {documentSelector};
      close.register({id, registerOptions});
      change.register({id, registerOptions: {...registerOptions, syncKind: TextDocumentSyncKind.Full}});
      semantic.register({id, registerOptions: {...client.initializeResult!.capabilities.semanticTokensProvider!, documentSelector}});
      // Register last: this synchronizes documents opened before registration.
      open.register({id, registerOptions});
    }
  }
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
  private async manifestDisk(): Promise<string | undefined> {
    if (!this.folder) return undefined;
    try {
      const file = await fs.open(path.join(this.folder.uri.fsPath, 'mognitio.toml'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return undefined;
        const hash = createHash('sha256'), buffer = new Uint8Array(64 * 1024);
        let total = 0;
        while (true) {
          const {bytesRead} = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) return hash.digest('hex');
          total += bytesRead;
          if (total > 4 * 1024 * 1024) return undefined;
          hash.update(buffer.subarray(0, bytesRead));
        }
      } finally {await file.close();}
    } catch {return undefined;}
  }
  private observeManifest(uri: vscode.Uri, disk: string | undefined): void {
    this.manifestBaseline?.observe(disk);
    const revision = this.manifestDiagnostics.revision;
    this.manifestDiagnostics.observe(disk);
    if (revision !== this.manifestDiagnostics.revision) this.cache.delete(uri.toString());
  }
  private showManifest(uri: vscode.Uri): void {
    const dirty = vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
    this.client?.diagnostics?.set(uri, this.manifestDiagnostics.visible(dirty) ?? []);
  }
  async restoreManifest(changed?: vscode.Uri): Promise<void> {
    if (!this.client || !this.folder || this.stopped || (changed && !this.manifest(changed))) return;
    const uri = vscode.Uri.joinPath(this.folder.uri, 'mognitio.toml');
    const read = ++this.manifestRead;
    // The event can be an edit, discard, or save; only observed disk changes expire data.
    this.client.diagnostics?.set(uri, []);
    const observation = (async () => {
      const disk = await this.manifestDisk();
      if (this.stopped || read !== this.manifestRead) return;
      this.observeManifest(uri, disk);
      this.showManifest(uri);
    })();
    this.manifestObservation = observation;
    try {await observation;}
    finally {if (this.manifestObservation === observation) this.manifestObservation = undefined;}
  }
  private async publishManifest(uri: vscode.Uri, valid: () => boolean,
                                convert: () => Promise<vscode.Diagnostic[]>): Promise<void> {
    if (!valid()) return;
    const receive = ++this.manifestReceive;
    ++this.manifestRead;
    const baseline = this.manifestBaseline = new ManifestBaseline();
    // A newer receipt supersedes earlier restore reads, without changing disk generation.
    this.manifestObservation = undefined;
    const current = () => valid() && receive === this.manifestReceive;
    const before = await this.manifestDisk();
    while (this.manifestObservation) await this.manifestObservation;
    if (!current()) return;
    this.manifestBaseline = undefined;
    if (before === undefined) {
      this.observeManifest(uri, undefined);
      this.showManifest(uri);
      return;
    }
    // Establish this notification's baseline, not the cache's pre-receipt generation.
    // Every authoritative observation since receipt must agree with the first hash.
    if (!baseline.accepts(before)) return;
    this.observeManifest(uri, before);
    this.showManifest(uri);
    const revision = this.manifestDiagnostics.revision;
    const diagnostics = await convert();
    const after = await this.manifestDisk();
    // Apply in this continuation, with no await between the final check and cache/display.
    while (this.manifestObservation) await this.manifestObservation;
    if (!current() || revision !== this.manifestDiagnostics.revision) return;
    if (before !== after || !this.manifestDiagnostics.matches(after)) {
      this.observeManifest(uri, undefined);
      this.showManifest(uri);
      return;
    }
    this.manifestDiagnostics.publish(after, diagnostics);
    this.cache.set(uri.toString(), diagnostics);
    this.showManifest(uri);
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
      documentSelector: this.folder ? this.selector : undefined,
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
    // Register before start: pending handlers replace the built-in receiver before
    // initialized is sent. The built-in diagnostic queue discards params.version.
    this.watchers.push(client.onNotification(PublishDiagnosticsNotification.type, params => {
      const uri = vscode.Uri.parse(params.uri);
      const key = uri.toString();
      const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
      const ownership = this.rootless.get(key);
      const belongs = uri.scheme === 'file' && !uri.authority && (this.folder
        ? this.manifest(uri) || (uri.fsPath.endsWith('.mgn') && contains(path.join(this.folder.uri.fsPath, 'src'), uri.fsPath))
        : ownership !== undefined);
      const valid = () => {
        if (this.stopped || epoch !== this.epoch || !belongs ||
            (!this.folder && this.rootless.get(key) !== ownership)) return false;
        if (this.manifest(uri)) return true;
        const current = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
        return current === document && (current ? params.version === current.version : params.version === undefined);
      };
      const convert = () => client.protocol2CodeConverter.asDiagnostics(params.diagnostics);
      const publish = this.manifest(uri)
        ? this.publishManifest(uri, valid, convert)
        : this.diagnostics.publish(key, valid, convert, diagnostics => {
          this.cache.set(key, diagnostics);
          client.diagnostics?.set(uri, diagnostics);
        });
      void publish.catch(error => this.output.error('Diagnostic conversion failed: ' + String(error)));
    }));
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
    this.output.info('Connected language server: ' + command + ' (mognitio-lsp ' + match[1] + ')');
    this.watchers.push(client.onRequest(SemanticTokensRefreshRequest.type, async () => {
      this.invalidate();
    }));
    if (this.folder) {
      for (const glob of ['src/**/*', 'mognitio.toml']) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, glob));
        const changed = async (uri: vscode.Uri, type: number) => {
          if (this.stopped) return;
          this.invalidate();
          if (this.manifest(uri)) await this.restoreManifest(uri);
          await client.sendNotification('workspace/didChangeWatchedFiles', {changes: [{uri: uri.toString(), type}]});
        };
        this.watchers.push(watcher, watcher.onDidCreate(u => {void changed(u, 1);}),
          watcher.onDidChange(u => {void changed(u, 2);}), watcher.onDidDelete(u => {void changed(u, 3);}));
      }
    }
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; ++this.epoch; this.rootless.clear(); this.cache.clear(); this.diagnostics.clear();
    this.manifestDiagnostics.clear(); ++this.manifestRead; ++this.manifestReceive;
    this.manifestObservation = undefined; this.manifestBaseline = undefined;
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
