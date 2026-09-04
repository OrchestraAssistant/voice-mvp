#!/usr/bin/env node
// Static analysis extractor: walks a React app's source and produces a
// manifest describing its routes, read queries, and write actions.
//
// Scope (MVP): react-router JSX <Route> elements, React Query
// useQuery/useMutation hooks that call a `request(url, options)` helper,
// and Zod schemas co-located with the form that submits them. This is not
// a general-purpose JS analyzer -- it targets a handful of common,
// recognizable patterns and leaves everything else to the runtime DOM
// fallback.

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

import fs from "node:fs";
import path from "node:path";

const USAGE = `voice-cli -- turn a React app's source into .voice/manifest.json

  npx @yourco/voice-cli [srcDir] [outDir]

  srcDir   where the app's source lives   (default: ./src)
  outDir   where the manifest is written  (default: ./.voice)

Run it from your app's root. What it looks for is listed in the output.`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// Relative to the CALLER, not to this file. The defaults used to resolve from
// import.meta.dirname to a sibling demo-app, which exists in this repo and
// nowhere else -- so `npx @yourco/voice-cli` worked for us and for no one who
// actually installed it.
const SRC_DIR = path.resolve(process.argv[2] || "src");
const OUT_DIR = path.resolve(process.argv[3] || ".voice");

function parseFile(filePath) {
  const code = fs.readFileSync(filePath, "utf-8");
  return parse(code, {
    sourceType: "module",
    plugins: ["jsx"],
  });
}

// --- 1. Routes: walk App.jsx for <Route path="..." element={<X/>} /> ---
function extractRoutes(appFile) {
  const ast = parseFile(appFile);
  const routes = [];

  traverse(ast, {
    JSXElement(nodePath) {
      const opening = nodePath.node.openingElement;
      if (opening.name.name !== "Route") return;

      let routePath, component;
      for (const attr of opening.attributes) {
        if (attr.type !== "JSXAttribute") continue;
        if (attr.name.name === "path" && attr.value?.type === "StringLiteral") {
          routePath = attr.value.value;
        }
        if (attr.name.name === "element" && attr.value?.expression?.type === "JSXElement") {
          component = attr.value.expression.openingElement.name.name;
        }
      }
      if (routePath) routes.push({ path: routePath, component });
    },
  });

  return routes;
}

// --- 0. Module-level string constants, e.g. `const BASE = "/api"` ---
// so URL templates can inline them instead of treating them as call params.
function extractStringConstants(ast) {
  const constants = {};
  traverse(ast, {
    VariableDeclarator(nodePath) {
      const id = nodePath.node.id;
      const init = nodePath.node.init;
      if (id.type === "Identifier" && init?.type === "StringLiteral") {
        constants[id.name] = init.value;
      }
    },
  });
  return constants;
}

// --- 2. Queries & actions: walk api.js for useQuery/useMutation hooks ---
function literalOrTemplate(node, constants) {
  // Returns a URL template like "/api/tasks/{id}" from a template literal,
  // and the list of param names it references. Known module-level string
  // constants (e.g. a `BASE` URL prefix) are inlined rather than treated
  // as runtime params.
  if (node.type === "StringLiteral") return { template: node.value, params: [] };
  if (node.type === "TemplateLiteral") {
    let template = "";
    const params = [];
    node.quasis.forEach((q, i) => {
      template += q.value.raw;
      const expr = node.expressions[i];
      if (expr) {
        if (expr.type === "Identifier" && constants[expr.name] !== undefined) {
          template += constants[expr.name];
        } else {
          const name = expr.type === "Identifier" ? expr.name : `param${i}`;
          template += `{${name}}`;
          params.push(name);
        }
      }
    });
    return { template, params };
  }
  return { template: null, params: [] };
}

