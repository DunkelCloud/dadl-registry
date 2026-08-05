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

// Canonical spec URLs accepted by the registry, mapped to their version.
// New spec versions require a CI update (new canonical schema) by design.
const SPEC_VERSIONS: Record<string, string> = {
  "https://dadl.ai/spec/dadl-spec-v0.1.md": "0.1",
  "https://dadl.ai/spec/dadl-spec-v0.2.md": "0.2",
};

// Spec v0.2 features that a document may only use when it declares a v0.2
// spec URL (spec section 15.2: "a file using any feature marked (since v0.2)
// declares a v0.2 spec URL"). Checked as (location, present?) probes.
const V02_FLOWS = new Set(["refresh_token", "jwt_bearer", "authorization_code"]);
const V02_AUTH_KEYS = [
  "rotates_refresh_token",
  "refresh_token_credential",
  "authorization_params",
  "token_auth",
  "redirect_uri",
];
const V02_TOOL_KEYS = ["returns", "idempotency", "retry_unsafe", "deprecated", "replaced_by"];

// findConformanceIssues enforces the machine-checkable document-conformance
// rules of spec section 15.2 that the canonical JSON Schema cannot express,
// plus the public registry's publication profile (credits, source_name,
// source_url, date, and an explicit access classification).
function findConformanceIssues(doc: any): string[] {
  const issues: string[] = [];
  const backend = doc?.backend ?? {};
  const tools: Record<string, any> =
    backend.tools && typeof backend.tools === "object" ? backend.tools : {};
  const composites: Record<string, any> =
    backend.composites && typeof backend.composites === "object" ? backend.composites : {};

  // --- spec URL & version ---
  const version = SPEC_VERSIONS[doc?.spec];
  if (!version) {
    issues.push(
      `Unknown spec URL "${doc?.spec}" — registry accepts: ${Object.keys(SPEC_VERSIONS).join(", ")}`,
    );
  }
  const isV01 = version === "0.1";

  // --- registry publication profile ---
  if (!Array.isArray(doc?.credits) || doc.credits.length === 0) {
    issues.push(`Registry profile: "credits" must be a non-empty array`);
  }
  for (const field of ["source_name", "source_url", "date"]) {
    if (typeof doc?.[field] !== "string" || doc[field] === "") {
      issues.push(`Registry profile: top-level "${field}" is required`);
    }
  }
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool?.access) {
      issues.push(`Registry profile: tool "${name}" has no "access" classification`);
    }
  }
  // Composite-level access only exists since v0.2 — v0.1 files cannot express
  // it, so the profile requirement applies to v0.2 documents only.
  if (!isV01) {
    for (const [name, comp] of Object.entries(composites)) {
      if (!comp?.access) {
        issues.push(`Registry profile: composite "${name}" has no "access" classification`);
      }
    }
  }

  // --- v0.2 features require a v0.2 spec declaration ---
  const v02Uses: string[] = [];
  if (doc?.requires !== undefined) v02Uses.push(`top-level "requires"`);
  if (backend.health !== undefined) v02Uses.push(`backend "health"`);
  const auth = backend.auth ?? {};
  if (V02_FLOWS.has(auth.flow)) v02Uses.push(`auth.flow "${auth.flow}"`);
  for (const key of V02_AUTH_KEYS) {
    if (auth[key] !== undefined) v02Uses.push(`auth.${key}`);
  }
  const probeErrors = (errs: any, where: string) => {
    if (errs?.map !== undefined) v02Uses.push(`${where} errors.map`);
  };
  const probeResponse = (resp: any, where: string) => {
    if (resp?.redact !== undefined) v02Uses.push(`${where} response.redact`);
  };
  probeErrors(backend.defaults?.errors, "defaults");
  probeResponse(backend.defaults?.response, "defaults");
  for (const [name, tool] of Object.entries(tools)) {
    for (const key of V02_TOOL_KEYS) {
      if (tool?.[key] !== undefined) v02Uses.push(`tool "${name}" ${key}`);
    }
    probeErrors(tool?.errors, `tool "${name}"`);
    probeResponse(tool?.response, `tool "${name}"`);
  }
  for (const [name, comp] of Object.entries(composites)) {
    if (comp?.access !== undefined) v02Uses.push(`composite "${name}" access`);
  }
  if (isV01 && v02Uses.length > 0) {
    for (const use of v02Uses) {
      issues.push(`Uses v0.2 feature (${use}) but declares the v0.1 spec URL`);
    }
  }

  // --- retry_on and terminal must be disjoint (spec section 8) ---
  const checkRetryTerminal = (errs: any, where: string) => {
    if (!errs) return;
    const retry = new Set<number>(Array.isArray(errs.retry_on) ? errs.retry_on : []);
    const overlap = (Array.isArray(errs.terminal) ? errs.terminal : []).filter((s: number) =>
      retry.has(s),
    );
    if (overlap.length > 0) {
      issues.push(`${where}: status ${overlap.join(", ")} appears in both retry_on and terminal`);
    }
  };
  checkRetryTerminal(backend.defaults?.errors, "defaults.errors");
  for (const [name, tool] of Object.entries(tools)) {
    checkRetryTerminal(tool?.errors, `tool "${name}" errors`);
  }

  // --- v0.2 documents: inject_into query needs query_param ---
  if (!isV01 && auth?.inject_into === "query" && !auth?.query_param) {
    issues.push(`auth.inject_into "query" requires "query_param" in v0.2 documents`);
  }

  // --- load-bearing features must be declared in requires.features ---
  const requiredFeatures = new Set<string>(
    Array.isArray(doc?.requires?.features) ? doc.requires.features : [],
  );
  const needsFeature = (feature: string, used: boolean, where: string) => {
    if (used && !requiredFeatures.has(feature)) {
      issues.push(`${where} is load-bearing — declare "${feature}" in requires.features`);
    }
  };
  const usesRedact =
    backend.defaults?.response?.redact !== undefined ||
    Object.values(tools).some((t: any) => t?.response?.redact !== undefined);
  needsFeature("redact", usesRedact, "response.redact");
  const usesIdempotency = Object.values(tools).some((t: any) => t?.idempotency !== undefined);
  needsFeature("idempotency", usesIdempotency, "idempotency");
  needsFeature(
    "refresh_token_rotation",
    auth?.rotates_refresh_token === true,
    "auth.rotates_refresh_token",
  );

  // --- intra-file references must resolve ---
  const callableNames = new Set([...Object.keys(tools), ...Object.keys(composites)]);
  for (const [name, tool] of Object.entries(tools)) {
    if (tool?.replaced_by !== undefined && !callableNames.has(tool.replaced_by)) {
      issues.push(`tool "${name}": replaced_by "${tool.replaced_by}" does not exist in this file`);
    }
  }
  const healthTool = backend.health?.tool;
  if (healthTool !== undefined) {
    const target = tools[healthTool];
    if (!target) {
      issues.push(`health.tool "${healthTool}" does not exist in this file`);
    } else {
      const requiredParams = Object.entries(target.params ?? {})
        .filter(([, p]: [string, any]) => p?.required === true)
        .map(([n]) => n);
      if (requiredParams.length > 0) {
        issues.push(
          `health.tool "${healthTool}" has required parameters (${requiredParams.join(", ")}) — health checks must be callable without arguments`,
        );
      }
    }
  }
  for (const [name, comp] of Object.entries(composites)) {
    for (const dep of Array.isArray(comp?.delegates) ? comp.delegates : []) {
      if (!Object.keys(tools).includes(dep)) {
        issues.push(`composite "${name}": delegates entry "${dep}" is not a tool in this file`);
      }
    }
  }

  return issues;
}

const ROOT_DIR = join(import.meta.dirname, "..");
const SCHEMA_PATH = join(ROOT_DIR, "schema", "dadl-v0.2.schema.json");
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

  // Spec 15.2 document conformance + registry publication profile
  for (const issue of findConformanceIssues(doc)) {
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
