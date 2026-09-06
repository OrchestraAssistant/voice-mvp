import traverse from "@babel/traverse";
import path from "node:path";
import { parseFile, walk } from "../core/parse.js";

/**
 * Request body shapes, read from Zod schemas.
 *
 * The body cannot be recovered from the fetch call: it is a runtime object
 * built from component state. A validation schema is the only place the field
 * names and types are written down statically, which is why this exists at
 * all -- and why an app without one gets actions that can be addressed but
 * carry nothing, which is worse than useless.
 *
 * Scans the whole source tree rather than one `pages/` directory. Forms live
 * wherever an app puts them.
 */
function fieldsOf(objectExpression) {
  return objectExpression.properties.map((prop) => {
    const name = prop.key.name || prop.key.value;
    let required = true;
    let type = "string";
    let enumValues;
    let node = prop.value;
    // Unwrap the chain: z.string().min(1).optional() -> string, optional.
    while (node.type === "CallExpression") {
      if (node.callee.property?.name === "optional" || node.callee.property?.name === "nullish") required = false;
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
    return { name, required, type, ...(enumValues ? { enumValues } : {}) };
  });
}

export const zodBodies = {
  name: "zod-bodies",
  role: "enricher",
  describe: "z.object({...}) schemas beside the form that submits them",

  run({ srcDir, root, actions = [] }) {
    if (!actions.length) return {};
    const visit = traverse.default ?? traverse;
    const enriched = [];

    // A producer that KNOWS which schema describes its input says so, and
    // that beats every heuristic below. tRPC procedures declare it outright
    // with `.input(ZDeleteInputSchema)`, so there is nothing left to guess.
    const named = actions.filter((a) => a._inputSchema && !a.bodyFields?.length);
    if (named.length) {
      const byName = new Map();
      for (const dir of [...new Set([srcDir, root, path.resolve(root ?? srcDir, "..", "..")])]) {
        for (const file of walk(dir, (n) => /\.tsx?$/.test(n))) {
          let ast;
          try {
            ast = parseFile(file);
          } catch {
            continue;
          }
          visit(ast, {
            VariableDeclarator(nodePath) {
              const { id, init } = nodePath.node;
              if (id.type !== "Identifier" || byName.has(id.name)) return;
              if (
                init?.type === "CallExpression" &&
                init.callee?.type === "MemberExpression" &&
                init.callee.object?.name === "z" &&
                init.callee.property?.name === "object" &&
                init.arguments[0]?.type === "ObjectExpression"
              ) {
                byName.set(id.name, fieldsOf(init.arguments[0]));
              }
            },
          });
        }
        if (byName.size) break;
      }
      for (const action of named) {
        const fields = byName.get(action._inputSchema);
        if (!fields) continue;
        action.bodyFields = fields;
        enriched.push(`${action.name} from ${action._inputSchema}`);
      }
    }

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const schemas = [];
      const usedHooks = [];
      visit(ast, {
        VariableDeclarator(nodePath) {
          const init = nodePath.node.init;
          if (
            init?.type === "CallExpression" &&
            init.callee?.type === "MemberExpression" &&
            init.callee.object?.name === "z" &&
            init.callee.property?.name === "object" &&
            init.arguments[0]?.type === "ObjectExpression"
          ) {
            schemas.push(fieldsOf(init.arguments[0]));
          }
        },
        CallExpression(nodePath) {
          const callee = nodePath.node.callee;
          if (callee.type === "Identifier" && /^use[A-Z]/.test(callee.name) && !usedHooks.includes(callee.name)) {
            usedHooks.push(callee.name);
          }
        },
      });

      // One schema and one write hook in a file is the case that can be paired
      // without guessing. Two of either and the pairing would be a coin flip,
      // so it is left alone and reported rather than assigned wrongly.
      const writeHooks = usedHooks.filter((h) => actions.some((a) => a._hookName === h));
      if (schemas.length === 1 && writeHooks.length === 1) {
        const action = actions.find((a) => a._hookName === writeHooks[0]);
        if (action && !action.bodyFields.length) {
          action.bodyFields = schemas[0];
          enriched.push(action.name);
        }
      }
    }
    return { notes: enriched.length ? [`body fields from Zod: ${enriched.join(", ")}`] : [] };
  },
};