// Babel's traverse() needs a full Scope/parent path to walk a detached
// subtree, which we don't have for nodes found via an outer traversal, so
// a plain recursive walk is simpler and sufficient for this narrow case.
function walkForCallExpressions(node, calleeName, results) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => walkForCallExpressions(n, calleeName, results));
    return;
  }
  if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === calleeName) {
    results.push(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    const val = node[key];
    if (val && typeof val === "object") walkForCallExpressions(val, calleeName, results);
  }
}

function getObjectProp(objExpr, propName) {
  if (!objExpr || objExpr.type !== "ObjectExpression") return null;
  const prop = objExpr.properties.find((p) => p.key && (p.key.name === propName || p.key.value === propName));
  return prop ? prop.value : null;
}

function dedupeParams(params) {
  const seen = new Set();
  return params.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

function extractQueriesAndActions(apiFile) {
  const ast = parseFile(apiFile);
  const constants = extractStringConstants(ast);
  const queries = [];
  const actions = [];

  traverse(ast, {
    ExportNamedDeclaration(nodePath) {
      const decl = nodePath.node.declaration;
      if (decl?.type !== "FunctionDeclaration") return;
      const hookName = decl.id.name; // e.g. useTasks, useCreateTask

      const queryCalls = [];
      walkForCallExpressions(decl.body, "useQuery", queryCalls);
      const mutationCalls = [];
      walkForCallExpressions(decl.body, "useMutation", mutationCalls);

      const requestCalls = [];
      walkForCallExpressions(decl.body, "request", requestCalls);

      if (queryCalls.length && requestCalls.length) {
        const reqCall = requestCalls[0];
        const { template, params: urlParams } = literalOrTemplate(reqCall.arguments[0], constants);
        const name = hookName.replace(/^use/, "");
        queries.push({
          name: name.charAt(0).toLowerCase() + name.slice(1),
          description: `Auto-detected read query from ${hookName}`,
          method: "GET",
          endpoint: template,
          params: dedupeParams([
            ...urlParams.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
            ...decl.params
              .filter((p) => p.type === "Identifier")
              .map((p) => ({ name: p.name, type: "string", required: false, source: "hook-arg" })),
          ]),
        });
      }

      if (mutationCalls.length && requestCalls.length) {
        const reqCall = requestCalls[0];
        const { template, params: urlParams } = literalOrTemplate(reqCall.arguments[0], constants);
        const optionsArg = reqCall.arguments[1];
        const methodNode = getObjectProp(optionsArg, "method");
        const method = methodNode?.type === "StringLiteral" ? methodNode.value : "POST";
        const name = hookName.replace(/^use/, "");

        actions.push({
          name: name.charAt(0).toLowerCase() + name.slice(1),
          description: `Auto-detected write action from ${hookName}`,
          method,
          endpoint: template,
          requiresConfirmation: method === "DELETE",
          params: urlParams.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
          // body fields are enriched from a co-located Zod schema, if found (see enrichFromZodSchemas)
          bodyFields: [],
          _hookName: hookName,
        });
      }
    },
  });

  return { queries, actions };
}

// --- 3. Enrich mutation body fields from co-located Zod schemas ---
function extractZodSchemas(pageFile) {
  const ast = parseFile(pageFile);
  const schemas = {};
  const usedHooks = [];

  traverse(ast, {
    VariableDeclarator(nodePath) {
      const id = nodePath.node.id;
      const init = nodePath.node.init;
      if (
        id.type === "Identifier" &&
        init?.type === "CallExpression" &&
        init.callee?.type === "MemberExpression" &&
        init.callee.object?.name === "z" &&
        init.callee.property?.name === "object"
      ) {
        const shape = init.arguments[0];
        if (shape?.type !== "ObjectExpression") return;
        const fields = shape.properties.map((p) => {
          const fieldName = p.key.name || p.key.value;
          let required = true;
          let type = "string";
          let enumValues;
          let node = p.value;
          while (node.type === "CallExpression") {
            if (node.callee.property?.name === "optional") required = false;
            if (node.callee.object?.type === "CallExpression") {
              node = node.callee.object;
            } else {
              type = node.callee.property?.name || node.callee.object?.property?.name || type;
              if (type === "enum" && node.arguments[0]?.type === "ArrayExpression") {
                enumValues = node.arguments[0].elements.filter((e) => e?.type === "StringLiteral").map((e) => e.value);
              }
              break;
            }
          }
          return { name: fieldName, required, type, ...(enumValues ? { enumValues } : {}) };
        });
        schemas[id.name] = fields;
      }
    },
    CallExpression(nodePath) {
      // detect which mutation hook this page calls, e.g. useCreateTask()
      const callee = nodePath.node.callee;
      if (callee.type === "Identifier" && /^use(Create|Update|Delete)/.test(callee.name)) {
        if (!usedHooks.includes(callee.name)) usedHooks.push(callee.name);
      }
    },
  });

  return { schemas, usedHooks };
}

function enrichFromZodSchemas(actions, pagesDir) {
  const pageFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".jsx"));
  for (const file of pageFiles) {
    const { schemas, usedHooks } = extractZodSchemas(path.join(pagesDir, file));
    if (usedHooks.length === 0 || Object.keys(schemas).length === 0) continue;
    // A page with exactly one form schema and one mutation hook is the
    // common case; wire the schema's fields to that hook's action.
    if (usedHooks.length === 1) {
      const action = actions.find((a) => a._hookName === usedHooks[0]);
      if (action) action.bodyFields = Object.values(schemas)[0];
    }
  }
  actions.forEach((a) => delete a._hookName);
}

