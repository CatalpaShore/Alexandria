import fs from "node:fs";
import path from "node:path";
import {config} from "./config.js";

// Curated data belongs in deployment state, outside the public source tree.
export function readOptionalSourceRegistry<T>(filename:string):readonly T[]{
 const file=path.join(config.dataDir,filename);
 if(!fs.existsSync(file))return [];
 if(fs.statSync(file).size>8*1024*1024)throw new Error(`Source registry exceeds 8 MiB: ${filename}`);
 const value:unknown=JSON.parse(fs.readFileSync(file,"utf8"));
 if(!Array.isArray(value)||value.some(item=>!item||typeof item!=="object"||Array.isArray(item)))throw new Error(`Expected a source registry array: ${filename}`);
 return value as T[];
}
