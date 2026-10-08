const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const tm=require('vscode-textmate'),onig=require('vscode-oniguruma');
const wasm=fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
const ready=onig.loadWASM(wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength));
const registry=new tm.Registry({onigLib:ready.then(()=>({createOnigScanner:p=>new onig.OnigScanner(p),createOnigString:s=>new onig.OnigString(s)})),
 loadGrammar:async()=>JSON.parse(fs.readFileSync(process.env.MOGNITIO_TEST_GRAMMAR||'syntaxes/mognitio.tmLanguage.json','utf8'))});
const grammar=registry.loadGrammar('source.mognitio');
for(const source of ['let text: String = "unfinished','let text: String = "unfinished\\','let text: String = "unfinished\r']) {
 test('unterminated strings recover at end of line: '+JSON.stringify(source),async()=>{
  const g=await grammar,first=g.tokenizeLine(source),second=g.tokenizeLine('let value: Int = 123; // next line',first.ruleStack);
  assert(first.tokens.some(t=>t.scopes.includes('string.quoted.double.mognitio')));
  assert(second.tokens.every(t=>!t.scopes.includes('string.quoted.double.mognitio')));
  assert(second.tokens.some(t=>t.scopes.includes('keyword.control.mognitio')));
  assert(second.tokens.some(t=>t.scopes.includes('constant.numeric.mognitio')));
  assert(second.tokens.some(t=>t.scopes.includes('comment.line.double-slash.mognitio')));
 });
}
test('escaped quotes and newline escapes stay inside a valid single-line string',async()=>{
 const g=await grammar,line='let text: String = "a\\"b\\n"; let next: Int = 1;',result=g.tokenizeLine(line);
 const scopeAt=i=>result.tokens.find(t=>t.startIndex<=i&&t.endIndex>i).scopes;
 assert(scopeAt(line.indexOf('b')).includes('string.quoted.double.mognitio'));
 assert(scopeAt(line.indexOf('\\n')).includes('constant.character.escape.mognitio'));
 assert(!scopeAt(line.indexOf('next')).includes('string.quoted.double.mognitio'));
 assert(g.tokenizeLine('// " is a comment',result.ruleStack).tokens[0].scopes.includes('comment.line.double-slash.mognitio'));
});
