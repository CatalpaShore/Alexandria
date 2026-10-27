import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
const args=["licenses","list","--prod","--json"];
if(process.env.PNPM_STORE_DIR)args.unshift(`--config.store-dir=${process.env.PNPM_STORE_DIR}`);
const data=JSON.parse(execFileSync("pnpm",args,{encoding:"utf8",maxBuffer:8*1024*1024}));
if(data.error)throw new Error(data.error.message);
const packages=Object.values(data).flat().sort((a,b)=>a.name.localeCompare(b.name));
const inventory=[],notices=[];
for(const pkg of packages){
 const root=pkg.paths[0];
 const files=fs.readdirSync(root).filter(name=>/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)&&fs.statSync(path.join(root,name)).isFile());
 const texts=files.map(file=>`### ${file}\n\n${fs.readFileSync(path.join(root,file),"utf8")}`).join("\n\n");
 let license=pkg.license;
 if(license==="Unknown"&&pkg.name==="ini"&&/Permission is hereby granted, free of charge/.test(texts))license="MIT (verified from packaged LICENSE)";
 if(license==="Unknown")throw new Error(`Review missing dependency license: ${pkg.name}`);
 inventory.push({name:pkg.name,versions:pkg.versions,license,homepage:pkg.homepage??"",author:pkg.author??"",noticeFiles:files});
 notices.push(`## ${pkg.name} ${pkg.versions.join(", ")}\n\nLicense: ${license}\n\n${pkg.homepage?`Source: ${pkg.homepage}\n\n`:""}${texts||"The installed package declares the license above. Its distribution does not include a separate license file; preserve its package metadata and inline notices when redistributing."}`);
}
fs.mkdirSync("docs",{recursive:true});
fs.writeFileSync("docs/dependency-licenses.json",JSON.stringify({scope:"production dependencies",packages:inventory},null,2)+"\n");
fs.writeFileSync("THIRD_PARTY_NOTICES.md","# Third-party notices\n\nThe Alexandria project license covers its own code. Dependencies retain their original terms, copyrights and notices. This inventory reflects the locked production dependencies. GSAP uses its [Standard No Charge license](https://gsap.com/standard-license/); it is not relicensed under MIT. FFmpeg and external model/media licenses are separate and are not covered by this JavaScript inventory.\n\nThe `buffers` transitive dependency is resolved to the API-compatible `node-buffers@0.1.1` package with an explicit MIT/X11 declaration.\n\n"+notices.join("\n\n"));
console.log(`Recorded ${inventory.length} production dependency entries without local paths.`);
