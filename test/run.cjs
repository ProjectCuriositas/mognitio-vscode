const {runTests,downloadAndUnzipVSCode,resolveCliArgsFromVSCodeExecutablePath}=require('@vscode/test-electron');
const {spawnSync,spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
(async()=>{
 const untrusted=process.env.MOGNITIO_TEST_UNTRUSTED==='1';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mognitio-editor-'));
 fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'.vscode'));
 fs.writeFileSync(path.join(root,'mognitio.toml'),'[project]\nname = "sample"\nroot_namespace = "Example"\n');
 fs.writeFileSync(path.join(root,'src/sample.mgn'),'namespace Example;\nlet value: Int = 1;\n');
 const user=fs.mkdtempSync(path.join(os.tmpdir(),'mognitio-editor-user-'));
 fs.mkdirSync(path.join(user,'User'));
 fs.writeFileSync(path.join(user,'User/settings.json'),JSON.stringify({
  'mognitio.serverPath':process.env.MOGNITIO_TEST_SERVER,'editor.semanticHighlighting.enabled':true,
  'editor.semanticTokenColorCustomizations':{rules:{'variable.readonly':'#ff00ff'}},
  'security.workspace.trust.enabled':untrusted,'security.workspace.trust.startupPrompt':'never','workbench.startupEditor':'none'
 }));
 const diagnosticGate=path.join(user,'diagnostic-gate');fs.mkdirSync(diagnosticGate);
 if(!untrusted && process.env.MOGNITIO_TEST_DELAY_DIAGNOSTICS==='1'){
  const proxy=path.join(user,'diagnostic-proxy');
  fs.copyFileSync(path.resolve('test/diagnostic-proxy.py'),proxy);fs.chmodSync(proxy,0o755);
  process.env.MOGNITIO_PROXY_SERVER=process.env.MOGNITIO_TEST_SERVER;
  process.env.MOGNITIO_PROXY_GATE=diagnosticGate;
  const settingsPath=path.join(user,'User/settings.json');
  const settings=JSON.parse(fs.readFileSync(settingsPath));settings['mognitio.serverPath']=proxy;
  fs.writeFileSync(settingsPath,JSON.stringify(settings));
 }
 const executable=await downloadAndUnzipVSCode(process.env.MOGNITIO_TEST_VSCODE||'1.91.0');
 let development=path.resolve('.');
 const extensions=path.join(user,'extensions');
 if(process.env.MOGNITIO_TEST_VSIX){
  const [cli,...args]=resolveCliArgsFromVSCodeExecutablePath(executable);
  const result=spawnSync(cli,[...args,'--no-sandbox','--user-data-dir='+user,'--extensions-dir='+extensions,'--install-extension',path.resolve(process.env.MOGNITIO_TEST_VSIX),'--force'],{stdio:'inherit'});
  if(result.status!==0)throw new Error('VSIX installation failed');
  development=path.join(user,'harness');fs.mkdirSync(development);
  fs.writeFileSync(path.join(development,'package.json'),JSON.stringify({name:'mognitio-test-harness',version:'0.0.0',publisher:'test',engines:{vscode:'^1.91.0'},main:'index.cjs'}));
  fs.writeFileSync(path.join(development,'index.cjs'),'exports.activate=()=>{};');
 }
 const workspaceFile=path.join(user,'fixture.code-workspace');
 fs.writeFileSync(workspaceFile,JSON.stringify({folders:[{path:root}]}));
 const paint=path.resolve('.vscode-test/evidence');fs.mkdirSync(paint,{recursive:true});
 for(const file of ['on','off','on-observed','off-observed'])fs.rmSync(path.join(paint,file),{force:true});
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 let passed=false;const done={finished:false};
 const observation=require('./paint.cjs').observe(port,paint,done,untrusted);
 // Observe rejection immediately while the editor test is still running.
 let observationError;observation.catch(error=>{observationError=error;});
 try{
  if(untrusted){
   const marker=path.join(user,'server-started'),probe=path.join(user,'probe-server');
   fs.writeFileSync(probe,'#!/bin/sh\ntouch "'+marker+'"\necho "mognitio-lsp 0.15.0"\n',{mode:0o755});
   const settingsPath=path.join(user,'User/settings.json');
   const settings=JSON.parse(fs.readFileSync(settingsPath));settings['mognitio.serverPath']=probe;
   fs.writeFileSync(settingsPath,JSON.stringify(settings));
   const child=spawn(executable,[root,'--goto',path.join(root,'src/sample.mgn'),'--user-data-dir='+user,'--extensions-dir='+extensions,'--remote-debugging-port='+port,'--skip-welcome','--skip-release-notes','--disable-gpu','--no-sandbox'],{detached:true,stdio:'ignore'});
   try{await observation;if(fs.existsSync(marker))throw new Error('Untrusted workspace executed a server');console.log('PASS untrusted installed extension: Restricted Mode, lexical association, no server probe or launch');}
   finally{try{process.kill(-child.pid,'SIGTERM');}catch{} if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
   });}
  }else await runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:development,extensionTestsPath:path.resolve('test/editor.cjs'),
   launchArgs:[workspaceFile,'--user-data-dir='+user,'--extensions-dir='+extensions,'--remote-debugging-port='+port,'--skip-welcome','--skip-release-notes','--disable-gpu','--no-sandbox'],
   extensionTestsEnv:{MOGNITIO_EXPECTED_IDENTITY:process.env.MOGNITIO_EXPECTED_IDENTITY||'',MOGNITIO_PAINT_DIRECTORY:paint,MOGNITIO_DIAGNOSTIC_GATE:process.env.MOGNITIO_TEST_DELAY_DIAGNOSTICS==='1'?diagnosticGate:''}});
  await observation;if(observationError)throw observationError;passed=true;
 }finally{done.finished=true;if(passed){fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});fs.rmSync(user,{recursive:true,force:true,maxRetries:5,retryDelay:100});}else console.log('Retained fixture',root,user);}
})().catch(error=>{console.error(error);process.exit(1);});
