// Sanity-check the path/param linter from validate-all.ts against synthetic
// broken DADLs. Not part of CI — run ad-hoc with `tsx scripts/test-path-param-linter.ts`.
// Mirrors the public helper rather than importing it to keep validate-all.ts
// a single-file script.

import { parse as parseYaml } from "yaml";

const PATH_PLACEHOLDER_RE = /\{([^/}]+)\}/g;

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

const cases: { name: string; yaml: string; expect: string[] }[] = [
  {
    name: "happy path",
    yaml: `
backend:
  tools:
    get_firewall:
      method: GET
      path: /networking/firewalls/{firewallId}
      params:
        firewallId: { type: integer, in: path, required: true }
`,
    expect: [],
  },
  {
    name: "placeholder name != param name (the suspected linode bug)",
    yaml: `
backend:
  tools:
    get_firewall:
      method: GET
      path: /networking/firewalls/{firewall_id}
      params:
        firewallId: { type: integer, in: path, required: true }
`,
    expect: [
      `tool "get_firewall": path uses {firewall_id} but no param of that name is declared`,
      `tool "get_firewall": param "firewallId" is in=path but path "/networking/firewalls/{firewall_id}" has no {firewallId} placeholder`,
    ],
  },
  {
    name: "param declared as query but used in path",
    yaml: `
backend:
  tools:
    bad:
      method: GET
      path: /things/{id}
      params:
        id: { type: integer, in: query }
`,
    expect: [`tool "bad": path uses {id} but param is declared as in="query"`],
  },
  {
    name: "path param missing required: true",
    yaml: `
backend:
  tools:
    bad:
      method: GET
      path: /things/{id}
      params:
        id: { type: integer, in: path }
`,
    expect: [
      `tool "bad": path parameter "id" must be declared with required: true`,
    ],
  },
  {
    name: "in:path param without matching placeholder",
    yaml: `
backend:
  tools:
    bad:
      method: GET
      path: /things
      params:
        id: { type: integer, in: path, required: true }
`,
    expect: [
      `tool "bad": param "id" is in=path but path "/things" has no {id} placeholder`,
    ],
  },
];

let failed = 0;
for (const tc of cases) {
  const doc = parseYaml(tc.yaml);
  const got = findPathParamIssues(doc);
  const eq =
    got.length === tc.expect.length &&
    tc.expect.every((e) => got.includes(e)) &&
    got.every((g) => tc.expect.includes(g));
  if (!eq) {
    failed++;
    console.error(`❌ ${tc.name}`);
    console.error(`   want:`);
    for (const w of tc.expect) console.error(`     - ${w}`);
    console.error(`   got:`);
    for (const g of got) console.error(`     - ${g}`);
  } else {
    console.log(`✅ ${tc.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed.`);
