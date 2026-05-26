import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";

const PATH_PLACEHOLDER_RE = /\{([^/}]+)\}/g;

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

// findPathParamIssues catches the class of bugs where a tool's URL template
// and its `params` map disagree about path parameters. Both directions matter:
//
//   1. A `{placeholder}` in `path:` without a matching `in: path` param means
//      ToolMesh has no value to substitute and the literal `{name}` is sent to
//      the backend, which typically responds with an opaque 404 that looks
//      unrelated to the DADL.
//   2. An `in: path` param whose name does not appear as a `{placeholder}` in
//      `path:` is dead weight — ToolMesh enforces "required path param" but
//      never substitutes anywhere, so callers get a confusing "missing param"
//      error for a parameter that does not actually shape the URL.
//
// We also reject path-bound params without `required: true`, because optional
// path segments produce malformed URLs that vary by backend.
function findPathParamIssues(doc: any): string[] {
  const issues: string[] = [];
  const tools = doc?.backend?.tools;
  if (!tools || typeof tools !== "object") return issues;

  for (const [toolName, toolRaw] of Object.entries(tools)) {
    const tool = toolRaw as any;
    if (!tool || typeof tool !== "object") continue;
    const path = typeof tool.path === "string" ? tool.path : "";
    if (!path) continue;

    const params: Record<string, any> =
      tool.params && typeof tool.params === "object" ? tool.params : {};

    const placeholders = new Set<string>();
    for (const m of path.matchAll(PATH_PLACEHOLDER_RE)) {
      placeholders.add(m[1]);
    }

    for (const placeholder of placeholders) {
      const def = params[placeholder];
      if (!def) {
        issues.push(
          `tool "${toolName}": path uses {${placeholder}} but no param of that name is declared`,
        );
        continue;
      }
      if (def.in && def.in !== "path") {
        issues.push(
          `tool "${toolName}": path uses {${placeholder}} but param is declared as in="${def.in}"`,
        );
      } else if (def.required !== true) {
        issues.push(
          `tool "${toolName}": path parameter "${placeholder}" must be declared with required: true`,
        );
      }
    }

    for (const [paramName, defRaw] of Object.entries(params)) {
      const def = defRaw as any;
      if (def && def.in === "path" && !placeholders.has(paramName)) {
        issues.push(
          `tool "${toolName}": param "${paramName}" is in=path but path "${path}" has no {${paramName}} placeholder`,
        );
      }
    }
  }

  return issues;
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
    doc = parseYaml(raw.toString("utf-8"), { maxAliasCount: 500 });
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

  // Path placeholder ↔ param consistency
  for (const issue of findPathParamIssues(doc)) {
    errors.push(issue);
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
