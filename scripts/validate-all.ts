import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";

function findMergeKeys(obj: any, path = ""): string[] {
  const found: string[] = [];
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      const p = path ? `${path}/${key}` : `/${key}`;
      if (key === "<<") {
        found.push(p);
      } else {
        found.push(...findMergeKeys(obj[key], p));
      }
    }
  }
  return found;
}

const ROOT_DIR = join(import.meta.dirname, "..");
const SCHEMA_PATH = join(ROOT_DIR, "schema", "dadl-v1.schema.json");
const MAX_FILE_SIZE = 500 * 1024; // 500 KB

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const files = readdirSync(ROOT_DIR).filter((f) => f.endsWith(".dadl"));

if (files.length === 0) {
  console.error("No .dadl files found in repository root.");
  process.exit(1);
}

let hasErrors = false;

for (const file of files) {
  const filePath = join(ROOT_DIR, file);
  const errors: string[] = [];

  // Size check
  const raw = readFileSync(filePath);
  if (raw.length > MAX_FILE_SIZE) {
    errors.push(`File exceeds 500 KB limit (${(raw.length / 1024).toFixed(0)} KB)`);
  }

  // Parse YAML
  let doc: any;
  try {
    doc = parseYaml(raw.toString("utf-8"), { maxAliasCount: 100 });
  } catch (e: any) {
    errors.push(`YAML parse error: ${e.message}`);
    console.error(`\n❌ ${file}`);
    errors.forEach((e) => console.error(`   ${e}`));
    hasErrors = true;
    continue;
  }

  // Reject YAML merge keys (<<: *anchor) — they make files harder for LLMs to consume
  const mergeKeys = findMergeKeys(doc);
  if (mergeKeys.length > 0) {
    for (const path of mergeKeys) {
      errors.push(`Merge key "<<" at ${path} is not allowed — inline the values instead`);
    }
  }

  // Schema validation
  const valid = validate(doc);
  if (!valid && validate.errors) {
    for (const err of validate.errors) {
      errors.push(`Schema: ${err.instancePath || "/"} ${err.message}`);
    }
  }

  // Filename must match backend.name
  const expectedName = basename(file, ".dadl");
  const backendName = doc?.backend?.name;
  if (backendName && backendName !== expectedName) {
    errors.push(
      `Filename "${expectedName}" does not match backend.name "${backendName}"`
    );
  }

  if (errors.length > 0) {
    console.error(`\n❌ ${file}`);
    errors.forEach((e) => console.error(`   ${e}`));
    hasErrors = true;
  } else {
    const toolCount = doc.backend?.tools
      ? Object.keys(doc.backend.tools).length
      : 0;
    const compositeCount = doc.backend?.composites
      ? Object.keys(doc.backend.composites).length
      : 0;
    const suffix = compositeCount > 0 ? ` + ${compositeCount} composites` : "";
    console.log(`✅ ${file} — ${toolCount} tools${suffix}`);
  }
}

if (hasErrors) {
  console.error("\nValidation failed.");
  process.exit(1);
} else {
  console.log(`\n✅ All ${files.length} DADL files valid.`);
}
