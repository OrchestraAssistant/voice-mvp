import traverse from "@babel/traverse";
import { parseFile, walk } from "../shared.js";

/**
 * Request body shapes, read from TypeScript.
 *
 * The body cannot be recovered from the call that sends it -- it is a runtime
 * object built from state -- so it has to come from somewhere it is written
 * down. Zod was the first answer, and it is the wrong dependency: a validation
 * library is one way an app might describe its data, and only some apps use
 * one. A TYPE is how a TypeScript app describes its data by definition, and
 * a Zod schema exists in order to produce one.
 *
 * Reads type aliases and interfaces from source, then matches them to actions
 * by name. Deliberately not the full TypeScript compiler: that would mean a
 * heavyweight dependency, a tsconfig, and a program that has to resolve every
 * import in the app. Names carry most of the signal -- `UpdateTaskInput`
 * belongs to `updateTask` -- and being wrong here is visible rather than
 * silent, because a body field that does not exist gets rejected by the API.
 */

/** A TS type annotation reduced to what the manifest can express. */
function jsonType(node) {
  if (!node) return "string";
  switch (node.type) {
    case "TSStringKeyword": return "string";
    case "TSNumberKeyword": return "number";
    case "TSBooleanKeyword": return "boolean";
    case "TSArrayType": return "array";
    case "TSUnionType": {
      // A union of string literals is an enum, which is worth keeping: it
      // tells the model exactly which values are legal.
      const literals = node.types.filter((t) => t.type === "TSLiteralType" && t.literal?.type === "StringLiteral");
      if (literals.length && literals.length >= node.types.length - 1) return "enum";
      const first = node.types.find((t) => !["TSNullKeyword", "TSUndefinedKeyword"].includes(t.type));
      return jsonType(first);
    }
    case "TSLiteralType": return typeof node.literal?.value === "boolean" ? "boolean" : "string";
    default: return "string";
  }
}

function enumValues(node) {
  if (node?.type !== "TSUnionType") return undefined;
  const values = node.types
    .filter((t) => t.type === "TSLiteralType" && t.literal?.type === "StringLiteral")
    .map((t) => t.literal.value);
  return values.length ? values : undefined;
}

function membersOf(typeNode) {
  // A type alias holds `members`; an interface body holds `body`, which IS the
  // array rather than a wrapper around one. Reading only the alias shape meant
  // every interface in the codebase was silently skipped.
  const members = typeNode?.members ?? (Array.isArray(typeNode?.body) ? typeNode.body : typeNode?.body?.body) ?? [];
  return members
    .filter((m) => m.type === "TSPropertySignature" && (m.key?.name || m.key?.value))
    .map((m) => {
      const annotation = m.typeAnnotation?.typeAnnotation;
      const type = jsonType(annotation);
      const values = enumValues(annotation);
      return {
        name: m.key.name ?? m.key.value,
        // `?:` is the whole optionality story in a type, and it is exact
        // rather than heuristic.
        required: !m.optional,
        type,
        ...(values ? { enumValues: values } : {}),
      };
    });
}

/** UpdateTaskInput / UpdateTaskPayload / UpdateTaskBody / UpdateTaskArgs -> updateTask */
const SUFFIXES = /(Input|Payload|Body|Args|Params|Request|Dto|Data)$/;
const candidateNames = (typeName) => {
  const bare = typeName.replace(SUFFIXES, "");
  return [typeName, bare].map((n) => n.charAt(0).toLowerCase() + n.slice(1));
};

export const tsTypes = {
  name: "typescript-types",
  describe: "type aliases and interfaces naming an action's input",

  run({ srcDir, actions = [] }) {
    const needsBody = actions.filter((a) => !a.bodyFields?.length);
    if (!needsBody.length) return {};

    const visit = traverse.default ?? traverse;
    const types = new Map();

    for (const file of walk(srcDir, (n) => /\.tsx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      visit(ast, {
        TSTypeAliasDeclaration(nodePath) {
          const fields = membersOf(nodePath.node.typeAnnotation);
          if (fields.length) types.set(nodePath.node.id.name, fields);
        },
        TSInterfaceDeclaration(nodePath) {
          const fields = membersOf(nodePath.node.body);
          if (fields.length) types.set(nodePath.node.id.name, fields);
        },
      });
    }
    if (!types.size) return {};

    // Match by name, longest first, so UpdateTaskInput wins over TaskInput for
    // updateTask rather than whichever happened to be parsed first.
    const byLength = [...types.keys()].sort((a, b) => b.length - a.length);
    const filled = [];
    for (const action of needsBody) {
      const match = byLength.find((typeName) => candidateNames(typeName).includes(action.name));
      if (!match) continue;
      // URL parameters are already carried in `params`; repeating them as body
      // fields would tell the model to send an id twice.
      const urlParams = new Set((action.params ?? []).map((p) => p.name));
      action.bodyFields = types.get(match).filter((f) => !urlParams.has(f.name));
      filled.push(`${action.name} from ${match}`);
    }
    return { notes: filled.length ? [`body fields from TypeScript: ${filled.join(", ")}`] : [] };
  },
};
