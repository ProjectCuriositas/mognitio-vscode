const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const Module=require('node:module');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {pathToFileURL,fileURLToPath}=require('node:url');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const disposable={dispose(){}};
const uri=p=>({scheme:'file',fsPath:p,toString:()=>pathToFileURL(p).href});
function load(source,mocks){
 const code=buildSync({entryPoints:[source],bundle:true,platform:'node',format:'cjs',
  external:['vscode','vscode-languageclient/node',...(source.includes('extension')?['./session']:[])],write:false}).outputFiles[0].text;
 const mod=new Module(source);mod.require=n=>mocks[n]??require(n);mod._compile(code,source+'.cjs');return mod.exports;
}
function clientFixture(){
 let options,configured=process.execPath,stopCalls=0;
 const vscode={workspace:{textDocuments:[],getConfiguration:()=>({get:()=>configured})},
  window:{showWarningMessage:async()=>{}},Uri:{parse:s=>uri(fileURLToPath(s))}};
 class Client{
  constructor(_id,_name,_server,opts){options=opts;}
  onNotification(){return disposable;}onRequest(){return disposable;}
  async start(){}async stop(){stopCalls++;}async dispose(){}
  diagnostics={clear(){}};
  initializeResult={serverInfo:{version:'0.15.0'},capabilities:{positionEncoding:'utf-16',
   textDocumentSync:{openClose:true,change:1},semanticTokensProvider:{full:true,legend:{tokenTypes:[],tokenModifiers:[]}}}};
 }
 const childProcess={...require('node:child_process')};
 const execFile=()=>{};execFile[require('node:util').promisify.custom]=async()=>({stdout:'mognitio-lsp 0.15.0\n'});
 childProcess.execFile=execFile;
 const api=load('src/session.ts',{'vscode':vscode,'node:child_process':childProcess,
  'vscode-languageclient/node':{LanguageClient:Client,State:{Running:1},ErrorAction:{Shutdown:1},
   CloseAction:{DoNotRestart:1},SemanticTokensRegistrationType:{method:'semantic'},
   SemanticTokensRefreshRequest:{type:'refresh'},PublishDiagnosticsNotification:{type:'diagnostics'}}});
 const session=new api.Session('rootless:',undefined,[],{info(){},error(){}},undefined);
 return {api,session,Client,options:()=>options,configure:value=>configured=value,stops:()=>stopCalls};
}
test('semantic cancellation watchdog uses a real 3 second deadline',async()=>{
 const f=clientFixture();await f.session.start();
 let cancel,resolve,cancelled=false;
 const token={onCancellationRequested:cb=>(cancel=cb,disposable),get isCancellationRequested(){return cancelled;}};
 const task=f.options().middleware.provideDocumentSemanticTokens({version:1},token,()=>new Promise(r=>resolve=r));
 cancelled=true;const started=Date.now();cancel();
 await wait(2800);assert.equal(f.session.stopped,false);
 await wait(450);assert.equal(f.session.stopped,true);
 assert(Date.now()-started<3600);assert.equal(f.stops(),1);
 resolve({data:[1]});assert.equal(await task,null);
});
test('completed cancellation clears watchdog; stale generations return no tokens',async()=>{
 const f=clientFixture();await f.session.start();
 let cancel,resolve,cancelled=false;
 const token={onCancellationRequested:cb=>(cancel=cb,disposable),get isCancellationRequested(){return cancelled;}};
 const request=f.options().middleware.provideDocumentSemanticTokens({version:1},token,()=>new Promise(r=>resolve=r));
 cancelled=true;cancel();resolve({data:[1]});assert.equal(await request,null);
 await wait(3200);assert.equal(f.session.stopped,false);
 const request2=f.options().middleware.provideDocumentSemanticTokens({version:1},
  {onCancellationRequested:()=>disposable,isCancellationRequested:false},()=>new Promise(r=>resolve=r));
 f.session.invalidate();resolve({data:[1]});assert.equal(await request2,null);
 await f.session.stop();
});
test('shutdown kills a nonresponsive owned process group within 3 seconds',async t=>{
 const f=clientFixture();await f.session.start();
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
  {detached:true,stdio:['ignore','pipe','ignore']});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 await new Promise(r=>child.stdout.once('data',r));f.session.child=child;
 f.session.client.stop=()=>new Promise(()=>{});
 const exited=new Promise(r=>child.once('exit',r));const start=Date.now();
 await f.session.stop();await exited;
 assert(Date.now()-start>=2900&&Date.now()-start<3600);assert.equal(child.signalCode,'SIGKILL');
});
test('configured paths, PATH ordering, missing and nonexecutable servers',async t=>{
 const f=clientFixture(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mognitio path 日本語 '));
 const saved=process.env.PATH;t.after(()=>{process.env.PATH=saved;fs.rmSync(tmp,{recursive:true,force:true});});
 const first=path.join(tmp,'first'),second=path.join(tmp,'second');fs.mkdirSync(first);fs.mkdirSync(second);
 for(const dir of [first,second])fs.writeFileSync(path.join(dir,'mognitio-lsp'),'#!/bin/sh\n',{mode:0o755});
 process.env.PATH=first+path.delimiter+second;f.configure('');
 assert.equal(await f.api.executable(),path.join(first,'mognitio-lsp'));
 f.configure(path.join(second,'mognitio-lsp'));assert.equal(await f.api.executable(),path.join(second,'mognitio-lsp'));
 fs.chmodSync(path.join(second,'mognitio-lsp'),0o644);await assert.rejects(f.api.executable(),/not executable/);
 f.configure('relative');await assert.rejects(f.api.executable(),/must be absolute/);
 f.configure('');process.env.PATH=tmp;await assert.rejects(f.api.executable(),/not installed/);
});
test('deactivate stops every admitted session and four-session window limit recovers',async()=>{
 const sessions=[],callbacks={};let stopped=0;
 class Session{constructor(){sessions.push(this);}async start(){}async stop(){if(!this.done){this.done=true;stopped++;}}invalidate(){}}
 const folders=Array.from({length:5},(_,i)=>({uri:uri('/fixture/'+i),name:String(i)}));
 const workspace={workspaceFolders:folders,textDocuments:[],isTrusted:true,
  onDidChangeWorkspaceFolders:cb=>(callbacks.folders=cb,disposable),
  onDidGrantWorkspaceTrust:()=>disposable,onDidOpenTextDocument:()=>disposable,
  onDidCloseTextDocument:()=>disposable,onDidChangeTextDocument:()=>disposable,
  onDidSaveTextDocument:()=>disposable,onDidChangeConfiguration:()=>disposable};
 const api=load('src/extension.ts',{'./session':{Session},vscode:{workspace,env:{},ExtensionMode:{Production:1},
  window:{createOutputChannel:()=>({warn(){},error(){},dispose(){}})},
  commands:{registerCommand:()=>disposable}}});
 api.activate({extensionMode:1,subscriptions:[]});
 // Deactivation waits for queued reconciliation before releasing its sessions.
 await api.deactivate();assert.equal(sessions.length,4);assert.equal(stopped,4);
 folders.pop();callbacks.folders();await api.deactivate();assert.equal(sessions.length,8);assert.equal(stopped,8);
});

test('startup timeout stops the session after ten seconds without retry',async()=>{
 const f=clientFixture();
 f.Client.prototype.start=()=>new Promise(()=>{});
 const started=Date.now();
 await assert.rejects(f.session.start(),/startup timed out/);
 assert(Date.now()-started>=9900&&Date.now()-started<11000);
 assert.equal(f.session.stopped,true);assert.equal(f.stops(),1);
});