// --- Run ---
function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`No source directory at ${SRC_DIR}\n\n${USAGE}`);
    process.exit(1);
  }

  // The three places this knows how to read. Named here rather than inline so
  // a run that finds nothing can say WHAT it looked for -- the alternative is
  // an ENOENT stack trace, which tells the user their app is broken rather
  // than that this tool only recognises one layout.
  const looksAt = [
    ["routes", path.join(SRC_DIR, "App.jsx"), "<Route path=... /> elements"],
    ["queries and actions", path.join(SRC_DIR, "api.js"), "useQuery/useMutation calling a request() helper"],
    ["field types", path.join(SRC_DIR, "pages"), "Zod schemas beside the form that submits them"],
  ];
  const missing = looksAt.filter(([, where]) => !fs.existsSync(where));

  const [appFile, apiFile, pagesDir] = looksAt.map(([, where]) => where);

  const routes = fs.existsSync(appFile) ? extractRoutes(appFile) : [];
  const { queries, actions } = fs.existsSync(apiFile)
    ? extractQueriesAndActions(apiFile)
    : { queries: [], actions: [] };
  if (fs.existsSync(pagesDir)) enrichFromZodSchemas(actions, pagesDir);

  const manifest = {
    generatedAt: "static-analysis",
    routes,
    queries,
    actions,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "manifest.json");
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));

  console.log(`Wrote manifest: ${outFile}`);
  console.log(`  routes:  ${routes.length}`);
  console.log(`  queries: ${queries.length}`);
  console.log(`  actions: ${actions.length} (${actions.filter((a) => a.requiresConfirmation).length} require confirmation)`);

  // An empty manifest is not an error -- the widget still has its DOM
  // fallback -- but it is never what someone wanted, and silence about why is
  // how they conclude the product does not work.
  for (const [what, where, pattern] of looksAt) {
    if (!fs.existsSync(where)) console.warn(`  no ${what}: nothing at ${path.relative(process.cwd(), where)}, which is where it reads ${pattern}`);
  }
  if (routes.length + queries.length + actions.length === 0) {
    console.warn(
      `\nNothing was extracted. This reads one specific layout (see above);` +
        ` an app organised differently needs those paths passed explicitly, or the DOM fallback alone.`,
    );
  }
}

main();
