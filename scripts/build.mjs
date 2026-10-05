import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:'dist/extension.js',sourcemap:false,metafile:true});
const packages = [...new Set(Object.keys(result.metafile.inputs).filter(p=>p.startsWith('node_modules/')).map(p=>{const s=p.split('/'); return s[1].startsWith('@') ? s.slice(1,3).join('/') : s[1];}))].sort();
let notices = '# Third-party notices\n\nLicenses for dependencies included in the bundled extension.\n';
for (const name of packages) {
 const root='node_modules/'+name;
 const metadata=JSON.parse(await readFile(root+'/package.json','utf8'));
 let license;
 for(const candidate of ['LICENSE','LICENSE.md','LICENSE.txt','License.txt']) {try {license=await readFile(root+'/'+candidate,'utf8');break;}catch{}}
 if(!license) throw new Error('Missing license: '+name);
 notices+='\n## '+name+' '+metadata.version+'\n\n'+license.trim()+'\n';
}
await writeFile('THIRD_PARTY_NOTICES.md',notices);
await writeFile('dist/metafile.json',JSON.stringify(result.metafile,null,2));
