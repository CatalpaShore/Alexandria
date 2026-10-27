import type Database from 'better-sqlite3';
import {parseMediaName} from './mediaName.js';

export type PrefixCollection = {
  prefix:string; works:number; files:number; bytes:number; libraryShare:number;
  knownWorks:number; knownCoverage:number; missingWorks:number;
  missing:Array<{code:string;title:string;releaseDate:string|null;provider:string}>;
  providers:string[]; catalogComplete:false; releaseTotal:null; releaseCoverage:null;
  numberRange:{min:number;max:number;slots:number;held:number;coverage:number}|null;
};
export type PrefixAnalytics = {
  totalWorks:number; identifiedWorks:number; unidentifiedWorks:number; prefixes:number;
  knownWorks:number; missingWorks:number; unresolvedCatalogRecords:number; metadataUpdatedAt:string|null; items:PrefixCollection[];
};
type WorkRow={code:string;files:number;bytes:number};
type MetadataRow={code:string;title:string;releaseDate:string|null;provider:string;updatedAt:string|null};

/** The discovered catalog is an explicit lower bound, never a complete release catalog. */
export function getLibraryPrefixAnalytics(db:Database.Database,year:number|null):PrefixAnalytics{
  const params=year===null?[]:[String(year)];
  const yearFilter=year===null?'':"AND strftime('%Y',m.release_date)=?";
  const owned=db.prepare(`SELECT f.normalized_code code,count(*) files,sum(f.size) bytes
    FROM media_files f LEFT JOIN media_metadata m ON m.normalized_code=f.normalized_code
    WHERE f.media_type='video' ${yearFilter}
    GROUP BY CASE WHEN f.normalized_code='' THEN 'file:'||f.id ELSE 'code:'||f.normalized_code END`).all(...params) as WorkRow[];
  const metadata=db.prepare(`SELECT m.normalized_code code,m.title,m.release_date releaseDate,m.provider,m.fetched_at updatedAt
    FROM media_metadata m WHERE m.status='ready' ${yearFilter}`).all(...params) as MetadataRow[];
  const groups=new Map<string,{owned:Map<string,WorkRow>;known:Map<string,MetadataRow|null>}>();
  const canonical=(code:string)=>{const parsed=parseMediaName(code,'');return parsed.codePrefix&&parsed.codePrefix!=='FC2'?`${parsed.codePrefix}-${parsed.codeNumber.replace(/^0+(?=\d{3})/,'')}`:parsed.normalizedCode;};
  const allOwnedCodes=year===null?owned:db.prepare("SELECT DISTINCT normalized_code code FROM media_files WHERE media_type='video'").all() as {code:string}[];
  const ownedAliases=new Map(allOwnedCodes.map(work=>[canonical(work.code),work.code]));
  const ownedPrefixes=new Set(allOwnedCodes.map(work=>parseMediaName(work.code,'').codePrefix));
  const scopedCodes=new Set(owned.map(work=>work.code));
  const prefixFor=(code:string)=>parseMediaName(code,'').codePrefix;
  const group=(prefix:string)=>{let value=groups.get(prefix);if(!value){value={owned:new Map(),known:new Map()};groups.set(prefix,value);}return value;};
  let unidentifiedWorks=0;let unresolvedCatalogRecords=0;
  for(const work of owned){const prefix=prefixFor(work.code);if(!prefix){unidentifiedWorks++;continue;}const value=group(prefix);value.owned.set(work.code,work);value.known.set(work.code,null);ownedAliases.set(canonical(work.code),work.code);}
  for(const work of metadata){
    const parsed=parseMediaName(work.code,'');const heldCode=ownedAliases.get(canonical(work.code));
    // Legacy split errors such as ABP94-009 are ambiguous; never invent a new series/gap.
    if(!parsed.codePrefix||(!ownedPrefixes.has(parsed.codePrefix)&&parsed.codePrefix!=='FC2'&&/\d/.test(parsed.codePrefix))){unresolvedCatalogRecords++;continue;}
    // Conflicting alias dates must not turn a work held in another year into a missing work.
    if(year!==null&&heldCode&&!scopedCodes.has(heldCode))continue;
    if(parsed.codePrefix){const code=heldCode??canonical(work.code);group(parsed.codePrefix).known.set(code,{...work,code});}
  }
  const items:PrefixCollection[]=[...groups].map(([prefix,value]):PrefixCollection=>{
    const works=value.owned.size;const knownWorks=value.known.size;
    const numbers=[...value.known.keys()].map(code=>Number(parseMediaName(code,'').codeNumber));
    const heldNumbers=new Set([...value.owned.keys()].map(code=>Number(parseMediaName(code,'').codeNumber)));
    const min=Math.min(...numbers);const max=Math.max(...numbers);
    // FC2 IDs and very large/suffixed namespaces are not sequential release counts.
    const rangeApplicable=year===null&&prefix!=='FC2'&&numbers.every(n=>Number.isInteger(n)&&n>0&&n<=9999)&&new Set(numbers).size===knownWorks;
    return {prefix,works,files:[...value.owned.values()].reduce((n,w)=>n+w.files,0),bytes:[...value.owned.values()].reduce((n,w)=>n+w.bytes,0),
      libraryShare:owned.length?works/owned.length:0,knownWorks,knownCoverage:knownWorks?works/knownWorks:0,missingWorks:knownWorks-works,
      missing:[...value.known].filter(([code,work])=>work&&!value.owned.has(code)).map(([code,work])=>({code,title:work!.title,releaseDate:work!.releaseDate,provider:work!.provider})).sort((a,b)=>a.code.localeCompare(b.code,'en',{numeric:true})),
      providers:[...new Set([...value.known.values()].map(w=>w?.provider).filter((provider):provider is string=>Boolean(provider)))].sort(),
      catalogComplete:false,releaseTotal:null,releaseCoverage:null,
      numberRange:rangeApplicable?{min,max,slots:max-min+1,held:heldNumbers.size,coverage:heldNumbers.size/(max-min+1)}:null};
  }).sort((a,b)=>b.works-a.works||a.prefix.localeCompare(b.prefix));
  return {totalWorks:owned.length,identifiedWorks:owned.length-unidentifiedWorks,unidentifiedWorks,prefixes:items.length,
    knownWorks:items.reduce((n,item)=>n+item.knownWorks,0),missingWorks:items.reduce((n,item)=>n+item.missingWorks,0),
    unresolvedCatalogRecords,metadataUpdatedAt:metadata.map(w=>w.updatedAt).filter((date):date is string=>Boolean(date)).sort().at(-1)??null,items};
}
