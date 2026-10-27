import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {describe,expect,it} from "vitest";
import {preparePublicUpgrade} from "../../server/src/database/upgrade.js";

describe("legacy SQLite upgrade",()=>{
 it("backs up committed WAL content before public schema changes and rejects future versions",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"alexandria-upgrade-")),file=path.join(root,"library.sqlite");const db=new Database(file);db.pragma("journal_mode=WAL");db.exec("CREATE TABLE media_files(id TEXT PRIMARY KEY); INSERT INTO media_files VALUES('proven-legacy-id')");
  preparePublicUpgrade(db,file);const backup=path.join(root,"upgrade-backups",fs.readdirSync(path.join(root,"upgrade-backups"))[0]);const copy=new Database(backup,{readonly:true});expect(copy.prepare("SELECT id FROM media_files").get()).toEqual({id:"proven-legacy-id"});expect(copy.prepare("SELECT 1 FROM sqlite_master WHERE name='alexandria_schema'").get()).toBeUndefined();copy.close();
  preparePublicUpgrade(db,file);expect(fs.readdirSync(path.join(root,"upgrade-backups"))).toHaveLength(1);db.exec("UPDATE alexandria_schema SET version=99");expect(()=>preparePublicUpgrade(db,file)).toThrow("Unsupported");db.close();fs.rmSync(root,{recursive:true,force:true});
 });
});
