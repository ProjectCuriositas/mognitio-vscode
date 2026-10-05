const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL, fileURLToPath} = require('node:url');

const source = process.env.MOGNITIO_TEST_SESSION || 'src/session.ts';
const code = buildSync({entryPoints:[source], bundle:true, platform:'node', format:'cjs',
  external:['vscode','vscode-languageclient/node'], write:false}).outputFiles[0].text;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => {resolve = r;});
  return {promise, resolve};
};
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
};
const uri = value => {
  const parsed = new URL(value);
  return {scheme:parsed.protocol.slice(0,-1), authority:parsed.host,
    fsPath:fileURLToPath(parsed), toString:() => parsed.href};
};

async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mognitio-session-'));
  const manifest = path.join(directory, 'mognitio.toml');
  await fs.promises.writeFile(manifest, 'invalid A');
  const manifestUri = uri(pathToFileURL(manifest).href);
  const document = {uri:manifestUri, isDirty:false, version:1};
  const shown = [], notifications = new Map();
  let closeNumber = 0, holdAt = 0, held, release;
  const mockFs = {...fs, promises:{...fs.promises, open:async (...args) => {
    const file = await fs.promises.open(...args);
    const close = file.close.bind(file);
    file.close = async () => {
      await close();
      const number = ++closeNumber;
      if (number === holdAt) {held.resolve(); await release.promise;}
    };
    return file;
  }}};
  const disposable = {dispose() {}};
  const vscode = {
    Uri:{parse:uri, joinPath:(root, name) => uri(pathToFileURL(path.join(root.fsPath,name)).href)},
    workspace:{
      textDocuments:[document],
      getConfiguration:() => ({get:() => process.execPath}),
      createFileSystemWatcher:() => ({
        ...disposable, onDidCreate:() => disposable, onDidChange:() => disposable, onDidDelete:() => disposable
      })
    },
    RelativePattern:class {},
    window:{showWarningMessage:async () => {}}
  };
  class LanguageClient {
    state = 1;
    diagnostics = {set:(_uri, diagnostics) => shown.push(diagnostics), clear() {}};
    protocol2CodeConverter = {asDiagnostics:async values => values};
    initializeResult = {serverInfo:{version:'0.15.0'}, capabilities:{
      positionEncoding:'utf-16', textDocumentSync:{openClose:true, change:1},
      semanticTokensProvider:{full:true, legend:{tokenTypes:[], tokenModifiers:[]}}
    }};
    onNotification(type, callback) {notifications.set(type,callback); return disposable;}
    onRequest() {return disposable;}
    async start() {}
    async stop() {}
    async dispose() {}
    getFeature() {return {getProvider:() => undefined};}
  }
  const clientModule = {LanguageClient, State:{Running:1}, ErrorAction:{Shutdown:1},
    CloseAction:{DoNotRestart:1}, SemanticTokensRegistrationType:{method:'semantic'},
    SemanticTokensRefreshRequest:{type:'refresh'}, PublishDiagnosticsNotification:{type:'diagnostics'}};
  const mod = new Module('session-fixture');
  mod.require = name => {
    if (name === 'vscode') return vscode;
    if (name === 'vscode-languageclient/node') return clientModule;
    if (name === 'node:fs') return mockFs;
    if (name === 'node:child_process') {
      const execFile = () => {};
      execFile[require('node:util').promisify.custom] = async () => ({stdout:'mognitio-lsp 0.15.0\n',stderr:''});
      return {execFile};
    }
    return require(name);
  };
  mod._compile(code, 'session-fixture.cjs');
  const session = new mod.exports.Session('fixture',
    {uri:uri(pathToFileURL(directory).href),name:'fixture'}, [], {info() {},error:message => {throw new Error(message);}},
    undefined);
  await session.start();
  t.after(async () => {release?.resolve(); await session.stop(); await fs.promises.rm(directory,{recursive:true,force:true});});
  return {
    session, document, shown, manifestUri,
    save:content => fs.promises.writeFile(manifest, content),
    publish:diagnostics => notifications.get('diagnostics')({uri:manifestUri.toString(), diagnostics}),
    holdClose:offset => {
      holdAt = closeNumber + offset; held = deferred(); release = deferred();
      return {held:held.promise, release:async () => {release.resolve(); await settle();}};
    },
    async untilShown(predicate) {
      const deadline = Date.now() + 2000;
      while (!predicate(shown.at(-1))) {
        if (Date.now() > deadline) throw new Error('diagnostic application timed out');
        await new Promise(resolve => setTimeout(resolve,5));
      }
    }
  };
}

test('save completed during the second hash close cannot revive an earlier raw diagnostic', async t => {
  const f = await fixture(t), barrier = f.holdClose(2);
  f.publish([{message:'old manifest error'}]);
  await barrier.held; // Both hashes read A; only final close completion is delayed.
  await f.save('valid B');
  await f.session.restoreManifest(f.manifestUri);
  assert.deepEqual(f.shown.at(-1), []);
  const afterSave = f.shown.length;
  await barrier.release();
  assert(f.shown.slice(afterSave).every(values => values.length === 0));
  const beforeFresh = f.shown.length;
  f.publish([]);
  await f.untilShown(values => f.shown.length > beforeFresh && values.length === 0);
  await settle();
});

test('a later disk observation cannot be superseded by an earlier raw conversion', async t => {
  const f = await fixture(t), barrier = f.holdClose(2);
  f.publish([{message:'old manifest error'}]);
  await barrier.held;
  await f.save('external B');
  await f.session.restoreManifest(f.manifestUri);
  f.publish([{message:'new manifest error'}]);
  await f.untilShown(values => values?.[0]?.message === 'new manifest error');
  await barrier.release();
  assert.equal(f.shown.at(-1)[0].message, 'new manifest error');
});

test('a newer raw receipt supersedes an older restore without losing unchanged-disk discard', async t => {
  const f = await fixture(t);
  f.publish([{message:'current error'}]);
  await f.untilShown(values => values?.[0]?.message === 'current error');
  const barrier = f.holdClose(1);
  const restoring = f.session.restoreManifest(f.manifestUri);
  await barrier.held;
  f.publish([{message:'newest error'}]);
  await f.untilShown(values => values?.[0]?.message === 'newest error');
  await barrier.release(); await restoring;
  assert.equal(f.shown.at(-1)[0].message, 'newest error');
  f.document.isDirty = true;
  await f.session.restoreManifest(f.manifestUri);
  assert.deepEqual(f.shown.at(-1), []);
  f.document.isDirty = false;
  await f.session.restoreManifest(f.manifestUri);
  assert.equal(f.shown.at(-1)[0].message, 'newest error');
});
