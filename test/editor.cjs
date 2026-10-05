const vscode = require('vscode');
const assert = require('node:assert/strict');
async function until(fn, label) {
  const deadline=Date.now()+20000;
  while(Date.now()<deadline) {const value=await fn();if(value)return value; await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timeout: '+label);
}
exports.run=async()=>{
  const extension=vscode.extensions.getExtension('ProjectCuriositas.mognitio');
  assert(extension);await extension.activate();
  const uri=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'src/sample.mgn');
  const doc=await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  assert.equal(doc.languageId,'mognitio');
  const tokens=await until(async()=>{
    const t=await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri);
    return t?.data?.length?t:null;
  },'semantic provider');
  assert(tokens.data.length>=5);
  const fs=require('node:fs'),path=require('node:path');
  const paint=process.env.MOGNITIO_PAINT_DIRECTORY;
  fs.writeFileSync(path.join(paint,'on'),'ready');
  await until(()=>fs.existsSync(path.join(paint,'on-observed')),'semantic paint on');
  await vscode.workspace.getConfiguration('editor').update('semanticHighlighting.enabled',false,vscode.ConfigurationTarget.Global);
  fs.writeFileSync(path.join(paint,'off'),'ready');
  await until(()=>fs.existsSync(path.join(paint,'off-observed')),'semantic paint off');
  await vscode.workspace.getConfiguration('editor').update('semanticHighlighting.enabled',true,vscode.ConfigurationTarget.Global);
  const edit=new vscode.WorkspaceEdit();
  edit.replace(uri,new vscode.Range(1,0,1,doc.lineAt(1).text.length),'let value: Int = false;');
  await vscode.workspace.applyEdit(edit);
  await until(()=>vscode.languages.getDiagnostics(uri).some(d=>d.source==='Mognitio'),'unsaved type diagnostic');
  const fix=new vscode.WorkspaceEdit();
  fix.replace(uri,new vscode.Range(1,0,1,doc.lineAt(1).text.length),'let value: Int = 2;');
  await vscode.workspace.applyEdit(fix);
  await until(()=>!vscode.languages.getDiagnostics(uri).some(d=>d.source==='Mognitio'),'cleared diagnostic');
  await vscode.commands.executeCommand('mognitio.restartServer');
  await until(async()=> {
    const t=await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri);
    return t?.data?.length;
  },'tokens after restart');
  // Disk dependencies invalidate diagnostics even when the edited document is unchanged.
  const dependency=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'src/dependency.mgn');
  await vscode.workspace.fs.writeFile(dependency,Buffer.from('namespace Example;\nlet broken: Int = false;\n'));
  await until(()=>vscode.languages.getDiagnostics(dependency).some(d=>d.source==='Mognitio'),'new dependency diagnostics');
  await vscode.workspace.fs.delete(dependency);
  await until(()=>!vscode.languages.getDiagnostics(dependency).some(d=>d.source==='Mognitio'),'deleted dependency clears');

  const manifest=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'mognitio.toml');
  await vscode.workspace.fs.writeFile(manifest,Buffer.from('[project]\nname = 123\nroot_namespace = "Example"\n'));
  await until(()=>vscode.languages.getDiagnostics(manifest).some(d=>d.source==='Mognitio'),'disk manifest diagnostics');
  const manifestDoc=await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(manifestDoc);
  const foreign=vscode.languages.createDiagnosticCollection('fixture-toml');
  foreign.set(manifest,[new vscode.Diagnostic(new vscode.Range(0,0,0,1),'Foreign diagnostic')]);
  const dirty=new vscode.WorkspaceEdit();dirty.insert(manifest,new vscode.Position(0,0),'\n');
  await vscode.workspace.applyEdit(dirty);
  await until(()=>!vscode.languages.getDiagnostics(manifest).some(d=>d.source==='Mognitio'),'dirty manifest suppresses positions');
  assert(vscode.languages.getDiagnostics(manifest).some(d=>d.message==='Foreign diagnostic'));
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await until(()=>vscode.languages.getDiagnostics(manifest).some(d=>d.source==='Mognitio'),'discard restores cached diagnostics');
  foreign.dispose();
  await vscode.workspace.fs.writeFile(manifest,Buffer.from('[project]\nname = "sample"\nroot_namespace = "Example"\n'));
  await until(()=>!vscode.languages.getDiagnostics(manifest).some(d=>d.source==='Mognitio'),'saved manifest correction');
  await vscode.window.showTextDocument(doc);
  if(process.env.MOGNITIO_DIAGNOSTIC_GATE){
    const gate=process.env.MOGNITIO_DIAGNOSTIC_GATE;
    fs.writeFileSync(path.join(gate,'arm'),uri.toString());
    const error=new vscode.WorkspaceEdit();
    error.replace(uri,new vscode.Range(1,0,1,doc.lineAt(1).text.length),'let value: Int = false;');
    await vscode.workspace.applyEdit(error);
    await until(()=>fs.existsSync(path.join(gate,'held')),'old diagnostic captured in FIFO transport');
    const held=JSON.parse(fs.readFileSync(path.join(gate,'held'),'utf8'));
    assert.equal(held.version,doc.version);
    const correction=new vscode.WorkspaceEdit();
    correction.replace(uri,new vscode.Range(1,0,1,doc.lineAt(1).text.length),'let value: Int = 3;');
    await vscode.workspace.applyEdit(correction);
    assert(doc.version>held.version);
    const stale=[];
    const listener=vscode.languages.onDidChangeDiagnostics(e=>{
      if(e.uris.some(u=>u.toString()===uri.toString()))
        stale.push(...vscode.languages.getDiagnostics(uri).filter(d=>d.source==='Mognitio'));
    });
    try{
      fs.writeFileSync(path.join(gate,'release'),'ready');
      await until(()=>fs.existsSync(path.join(gate,'released')),'old diagnostic delivered');
      // Hold later frames until the stale push has had time to reach the editor.
      await new Promise(r=>setTimeout(r,500));
      assert.deepEqual(stale,[],'old document diagnostics must never reappear');
      assert(!vscode.languages.getDiagnostics(uri).some(d=>d.source==='Mognitio'));
      fs.writeFileSync(path.join(gate,'continue'),'ready');
      await until(async()=>(await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri))?.data?.length,'latest analysis after delayed diagnostic');
      console.log('PASS FIFO delayed diagnostic discarded after document version changed');
    }finally{fs.writeFileSync(path.join(gate,'continue'),'ready');listener.dispose();}
    return;
  }
  // A crashed owned server must not restart until the explicit command.
  const children=fs.readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children','utf8').trim().split(' ').filter(Boolean);
  const servers=children.filter(pid=>{try{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('/lsp/server.py');}catch{return false;}});
  assert.equal(servers.length,1);
  process.kill(Number(servers[0]),'SIGKILL');
  await until(async()=>!await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri),'crashed provider removed');
  await new Promise(r=>setTimeout(r,300));
  assert(!fs.existsSync('/proc/'+servers[0]));
  await vscode.commands.executeCommand('mognitio.restartServer');
  await until(async()=>(await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri))?.data?.length,'explicit crash recovery');

  async function project(parent,name,namespace){
   const folder=vscode.Uri.joinPath(parent,name);
   await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder,'src'));
   await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder,'mognitio.toml'),Buffer.from('[project]\nname = "sample"\nroot_namespace = "'+namespace+'"\n'));
   await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder,'src/sample.mgn'),Buffer.from('namespace '+namespace+';\nlet value: Int = 1;\n'));
   return folder;
  }
  const base=vscode.workspace.workspaceFolders[0].uri;
  const independent=await project(base,'independent','Other');
  assert(vscode.workspace.updateWorkspaceFolders(1,0,{uri:independent,name:'Independent'}));
  const other=vscode.Uri.joinPath(independent,'src/sample.mgn');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(other));
  await until(async()=>(await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',other))?.data?.length,'independent nested src');
  const overlap=await project(vscode.Uri.joinPath(base,'src'),'overlap','Overlap');
  assert(vscode.workspace.updateWorkspaceFolders(2,0,{uri:overlap,name:'Overlap'}));
  await until(async()=>!await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri),'overlap suspends original root');
  assert((await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',other))?.data?.length);
  await vscode.workspace.fs.delete(overlap,{recursive:true});
  assert(vscode.workspace.updateWorkspaceFolders(2,1));
  await until(async()=>(await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri))?.data?.length,'resolved overlap resumes root');
  assert(vscode.workspace.updateWorkspaceFolders(1,1));
  await vscode.workspace.fs.delete(independent,{recursive:true});
  console.log('PASS installed extension: semantic paint on/off, overlays, correction, restart, dependency create/delete, dirty manifest suppression/discard, foreign diagnostics, crash/restart, root overlap/isolation/resumption');

};
