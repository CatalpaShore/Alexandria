import {db,replaceMetadataFacetsForCode} from "../../server/src/db.js";
export function seedNeutralLibrary():void {
  db.transaction(()=>{
    for(let i=0;i<216;i++){
      const code=`DEMO-${String(i+1).padStart(3,"0")}`,id=`neutral-${i}`;
      const actor=`Demo Creator ${i%18+1}`,genre=`Demo Theme ${Math.floor(i/18)%12+1}`;
      db.prepare(`INSERT INTO media_files(id,library_category,source_name,source_root,relative_path,absolute_path,name,basename,extension,mime_type,size,mtime_ms,directory,first_letter,normalized_code,media_type,indexed_at,scan_token,duration_seconds,width,height,probe_status,compatibility_status) VALUES(?, 'LOCAL','Demo','/demo',?,? ,?,?,'mp4','video/mp4',1024,1,'','D',?,'video','2026-01-01','test',60,1920,1080,'ready','native')`).run(id,`LOCAL/Demo/${code}.mp4`,`/demo/${code}.mp4`,code,code,code);
      db.prepare("INSERT INTO media_metadata(normalized_code,title,actors_json,genres_json,maker,director,series,provider,status,release_date,updated_at) VALUES(?,?,?,?,?,?,?,'local','ready',?,'2026-01-01')").run(code,`Fictional work ${i+1}`,JSON.stringify([actor]),JSON.stringify([genre]),`Demo Studio ${i%4}`,`Demo Director ${i%3}`,`Demo Collection ${i%5}`,i%10===0?null:`202${i%6}-01-01`);
      replaceMetadataFacetsForCode({normalizedCode:code,actors:[actor],genres:[genre],maker:`Demo Studio ${i%4}`,director:`Demo Director ${i%3}`,series:`Demo Collection ${i%5}`,label:"Demo Label"});
    }
  })();
}
