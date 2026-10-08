const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const Module = require('node:module');
const text = buildSync({entryPoints:['src/diagnostics.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const mod = new Module('diagnostics'); mod._compile(text, 'diagnostics.cjs');
const {DiagnosticGate} = mod.exports;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('reject an old document version at receipt before conversion',async()=>{
 const gate=new DiagnosticGate();let converted=false,applied=false;
 await gate.publish('a',()=>false,async()=>{converted=true;return [];},()=>{applied=true;});
 assert(!converted);assert(!applied);
});
test('recheck version after asynchronous conversion',async()=>{
 const gate=new DiagnosticGate(),conversion=deferred();let version=1,applied=false;
 const job=gate.publish('a',()=>version===1,()=>conversion.promise,()=>{applied=true;});
 version=2;conversion.resolve(['old']);await job;assert(!applied);
});
test('latest receive wins even when earlier conversion finishes last',async()=>{
 const gate=new DiagnosticGate(),older=deferred(),seen=[];
 const job=gate.publish('a',()=>true,()=>older.promise,d=>seen.push(d));
 await gate.publish('a',()=>true,async()=>[],d=>seen.push(d));
 older.resolve(['old']);await job;assert.deepEqual(seen,[[]]);
});
test('stop or ownership loss during conversion prevents apply',async()=>{
 for(const reason of ['stop','move']){
  const gate=new DiagnosticGate(),conversion=deferred();let valid=true,applied=false;
  const job=gate.publish('a',()=>valid,()=>conversion.promise,()=>{applied=true;});
  valid=false;gate.clear();conversion.resolve([reason]);await job;assert(!applied);
 }
});
test('independent URI publishes do not invalidate each other',async()=>{
 const gate=new DiagnosticGate(),a=deferred(),seen=[];
 const job=gate.publish('a',()=>true,()=>a.promise,d=>seen.push(d));
 await gate.publish('b',()=>true,async()=>['b'],d=>seen.push(d));
 a.resolve(['a']);await job;assert.deepEqual(seen,[['b'],['a']]);
});

test('retired URI bookkeeping cannot alias a later publish after reacquisition',async()=>{
 const gate=new DiagnosticGate(),old=deferred(),fresh=deferred(),shown=[];
 const retired=gate.publish('a',()=>true,()=>old.promise,value=>shown.push(value));
 gate.forget('a');
 assert.equal(gate.sequence.size,0);
 const current=gate.publish('a',()=>true,()=>fresh.promise,value=>shown.push(value));
 old.resolve('old');await retired;assert.deepEqual(shown,[]);
 fresh.resolve('new');await current;assert.deepEqual(shown,['new']);
 gate.forget('a');assert.equal(gate.sequence.size,0);
});
