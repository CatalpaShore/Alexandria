import Database from 'better-sqlite3';
import {describe,expect,it} from 'vitest';
import {entitySoloFilter} from '../../server/src/queries/entitySoloFilter';

describe('actor solo-work filtering',()=>{
  it('uses explicit multilingual genre tags, preserves logical versions, and excludes unknown casts',()=>{
    const db=new Database(':memory:');
    try {
      db.exec(`CREATE TABLE media_files(id TEXT,normalized_code TEXT,media_type TEXT);
        CREATE TABLE media_metadata_facets(normalized_code TEXT,facet_type TEXT,facet_value TEXT);
        INSERT INTO media_files VALUES('1','A','video'),('2','A','video'),('3','B','video'),('4','C','video'),('5','D','video'),('6','E','image');
        INSERT INTO media_metadata_facets VALUES('A','genre','単体作品'),('B','genre','单体作品'),('C','genre','單體作品'),('D','actor','Only known actor'),('E','genre','単体作品');`);
      const rows=db.prepare(`SELECT DISTINCT normalized_code code FROM media_files WHERE 1=1 ${entitySoloFilter('actor',true)} ORDER BY code`).all();
      expect(rows).toEqual([{code:'A'},{code:'B'},{code:'C'}]);
      expect(db.prepare(`SELECT count(*) n FROM media_files WHERE 1=1 ${entitySoloFilter('actor',false)}`).get()).toEqual({n:6});
      expect(entitySoloFilter('genre',true)).toBe('');
    } finally {db.close();}
  });
});
