const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const Module=require('node:module');
const {pathToFileURL}=require('node:url');
const disposable={dispose(){}};
const uri=p=>({scheme:'file',fsPath:p,toString:()=>pathToFileURL(p).href});
const document=p=>({uri:uri(p),languageId:'mognitio'});
const folder=p=>({uri:uri(p),name:p});
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw Error('reconciliation did not finish');}
function fixture(t,{folders=[],docs=[],platform='linux',arch='x64',remoteName}={}){
 const created=[],events={},warnings=[],infos=[],trace=[];
 class Session {
  constructor(key,folder){this.key=key;this.folder=folder;created.push(this);}
  async start(){trace.push('start:'+this.key);this.started=true;}
  async stop(){this.stopped=true;trace.push('stop:'+this.key);}
  async setRootlessDocuments(docs){this.documents=[...docs];trace.push('members:'+docs.map(d=>d.uri.toString()).join(','));}
  invalidate(){}async restoreManifest(){}
 }
 const workspace={workspaceFolders:folders,textDocuments:docs,isTrusted:true};
 for(const name of ['onDidChangeWorkspaceFolders','onDidGrantWorkspaceTrust','onDidOpenTextDocument','onDidCloseTextDocument','onDidChangeTextDocument','onDidSaveTextDocument','onDidChangeConfiguration'])
  workspace[name]=callback=>(events[name]=callback,disposable);
 const vscode={workspace,env:{remoteName},ExtensionMode:{Production:1},
  window:{createOutputChannel:()=>({warn:m=>warnings.push(m),info:m=>infos.push(m),error:m=>{throw Error(m);},dispose(){}})},
  commands:{registerCommand:()=>disposable}};
 const code=buildSync({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode','./session'],write:false}).outputFiles[0].text;
 const mod=new Module('extension');mod.require=name=>name==='vscode'?vscode:name==='./session'?{Session}:require(name);
 mod._compile('const process = '+JSON.stringify({platform,arch,env:{}})+';\n'+code,'extension.cjs');
 const api=mod.exports;api.activate({extensionMode:1,subscriptions:[]});t.after(()=>api.deactivate());
 return {created,events,warnings,infos,trace,workspace,api};
}
test('standalone membership changes reuse one server and stop after the last close',async t=>{
 const a=document('/fixture/a.mgn'),b=document('/fixture/b.mgn'),f=fixture(t,{docs:[a]});
 await until(()=>f.created[0]?.documents?.length===1);const session=f.created[0];
 f.workspace.textDocuments.push(b);f.events.onDidOpenTextDocument(b);
 await until(()=>session.documents?.length===2);assert.equal(f.created.length,1);assert(!session.stopped);
 f.workspace.textDocuments.splice(0,1);f.events.onDidCloseTextDocument(a);
 await until(()=>session.documents?.length===1);assert.equal(f.created.length,1);assert.deepEqual(session.documents,[b]);
 f.workspace.textDocuments.length=0;f.events.onDidCloseTextDocument(b);
 await until(()=>session.stopped);assert.equal(f.created.length,1);
});
test('ownership leaves rootless before a new workspace session starts',async t=>{
 const a=document('/fixture/project/src/a.mgn'),b=document('/fixture/outside.mgn'),f=fixture(t,{docs:[a,b]});
 await until(()=>f.created[0]?.documents?.length===2);
 f.trace.length=0;f.workspace.workspaceFolders.push(folder('/fixture/project'));f.events.onDidChangeWorkspaceFolders();
 await until(()=>f.created.length===2&&f.created[1].started);
 assert.deepEqual(f.created[0].documents,[b]);
 assert(f.trace.indexOf('members:'+b.uri.toString())<f.trace.indexOf('start:file:///fixture/project'));
});
test('budget warnings name omitted targets without repeating identical exclusions',async t=>{
 const folders=Array.from({length:5},(_,i)=>folder('/fixture/'+i)),a=document('/standalone/a.mgn');
 const f=fixture(t,{folders,docs:[a]});await until(()=>f.created.length===4);
 assert.equal(f.warnings.length,1);assert(f.warnings[0].includes('file:///fixture/4'));assert(f.warnings[0].includes('file:///standalone/a.mgn'));
 f.events.onDidOpenTextDocument(a);await new Promise(r=>setTimeout(r,30));assert.equal(f.warnings.length,1);
 folders.splice(3,2);f.events.onDidChangeWorkspaceFolders();await until(()=>f.created.some(s=>s.key==='rootless'));
 assert(f.created[3].stopped);assert.equal(f.created.filter(s=>!s.stopped).length,4);
});
for(const environment of [{platform:'win32'},{arch:'arm64'},{remoteName:'ssh-remote'},{remoteName:'wsl'}]) {
 test('unsupported environment is explained once without launching: '+JSON.stringify(environment),async t=>{
  const f=fixture(t,{...environment,docs:[document('/fixture/a.mgn')]});
  await until(()=>f.warnings.length===1);assert.match(f.warnings[0],/Unsupported Mognitio environment.*Only lexical highlighting/);assert.equal(f.created.length,0);
  f.events.onDidOpenTextDocument();await f.api.deactivate();assert.equal(f.warnings.length,1);assert.equal(f.created.length,0);
 });
}
