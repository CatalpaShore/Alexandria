import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const catalogs = Object.fromEntries(["en", "ja"].map(locale => [locale, JSON.parse(fs.readFileSync(`client/src/i18n/${locale}.json`, "utf8"))]));
const keys = Object.keys(catalogs.en).sort(), errors = [];
if (JSON.stringify(keys) !== JSON.stringify(Object.keys(catalogs.ja).sort())) errors.push("Translation key sets differ");
const params = text => [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))].sort().join(",");
for (const [locale, catalog] of Object.entries(catalogs)) {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== "string" || !value.trim()) errors.push(`${locale}: invalid value for ${key}`);
    else if (params(value) !== params(key)) errors.push(`${locale}: parameter mismatch for ${key}`);
  }
}
let calls = 0;
function walkDirectory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "web-library" || entry.name === "i18n") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkDirectory(file); continue; }
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8"), source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        calls++;
        for (const [locale, catalog] of Object.entries(catalogs)) if (!Object.hasOwn(catalog, node.arguments[0].text)) errors.push(`${file}: missing ${locale} translation for ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
}
walkDirectory("client/src");
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`i18n passed: ${keys.length} messages per language; ${calls} literal calls; matching keys and interpolation parameters.`);
