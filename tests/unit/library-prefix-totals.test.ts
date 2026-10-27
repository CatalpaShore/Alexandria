import Database from 'better-sqlite3';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {getLibraryPrefixAnalytics} from '../../server/src/libraryPrefixAnalytics';
import {getPrefixTotals,PREFIX_TOTALS_SCHEMA,savePrefixTotal} from '../../server/src/libraryPrefixTotals';
import {prefixCollectionProgress} from '../../client/src/lib/prefixCollectionProgress';

let db:Database.Database;
beforeEach(()=>{
  db=new Database(':memory:');
  db.exec(`CREATE TABLE media_files(id TEXT PRIMARY KEY,normalized_code TEXT,media_type TEXT,size INTEGER);
    CREATE TABLE media_metadata(normalized_code TEXT PRIMARY KEY,title TEXT,release_date TEXT,provider TEXT,fetched_at TEXT,status TEXT);${PREFIX_TOTALS_SCHEMA}`);
  const insert=db.prepare("INSERT INTO media_files VALUES(?,?,'video',100)");
  for(let n=8;n<353;n++) insert.run(String(n),`SONE-${String(n).padStart(3,'0')}`);
  insert.run('999','SONE-999');insert.run('copy','SONE-008');
});
afterEach(()=>db.close());
const sone=()=>getLibraryPrefixAnalytics(db,null).items[0];

describe('series collection progress and saved denominators',()=>{
  it('uses 001 through the maximum, not the observed minimum, and labels that as an estimate',()=>{
    expect(sone()).toMatchObject({works:346,files:347,numberRange:{min:8,max:999,slots:992}});
    expect(prefixCollectionProgress(sone(),undefined,null)).toEqual({total:999,owned:346,remaining:653,coverage:346/999,basis:'estimate',outdated:false});
  });
  it('persists an explicit total separately from the incomplete catalog and can restore the estimate',()=>{
    expect(savePrefixTotal(db,'SONE',999)).toMatchObject([{prefix:'SONE',total:999}]);
    expect(prefixCollectionProgress(sone(),getPrefixTotals(db)[0].total,null)).toMatchObject({coverage:346/999,basis:'manual'});
    expect(sone()).toMatchObject({releaseCoverage:null,releaseTotal:null,catalogComplete:false});
    savePrefixTotal(db,'SONE',1000);expect(getPrefixTotals(db)[0].total).toBe(1000);
    savePrefixTotal(db,'SONE',null);expect(getPrefixTotals(db)).toEqual([]);
  });
  it('rejects impossible totals and nonexistent series without altering saved data',()=>{
    savePrefixTotal(db,'SONE',999);
    for(const total of [0,345,998.5,NaN,10000001]) expect(()=>savePrefixTotal(db,'SONE',total)).toThrow();
    expect(()=>savePrefixTotal(db,'MISSING',999)).toThrow();
    expect(getPrefixTotals(db)[0].total).toBe(999);
  });
  it('does not mix a year numerator with a lifetime denominator or invent FC2 totals',()=>{
    expect(prefixCollectionProgress(sone(),999,2024)).toBeNull();
    const fc2={...sone(),prefix:'FC2',numberRange:null};
    expect(prefixCollectionProgress(fc2,undefined,null)).toBeNull();
    expect(prefixCollectionProgress(fc2,1000,null)).toMatchObject({total:1000,basis:'manual'});
  });
  it('marks outdated totals for correction when catalog growth overtakes the denominator',()=>{
    expect(prefixCollectionProgress({...sone(),works:1001,knownWorks:1001},999,null)).toMatchObject({outdated:true,remaining:0});
  });
});
