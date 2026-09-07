import traverse from "@babel/traverse";
import path from "node:path";
import { parseFile, walk } from "../core/parse.js";
import { findDefinition, packageAliases } from "../core/resolveSymbol.js";

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
/** Is this AST node a `z.object({...})` call? */
function isZodObject(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.name === "z" &&
    node.callee.property?.name === "object" &&
    node.arguments?.[0]?.type === "ObjectExpression"
  );
}

/**
 * Strips wrappers (.optional(), .min(), .describe()...) to the base zod call,
 * reporting whether the field was optional on the way down.
 *
 * The subtlety, learned twice: a wrapper's name must never be read as the type.
 * `.optional()` on a referenced schema (`timeZoneSchema.optional()`) has no
 * z-type under it, so the descent stops and the caller keeps its default.
 */
function unwrap(node) {
  let required = true;
  while (node?.type === "CallExpression" && node.callee?.type === "MemberExpression") {
    const method = node.callee.property?.name;
    if (method === "optional" || method === "nullish") required = false;
    if (node.callee.object?.name === "z") return { base: node, required };
    if (node.callee.object?.type === "CallExpression") {
      node = node.callee.object;
      continue;
    }
    return { base: null, required }; // a referenced schema, or something unknown
  }
  return { base: null, required };
}

/**
 * A compact type for a zod node, recursing through arrays and objects.
 *
 * `z.array(z.array(z.object({start, end})))` becomes `Array<Array<{start, end}>>`
 * -- which is exactly the shape a flat "type: array" could not convey, and the
 * reason a model kept sending the wrong structure for cal.diy's weekday-indexed
 * schedule. Returns null for a plain scalar (the field's `type` already says
 * "string"), so only compound shapes are carried.
 *
 * Depth-capped: past three levels the type is just "array"/"object". Full depth
 * would occasionally reproduce a huge nested schema in the prompt we spent the
 * dispatcher work shrinking, and three levels covers everything a person would
 * type by hand anyway.
 */
function shapeOf(node, depth = 0) {
  const { base } = unwrap(node);
  if (!base || base.callee?.object?.name !== "z") return null; // referenced/unknown
  const method = base.callee.property?.name;

  if (method === "array") {
    if (depth >= 3) return "array";
    const inner = shapeOf(base.arguments[0], depth + 1);
    return `Array<${inner ?? scalarName(base.arguments[0]) ?? "any"}>`;
  }
  if (method === "object") {
    if (depth >= 3) return "object";
    const fields = (base.arguments[0]?.properties ?? [])
      .map((p) => p.key?.name ?? p.key?.value)
      .filter(Boolean);
    return fields.length ? `{ ${fields.join(", ")} }` : "object";
  }
  return null; // a scalar; `type` already carries it
}

/** The scalar type name of a node, for the leaf of an array. */
function scalarName(node) {
  const { base } = unwrap(node);
  return base?.callee?.object?.name === "z" ? base.callee.property?.name : null;
}

function fieldsOf(objectExpression) {
  return objectExpression.properties.map((prop) => {
    const name = prop.key.name || prop.key.value;
    const { base, required } = unwrap(prop.value);
    let type = "string";
    let enumValues;
    if (base?.callee?.object?.name === "z") {
      type = base.callee.property?.name || type;
      if (type === "enum" && base.arguments[0]?.type === "ArrayExpression") {
        enumValues = base.arguments[0].elements.filter((e) => e?.type === "StringLiteral").map((e) => e.value);
      }
    }
    // The nested shape, only when it adds something a scalar type does not.
    const shape = shapeOf(prop.value);
    return {
      name,
      required,
      type,
      ...(enumValues ? { enumValues } : {}),
      ...(shape && /[<{]/.test(shape) ? { shape } : {}),
    };
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
      const aliases = packageAliases(root ?? srcDir);

      for (const action of named) {
        // Follow the symbol from WHERE IT IS USED, across re-exports and
        // package boundaries, to the actual definition -- then read it as a
        // zod object. The resolver is schema-agnostic; only isZodObject and
        // fieldsOf below know it is Zod. `_inputSchemaFile` is where the
        // procedure declared `.input(...)`; without it there is no chain to
        // start from, so fall back to the name search underneath.
        if (action._inputSchemaFile) {
          const def = findDefinition(action._inputSchema, action._inputSchemaFile, aliases);
          if (isZodObject(def?.node)) {
            action.bodyFields = fieldsOf(def.node.arguments[0]);
            enriched.push(`${action.name} from ${action._inputSchema} (resolved across packages)`);
          }
        }
      }

      // Whatever the resolver could not place, try the older name-correlation:
      // scan for a local `const Name = z.object(...)` anywhere in the tree.
      const stillEmpty = named.filter((a) => !a.bodyFields?.length);
      if (stillEmpty.length) {
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
                if (isZodObject(init)) byName.set(id.name, fieldsOf(init.arguments[0]));
              },
            });
          }
          if (byName.size) break;
        }
        for (const action of stillEmpty) {
          const fields = byName.get(action._inputSchema);
          if (!fields) continue;
          action.bodyFields = fields;
          enriched.push(`${action.name} from ${action._inputSchema}`);
        }
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
