const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildSync}=require('esbuild'),Module=require('node:module');
const {pathToFileURL}=require('node:url');
const disposable={dispose(){}},tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const uri=p=>({scheme:'file',fsPath:p,toString:()=>pathToFileURL(p).href});
async function fixture(t){
 const trace=[],watchers=[],requests=new Map(),doc={uri:uri('/fixture/src/a.mgn'),version:1};let options;
 const vscode={Uri:{joinPath:(u,p)=>uri(u.fsPath+'/'+p)},RelativePattern:class {constructor(_,glob){this.glob=glob;}},
  workspace:{textDocuments:[doc],getConfiguration:()=>({get:()=>process.execPath}),createFileSystemWatcher(pattern){
   const handlers={pattern};watchers.push(handlers);return {dispose(){},onDidCreate:cb=>(handlers.create=cb,disposable),onDidChange:cb=>(handlers.change=cb,disposable),onDidDelete:cb=>(handlers.delete=cb,disposable)};
  }},window:{showWarningMessage:async()=>{}}};
 class Client {
  state=1;diagnostics={set(){},clear(){}};
  initializeResult={serverInfo:{version:'1.1.0'},capabilities:{positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:1},semanticTokensProvider:{full:true,legend:{tokenTypes:[],tokenModifiers:[]}}}};
  constructor(_id,_name,_server,o){options=o;}
  getFeature(){return {getProvider:()=>({onDidChangeSemanticTokensEmitter:{fire:()=>trace.push('refresh')}})};}
  onNotification(){return disposable;}onRequest(type,cb){requests.set(type,cb);return disposable;}
  async sendNotification(){trace.push('sent');}async start(){}async stop(){}async dispose(){}
 }
 const api={LanguageClient:Client,State:{Running:1},ErrorAction:{Shutdown:1},CloseAction:{DoNotRestart:1},SemanticTokensRegistrationType:{method:'semantic'},SemanticTokensRefreshRequest:{type:'refresh'},PublishDiagnosticsNotification:{type:'diagnostics'}};
 const execFile=()=>{};execFile[require('node:util').promisify.custom]=async()=>({stdout:'mognitio-lsp 1.1.0\n'});
 const code=buildSync({entryPoints:['src/session.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode','vscode-languageclient/node'],write:false}).outputFiles[0].text;
 const mod=new Module('session');mod.require=n=>n==='vscode'?vscode:n==='vscode-languageclient/node'?api:n==='node:child_process'?{execFile}:require(n);mod._compile(code,'session.cjs');
 const session=new mod.exports.Session('project',{uri:uri('/fixture')},[],{info(){},error:m=>trace.push('error:'+m)},undefined);
 await session.start();t.after(()=>session.stop());
 const tokens=(next=async()=>({data:[1]}))=>options.middleware.provideDocumentSemanticTokens(doc,{onCancellationRequested:()=>disposable,isCancellationRequested:false},next);
 return {session,trace,watchers,requests,options:()=>options,tokens};
}
test('manifest read gates tokens until notification completes and rejects the pre-change response',async t=>{
 const f=await fixture(t),disk=deferred(),reply=deferred();f.session.manifestDisk=()=>disk.promise;
 const old=f.tokens(()=>reply.promise);
 f.watchers.find(w=>w.pattern.glob==='mognitio.toml').change(uri('/fixture/mognitio.toml'));
 await tick();assert.deepEqual(f.trace,[],'refresh must not precede the delayed disk observation');
 assert.equal(await f.tokens(()=>{throw Error('requested old server snapshot');}),null);
 f.requests.get('refresh')();assert.deepEqual(f.trace,[],'server refresh cannot bypass pending synchronization');
 reply.resolve({data:[1]});assert.equal(await old,null);
 disk.resolve('new hash');await tick();await tick();assert.deepEqual(f.trace,['sent','refresh']);
 assert.deepEqual(await f.tokens(),{data:[1]});
});
test('overlapping watched changes refresh only after every notification completes',async t=>{
 const f=await fixture(t),first=deferred(),second=deferred();let count=0;
 f.session.client.sendNotification=async()=>{const i=count++;await [first,second][i].promise;f.trace.push('sent:'+i);};
 const source=f.watchers.find(w=>w.pattern.glob==='src/**/*');source.create(uri('/fixture/src/a.mgn'));source.delete(uri('/fixture/src/b.mgn'));
 second.resolve();await tick();assert.deepEqual(f.trace,['sent:1']);assert.equal(await f.tokens(),null);
 first.resolve();await tick();assert.deepEqual(f.trace,['sent:1','sent:0','refresh']);assert.deepEqual(await f.tokens(),{data:[1]});
});
for(const event of ['didOpen','didChange','didClose'])test(event+' schedules refresh after the synchronization continuation',async t=>{
 const f=await fixture(t),send=deferred();const pending=f.options().middleware[event]({},async()=>{await send.promise;f.trace.push('sent');});
 assert.deepEqual(f.trace,[]);assert.equal(await f.tokens(),null);send.resolve();await pending;
 assert.deepEqual(f.trace,['sent','refresh']);assert.deepEqual(await f.tokens(),{data:[1]});
});
test('failed watched notification stops the session instead of serving an old snapshot',async t=>{
 const f=await fixture(t);f.session.client.sendNotification=async()=>{throw Error('transport unavailable');};
 f.watchers[0].change(uri('/fixture/src/a.mgn'));await tick();await tick();
 assert(f.session.stopped);assert(!f.trace.includes('refresh'));assert(f.trace.some(x=>x.includes('transport unavailable')));assert.equal(await f.tokens(),null);
});
