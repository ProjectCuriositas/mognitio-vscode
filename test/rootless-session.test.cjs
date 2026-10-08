const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildSync}=require('esbuild'),Module=require('node:module');
const {pathToFileURL,fileURLToPath}=require('node:url');
const disposable={dispose(){}};
const uri=value=>{const u=new URL(value);return {scheme:u.protocol.slice(0,-1),authority:u.host,fsPath:fileURLToPath(u),toString:()=>u.href};};
const doc=name=>({uri:uri(pathToFileURL('/fixture/'+name).href),version:1,languageId:'mognitio'});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t){
 const registrations=new Map(),synced=new Set(),events=[],shown=new Map(),notifications=new Map(),logs=[];
 const methods={DidOpenTextDocumentNotification:'open',DidChangeTextDocumentNotification:'change',DidCloseTextDocumentNotification:'close',SemanticTokensRegistrationType:'semantic'};
 const features=Object.fromEntries(Object.values(methods).map(method=>[method,{
  openDocuments:synced,
  register(data){registrations.set(method+':'+data.id,data.registerOptions);events.push([method,'register',data.id]);
   if(method==='open')for(const d of vscode.workspace.textDocuments)if('rootless:'+d.uri.toString()===data.id)synced.add(d);
  },
  unregister(id){registrations.delete(method+':'+id);events.push([method,'unregister',id]);},
  getProvider(d){return method==='semantic'?undefined:{send:async()=>{events.push(['close','send',d.uri.toString()]);if(holdClose)await holdClose;synced.delete(d);}};}
 }]));
 let holdClose,options;
 const vscode={Uri:{parse:uri,file:p=>uri(pathToFileURL(p).href)},workspace:{textDocuments:[],getConfiguration:()=>({get:()=>process.execPath})},window:{showWarningMessage:async()=>{}}};
 class Client {
  state=1;diagnostics={set:(u,d)=>shown.set(u.toString(),d),delete:u=>shown.delete(u.toString()),clear:()=>shown.clear()};
  protocol2CodeConverter={asDiagnostics:async d=>d};
  initializeResult={serverInfo:{version:'1.1.0'},capabilities:{positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:1},semanticTokensProvider:{full:true,legend:{tokenTypes:['variable'],tokenModifiers:[]}}}};
  constructor(_id,_name,_server,o){options=o;}getFeature(name){return features[name];}
  onNotification(type,cb){notifications.set(type,cb);return disposable;}onRequest(){return disposable;}
  async start(){}async stop(){}async dispose(){}
 }
 const client={LanguageClient:Client,State:{Running:1},ErrorAction:{Shutdown:1},CloseAction:{DoNotRestart:1},
  TextDocumentSyncKind:{Full:1},SemanticTokensRefreshRequest:{type:'refresh'},PublishDiagnosticsNotification:{type:'diagnostics'}};
 for(const [name,method] of Object.entries(methods))client[name]={method};
 const execFile=()=>{};execFile[require('node:util').promisify.custom]=async()=>({stdout:'mognitio-lsp 1.1.0\n'});
 const code=buildSync({entryPoints:['src/session.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode','vscode-languageclient/node'],write:false}).outputFiles[0].text;
 const mod=new Module('session');mod.require=name=>name==='vscode'?vscode:name==='vscode-languageclient/node'?client:name==='node:child_process'?{execFile}:require(name);mod._compile(code,'session.cjs');
 const session=new mod.exports.Session('rootless',undefined,[],{info:m=>logs.push(m),error:m=>{throw Error(m);}},undefined);
 t.after(()=>session.stop());
 return {session,registrations,events,shown,logs,options:()=>options,hold:p=>holdClose=p,
  async members(docs){vscode.workspace.textDocuments=docs;await session.setRootlessDocuments(docs);},
  publish(d,diagnostics){notifications.get('diagnostics')({uri:d.uri.toString(),version:d.version,diagnostics});}};
}
test('per-document selectors retain existing registrations and synchronize close before removal completes',async t=>{
 const f=fixture(t),a=doc('a[1].mgn'),b=doc('b.mgn');await f.session.start();await f.members([a]);
 assert.equal(f.options().documentSelector,undefined);assert(f.logs.some(m=>m.includes('Connected language server:')&&m.includes('mognitio-lsp 1.1.0')));
 const aId='rootless:'+a.uri.toString(),aEvents=f.events.filter(e=>e[2]===aId).length;
 await f.members([a,b]);assert.equal(f.events.filter(e=>e[2]===aId).length,aEvents);
 assert.equal(f.registrations.get('open:'+aId).documentSelector[0].pattern.pattern,'a[[]1[]].mgn');
 assert.deepEqual(f.registrations.get('semantic:'+aId).legend,{tokenTypes:['variable'],tokenModifiers:[]});
 let release;f.hold(new Promise(r=>release=r));let finished=false;
 const removing=f.members([b]).then(()=>finished=true);await tick();assert(!finished);assert(!f.registrations.has('semantic:'+aId));
 release();await removing;assert.equal(f.registrations.size,4);assert(f.events.some(e=>e[0]==='close'&&e[1]==='send'));
});
test('retired membership cannot restore diagnostics after asynchronous conversion or reacquisition',async t=>{
 const f=fixture(t),a=doc('a.mgn'),b=doc('b.mgn'),foreign=doc('foreign.mgn');await f.session.start();await f.members([a,b]);
 f.publish(foreign,[{message:'foreign'}]);await tick();assert.equal(f.shown.size,0);
 f.publish(a,[{message:'current'}]);await tick();assert.equal(f.shown.get(a.uri.toString())[0].message,'current');
 let release;f.session.client.protocol2CodeConverter.asDiagnostics=()=>new Promise(r=>release=r);
 f.publish(a,[{message:'stale'}]);await f.members([b]);await f.members([a,b]);release([{message:'stale'}]);await tick();
 assert(!f.shown.has(a.uri.toString()));assert(!f.session.cache.has(a.uri.toString()));
 f.session.client.protocol2CodeConverter.asDiagnostics=async d=>d;f.publish(a,[{message:'fresh'}]);await tick();assert.equal(f.shown.get(a.uri.toString())[0].message,'fresh');
 await f.session.stop();assert.equal(f.shown.size,0);
});
