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
  let closeNumber = 0;
  const holds = new Map();
  const mockFs = {...fs, promises:{...fs.promises, open:async (...args) => {
    const file = await fs.promises.open(...args);
    const close = file.close.bind(file);
    file.close = async () => {
      await close();
      const number = ++closeNumber;
      const hold = holds.get(number);
      if (hold) {hold.held.resolve(); await hold.release.promise;}
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
  // Observe completion without making the production notification callback blocking.
  let pending;
  if (session.publishManifest) {
    const publish = session.publishManifest.bind(session);
    session.publishManifest = (...args) => (pending = publish(...args));
  }
  await session.start();
  t.after(async () => {holds.forEach(hold => hold.release.resolve()); await session.stop(); await fs.promises.rm(directory,{recursive:true,force:true});});
  return {
    session, document, shown, manifestUri,
    save:content => fs.promises.writeFile(manifest, content),
    remove:() => fs.promises.unlink(manifest),
    publish:diagnostics => {
      notifications.get('diagnostics')({uri:manifestUri.toString(), diagnostics});
      return pending ?? settle();
    },
    holdClose:offset => {
      const hold = {held:deferred(), release:deferred()};
      holds.set(closeNumber + offset, hold);
      return {held:hold.held.promise, release:async () => {hold.release.resolve(); await settle();}};
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

test('disk-unchanged editing retains an in-flight raw diagnostic for discard', async t => {
  const f = await fixture(t), barrier = f.holdClose(2);
  const publishing = f.publish([{message:'valid disk A error'}]);
  await barrier.held;
  f.document.isDirty = true;
  await f.session.restoreManifest(f.manifestUri);
  await barrier.release(); await publishing;
  assert.deepEqual(f.shown.at(-1), []);
  f.document.isDirty = false;
  await f.session.restoreManifest(f.manifestUri);
  assert.equal(f.shown.at(-1)?.[0]?.message, 'valid disk A error');
});

for (const close of [1, 2]) {
  for (const change of ['edit', 'save', 'unreadable', 'changed-back']) {
    test('raw close ' + close + ': ' + change + ' preserves only the confirmed disk generation', {timeout:3000}, async t => {
      const f = await fixture(t), barrier = f.holdClose(close);
      const publishing = f.publish([{message:'disk A error'}]);
      await barrier.held;
      f.document.isDirty = true;
      if (change === 'save' || change === 'changed-back') await f.save('disk B');
      if (change === 'unreadable') await f.remove();
      await f.session.restoreManifest(f.manifestUri);
      if (change === 'changed-back') {
        await f.save('invalid A');
        await f.session.restoreManifest(f.manifestUri);
      }
      await barrier.release(); await publishing;
      assert.deepEqual(f.shown.at(-1), []);
      assert.equal(f.session.cache.has(f.manifestUri.toString()), change === 'edit');
      f.document.isDirty = false;
      await f.session.restoreManifest(f.manifestUri);
      if (change === 'edit') assert.equal(f.shown.at(-1)[0].message, 'disk A error');
      else assert.deepEqual(f.shown.at(-1), []);
    });
  }
}

for (const changed of [false, true]) {
  test('conversion waits for a pending disk observation: changed=' + changed, {timeout:3000}, async t => {
    const f = await fixture(t), raw = f.holdClose(2);
    let completed = false;
    const publishing = f.publish([{message:'disk A error'}]).then(() => {completed = true;});
    await raw.held;
    f.document.isDirty = true;
    if (changed) await f.save('disk B');
    const disk = f.holdClose(1);
    const restoring = f.session.restoreManifest(f.manifestUri);
    await disk.held;
    await raw.release();
    assert.equal(completed, false);
    assert.equal(f.session.cache.has(f.manifestUri.toString()), false);
    await disk.release(); await restoring; await publishing;
    assert.equal(f.session.cache.has(f.manifestUri.toString()), !changed);
    f.document.isDirty = false;
    await f.session.restoreManifest(f.manifestUri);
    assert.deepEqual(f.shown.at(-1), changed ? [] : [{message:'disk A error'}]);
  });
}

test('newer empty raw diagnostics defeat an older conversion on unchanged disk', {timeout:3000}, async t => {
  const f = await fixture(t), barrier = f.holdClose(2);
  const older = f.publish([{message:'older error'}]);
  await barrier.held;
  await f.publish([]);
  await barrier.release(); await older;
  assert.deepEqual(f.shown.at(-1), []);
  assert.deepEqual(f.session.cache.get(f.manifestUri.toString()), []);
});

test('session stop defeats an in-flight manifest conversion', {timeout:3000}, async t => {
  const f = await fixture(t), barrier = f.holdClose(2);
  const publishing = f.publish([{message:'old session error'}]);
  await barrier.held;
  await f.session.stop();
  const count = f.shown.length;
  await barrier.release(); await publishing;
  assert.equal(f.shown.length, count);
  assert.equal(f.session.cache.size, 0);
});

for (const heldSave of [false, true]) {
  test('new disk baseline catches up from cached A: pending save=' + heldSave, {timeout:3000}, async t => {
    const f = await fixture(t);
    await f.publish([{message:'A error'}]);
    assert.equal(f.shown.at(-1)[0].message, 'A error');
    await f.save('disk B');
    const saveClose = heldSave ? f.holdClose(1) : undefined;
    const saving = f.session.restoreManifest(f.manifestUri);
    if (saveClose) await saveClose.held;
    else await saving;
    const rawClose = f.holdClose(1);
    const publishing = f.publish([{message:'B error'}]);
    await rawClose.held;
    f.document.isDirty = true;
    await f.session.restoreManifest(f.manifestUri);
    if (saveClose) await saveClose.release();
    await saving;
    await rawClose.release(); await publishing;
    assert.deepEqual(f.shown.at(-1), []);
    assert.equal(f.session.cache.get(f.manifestUri.toString())?.[0]?.message, 'B error');
    f.document.isDirty = false;
    await f.session.restoreManifest(f.manifestUri);
    assert.equal(f.shown.at(-1)[0].message, 'B error');
  });
}

for (const history of [['disk B','disk B'], ['disk C','disk B'], [null,'disk B']]) {
  test('baseline catch-up preserves observation history: ' + JSON.stringify(history), {timeout:3000}, async t => {
    const f = await fixture(t);
    await f.publish([{message:'A error'}]);
    await f.save('disk B');
    const barrier = f.holdClose(1);
    const publishing = f.publish([{message:'B error'}]);
    await barrier.held;
    f.document.isDirty = true;
    for (const disk of history) {
      if (disk === null) await f.remove();
      else await f.save(disk);
      await f.session.restoreManifest(f.manifestUri);
    }
    await barrier.release(); await publishing;
    const accepted = history.every(disk => disk === 'disk B');
    assert.equal(f.session.cache.has(f.manifestUri.toString()), accepted);
    f.document.isDirty = false;
    await f.session.restoreManifest(f.manifestUri);
    assert.deepEqual(f.shown.at(-1), accepted ? [{message:'B error'}] : []);
  });
}
