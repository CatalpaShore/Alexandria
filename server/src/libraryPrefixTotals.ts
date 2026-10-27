import type Database from 'better-sqlite3';
import {getLibraryPrefixAnalytics} from './libraryPrefixAnalytics.js';

export type PrefixTotal = {prefix:string; total:number; updatedAt:string};
export const PREFIX_TOTALS_SCHEMA = `CREATE TABLE IF NOT EXISTS library_prefix_totals (
  prefix TEXT PRIMARY KEY, total INTEGER NOT NULL CHECK(total > 0), updated_at TEXT NOT NULL
);`;

export function getPrefixTotals(db:Database.Database):PrefixTotal[] {
  return db.prepare('SELECT prefix,total,updated_at updatedAt FROM library_prefix_totals ORDER BY prefix').all() as PrefixTotal[];
}

export function savePrefixTotal(db:Database.Database,prefix:string,total:number|null):PrefixTotal[] {
  const item=getLibraryPrefixAnalytics(db,null).items.find(row=>row.prefix===prefix);
  if(!item) throw new Error('该番号系列不在当前目录中');
  if(total!==null && (!Number.isSafeInteger(total)||total<Math.max(1,item.knownWorks)||total>10000000)) {
    throw new Error(`总量须为 ${Math.max(1,item.knownWorks)} 至 10,000,000 的整数，不能少于已有的已知作品`);
  }
  if(total===null) db.prepare('DELETE FROM library_prefix_totals WHERE prefix=?').run(prefix);
  else db.prepare(`INSERT INTO library_prefix_totals(prefix,total,updated_at) VALUES(?,?,?)
    ON CONFLICT(prefix) DO UPDATE SET total=excluded.total,updated_at=excluded.updated_at`).run(prefix,total,new Date().toISOString());
  return getPrefixTotals(db);
}
