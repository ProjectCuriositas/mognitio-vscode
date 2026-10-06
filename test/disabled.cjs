const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs');
exports.run=async()=>{
 assert(vscode.workspace.isTrusted,'fixture must be trusted so disabling is the reason for no launch');
 const uri=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'src/sample.mgn');
 await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
 await new Promise(resolve=>setTimeout(resolve,800));
 assert(!vscode.extensions.getExtension('mognitio.mognitio')?.isActive);
 assert(!await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens',uri));
 assert(!vscode.languages.getDiagnostics(uri).some(d=>d.source==='Mognitio'));
 assert(!fs.existsSync(process.env.MOGNITIO_DISABLED_MARKER),'disabled extension must not even probe a server');
 console.log('PASS disabled installed VSIX: trusted workspace, no activation, server probe, semantic provider or diagnostics');
};
