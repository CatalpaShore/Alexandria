import Database from 'better-sqlite3';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {getLibraryPrefixAnalytics} from '../../server/src/libraryPrefixAnalytics';

let db:Database.Database;
beforeEach(()=>{
  db=new Database(':memory:');
  db.exec(`CREATE TABLE media_files(id TEXT PRIMARY KEY,normalized_code TEXT,media_type TEXT,size INTEGER);
    CREATE TABLE media_metadata(normalized_code TEXT PRIMARY KEY,title TEXT,release_date TEXT,provider TEXT,fetched_at TEXT,status TEXT);`);
});
afterEach(()=>db.close());
function file(id:string,code:string,type='video'){db.prepare('INSERT INTO media_files VALUES(?,?,?,100)').run(id,code,type);}
function metadata(code:string,status='ready',date:string|null='2024-01-01'){db.prepare("INSERT INTO media_metadata VALUES(?,? ,?,'test-provider','2026-09-12T12:00:00Z',?)").run(code,code+' title',date,status);}

describe('prefix collection denominators',()=>{
  it('deduplicates versions across files and separates catalog coverage from library share',()=>{
    file('a','TEST-001');file('a-copy','TEST-001');file('b','TEST-003');file('c','OTHER-001');file('unknown','');file('image','TEST-009','image');
    metadata('TEST-001');metadata('TEST-002');metadata('TEST-003','failed');metadata('TEST-005','not_found');metadata('TEST-010','pending');
    const result=getLibraryPrefixAnalytics(db,null);const item=result.items.find(row=>row.prefix==='TEST')!;
    expect(result).toMatchObject({totalWorks:4,identifiedWorks:3,unidentifiedWorks:1,missingWorks:1});
    expect(item).toMatchObject({works:2,files:3,bytes:300,libraryShare:.5,knownWorks:3,knownCoverage:2/3,missingWorks:1,catalogComplete:false,releaseTotal:null,releaseCoverage:null});
    expect(item.missing.map(row=>row.code)).toEqual(['TEST-002']);
    expect(item.numberRange).toEqual({min:1,max:3,slots:3,held:2,coverage:2/3});
  });
  it('never interprets a complete local catalog as a complete release series or infers releases from gaps',()=>{
    file('a','TEST-010');file('b','TEST-020');metadata('TEST-010');metadata('TEST-020');
    const item=getLibraryPrefixAnalytics(db,null).items[0];
    expect(item).toMatchObject({knownWorks:2,knownCoverage:1,missingWorks:0,releaseTotal:null,releaseCoverage:null});
    expect(item.numberRange).toMatchObject({min:10,max:20,slots:11,held:2,coverage:2/11});expect(item.missing).toEqual([]);
  });
  it('applies the same release year to numerator and denominator and excludes undated works',()=>{
    file('a','TEST-001');file('b','TEST-002');file('undated','TEST-009');
    metadata('TEST-001');metadata('TEST-002','ready','2023-01-01');metadata('TEST-003');metadata('TEST-004','ready','2023-01-01');metadata('TEST-009','ready',null);
    const result=getLibraryPrefixAnalytics(db,2024);expect(result.totalWorks).toBe(1);
    expect(result.items[0]).toMatchObject({works:1,knownWorks:2,knownCoverage:.5,libraryShare:1,missingWorks:1,numberRange:null});
    expect(result.items[0].missing[0].code).toBe('TEST-003');
  });
  it('supports known but uncollected series and avoids huge or FC2 interval estimates',()=>{
    file('fc2','FC2-PPV-1234567');metadata('FC2-PPV-2345678');metadata('ZERO-001');file('large','BIG-999999');
    const result=getLibraryPrefixAnalytics(db,null);
    expect(result.items.find(item=>item.prefix==='FC2')).toMatchObject({works:1,knownWorks:2,knownCoverage:.5,numberRange:null});
    expect(result.items.find(item=>item.prefix==='BIG')?.numberRange).toBeNull();
    expect(result.items.find(item=>item.prefix==='ZERO')).toMatchObject({works:0,knownWorks:1,knownCoverage:0,libraryShare:0,missingWorks:1});
  });
  it('keeps empty libraries and all unidentified files finite',()=>{
    expect(getLibraryPrefixAnalytics(db,null)).toMatchObject({totalWorks:0,identifiedWorks:0,knownWorks:0,items:[]});
    file('unknown-1','');file('unknown-2','');file('unparsed','a title without code');
    expect(getLibraryPrefixAnalytics(db,null)).toMatchObject({totalWorks:3,identifiedWorks:0,unidentifiedWorks:3,items:[]});
  });
  it('does not advertise short or compact metadata aliases of owned codes as missing works',()=>{
    file('held','TEST-003');metadata('TEST-03');metadata('TEST003');metadata('TEST-030');metadata('TEST-30');
    const item=getLibraryPrefixAnalytics(db,null).items[0];
    expect(item).toMatchObject({works:1,knownWorks:2,missingWorks:1,knownCoverage:.5});
    expect(item.missing.map(work=>work.code)).toEqual(['TEST-030']);
  });
  it('does not treat an alias with a conflicting year as an uncollected work',()=>{
    file('held','TEST-003');metadata('TEST-003','ready','2023-01-01');metadata('TEST-03','ready','2024-01-01');
    expect(getLibraryPrefixAnalytics(db,2024)).toMatchObject({totalWorks:0,knownWorks:0,missingWorks:0,items:[]});
  });
  it('normalizes excess padding and excludes ambiguous historical series splits',()=>{
    file('held','TEST-379');metadata('TEST-0379');metadata('ABP94-009');metadata('text without code');
    const result=getLibraryPrefixAnalytics(db,null);
    expect(result).toMatchObject({knownWorks:1,missingWorks:0,unresolvedCatalogRecords:2});expect(result.items).toHaveLength(1);
  });
});
