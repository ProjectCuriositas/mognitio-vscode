const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs');
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout: '+label);}
function servers(){return fs.readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children','utf8').trim().split(' ').filter(Boolean).filter(pid=>{
 try{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('/lsp/server.py');}catch{return false;}
}).sort();}
const errors=uri=>vscode.languages.getDiagnostics(uri).filter(d=>d.source==='Mognitio');
exports.run=async()=>{
 const base=vscode.workspace.workspaceFolders[0].uri,initial=servers();assert.equal(initial.length,1);
 const closed=new Set();const closeListener=vscode.workspace.onDidCloseTextDocument(d=>closed.add(d.uri.toString()));
 async function open(name,text){const uri=vscode.Uri.joinPath(base,name);await vscode.workspace.fs.writeFile(uri,Buffer.from(text));const doc=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(doc,{preview:false});return doc;}
 const a=await open('loose[a].mgn','let value: Int = ;\n');
 await until(()=>errors(a.uri).length,'standalone A diagnostics');
 const shared=servers().filter(pid=>!initial.includes(pid));assert.equal(shared.length,1);const pid=shared[0];
 const b=await open('loose{b}.mgn','let other: Int = ;\n');
 await until(()=>errors(b.uri).length,'new standalone B diagnostics');assert.deepEqual(servers().filter(p=>!initial.includes(p)),[pid]);
 assert(errors(a.uri).length,'adding B must retain A diagnostics');
 const edit=new vscode.WorkspaceEdit();edit.replace(b.uri,new vscode.Range(b.positionAt(0),b.positionAt(b.getText().length)),'let other: Int = 1;\n');
 await vscode.workspace.applyEdit(edit);await until(()=>!errors(b.uri).length,'standalone change reaches same server');assert(await b.save());
 // VS Code can retain a document after its tab closes. A language change
 // deterministically emits didClose for the old Mognitio document.
 await vscode.languages.setTextDocumentLanguage(b,'plaintext');
 await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
 await until(()=>closed.has(b.uri.toString()),'close standalone B');assert(fs.existsSync('/proc/'+pid));assert(errors(a.uri).length);

 // Move an open document between syntax-only and project ownership while A stays open.
 const project=vscode.Uri.joinPath(base,'rootless-transfer');await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(project,'src'));
 await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(project,'mognitio.toml'),Buffer.from('[project]\nname = "transfer"\nroot_namespace = "Transfer"\n'));
 const moved=await open('rootless-transfer/src/moved.mgn','namespace Transfer;\nlet value: Int = ;\n');
 await until(()=>errors(moved.uri).length,'transfer fixture initially standalone');
 const correction=new vscode.WorkspaceEdit();correction.replace(moved.uri,new vscode.Range(moved.positionAt(0),moved.positionAt(moved.getText().length)),
  'namespace Transfer;\nlet value: Int = false;\n');
 await vscode.workspace.applyEdit(correction);assert(await moved.save());await until(()=>!errors(moved.uri).length,'standalone does not type-check');
 assert(vscode.workspace.updateWorkspaceFolders(1,0,{uri:project,name:'Transfer'}));
 await until(()=>errors(moved.uri).length,'workspace owner type-checks transferred document');
 assert(fs.existsSync('/proc/'+pid));assert.equal(servers().length,3);
 assert(vscode.workspace.updateWorkspaceFolders(1,1));
 await until(()=>servers().length===2&&!errors(moved.uri).length,'transfer back removes project diagnostics');
 assert(fs.existsSync('/proc/'+pid));assert(errors(a.uri).length);
 await vscode.languages.setTextDocumentLanguage(moved,'plaintext');
 await vscode.commands.executeCommand('workbench.action.closeActiveEditor');await until(()=>closed.has(moved.uri.toString()),'close transferred document');
 await vscode.window.showTextDocument(a,{preview:false});await vscode.languages.setTextDocumentLanguage(a,'plaintext');await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
 await until(()=>closed.has(a.uri.toString())&&!fs.existsSync('/proc/'+pid),'last standalone close stops shared server');
 assert(!errors(a.uri).length);assert.deepEqual(servers(),initial);closeListener.dispose();
 for(const doc of [a,b])await vscode.workspace.fs.delete(doc.uri);
 await vscode.workspace.fs.delete(project,{recursive:true});
 console.log('PASS standalone lifecycle: stable PID, exact selectors, add/change/close, workspace transfer in both directions, last-close cleanup');
};
