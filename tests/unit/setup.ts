import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterAll} from "vitest";
// Every suite owns a fresh state directory; npm test must never open a user's DB.
const root=fs.mkdtempSync(path.join(os.tmpdir(),"alexandria-unit-"));
process.env.DATA_DIR=root;
process.env.MEDIA_SOURCES=`LOCAL:Test=${root}`;
process.env.AMW_AGENT_ENABLED="false";
process.env.AMW_ENTITY_PROFILE_IMAGE_POLICY="strict";
process.env.AMW_TRANSLATION_EXTERNALIZED="false";
process.env.METADATA_AUTO_ENRICH="false";
process.env.SUBTITLE_AUTO_TRANSLATE_FAVORITES="false";
afterAll(()=>fs.rmSync(root,{recursive:true,force:true}));
