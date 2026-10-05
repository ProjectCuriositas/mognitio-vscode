const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const Module = require('node:module');
const text = buildSync({entryPoints:['src/policy.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const mod = new Module('policy'); mod._compile(text, 'policy.cjs');
const p = mod.exports;
test('formal compatible versions and exact development identities', () => {
  for (const value of ['0.15.0','0.15.10']) assert.equal(p.compatibleVersion(value), true);
  for (const value of ['0.16.0','0.14.9','0.15.0-dev.0','0.15.00','0.15.0+wrong',null]) assert.equal(p.compatibleVersion(value), false);
  assert.equal(p.compatibleVersion('0.15.0-dev.0+g1','0.15.0-dev.0+g2'),false);
});
test('all overlap members are rejected; independent source roots remain', () => {
  assert.deepEqual([...p.conflicts(['/a/src','/a/src/nested/src','/other/src','/a/src'])].sort(),[0,1,3]);
  assert.deepEqual([...p.conflicts(['/a/src','/a/nested/src'])],[]);
});
test('required capabilities are independently validated', () => {
  const good={positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:1},
    semanticTokensProvider:{full:true,legend:{tokenTypes:['type'],tokenModifiers:[]}}};
  assert(p.compatibleCapabilities(good));
  assert(!p.compatibleCapabilities({...good,positionEncoding:'utf-8'}));
  assert(!p.compatibleCapabilities({...good,textDocumentSync:1}));
});
