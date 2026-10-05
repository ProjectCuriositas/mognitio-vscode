const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const Module = require('node:module');
const text=buildSync({entryPoints:['src/manifest.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const mod=new Module('manifest');mod._compile(text,'manifest.cjs');
const {ManifestDiagnostics}=mod.exports;
test('discard without disk changes restores the latest received cache',()=>{
 const cache=new ManifestDiagnostics();cache.publish('old',['error']);
 assert.equal(cache.visible(true),undefined);
 cache.observe('old');assert.deepEqual(cache.visible(false),['error']);
});
test('save with changed disk invalidates old cache until a new publish',()=>{
 const cache=new ManifestDiagnostics();cache.publish('old',['error']);
 cache.observe('new');assert.equal(cache.visible(false),undefined);
 cache.observe('new');assert.equal(cache.visible(false),undefined);
 cache.publish('new',[]);assert.deepEqual(cache.visible(false),[]);
});
test('publish while dirty updates cache but remains hidden',()=>{
 const cache=new ManifestDiagnostics();cache.publish('disk',['old']);
 cache.publish('disk',['new']);assert.equal(cache.visible(true),undefined);
 cache.observe('disk');assert.deepEqual(cache.visible(false),['new']);
});
test('unreadable disk cannot revive a prior diagnostic set',()=>{
 const cache=new ManifestDiagnostics();cache.publish('disk',['error']);
 cache.observe(undefined);cache.observe('disk');assert.equal(cache.visible(false),undefined);
 cache.publish(undefined,['unknown']);assert.equal(cache.visible(false),undefined);
});
test('external disk change and disposal invalidate cache',()=>{
 const cache=new ManifestDiagnostics();cache.publish('one',['error']);
 cache.observe('two');assert.equal(cache.visible(false),undefined);
 cache.publish('two',['new']);cache.clear();assert.equal(cache.visible(false),undefined);
});
