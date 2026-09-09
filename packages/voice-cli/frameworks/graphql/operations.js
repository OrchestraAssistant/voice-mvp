import traverse from "@babel/traverse";
import { parseFile, walk } from "../../core/parse.js";

/**
 * GraphQL operations, read from the `gql` documents in the client source.
 *
 * A GraphQL client names its operations in tagged-template documents:
 *
 *   const CREATE_TASK = gql`
 *     mutation CreateTask($title: String!, $priority: Priority) {
 *       createTask(input: { title: $title, priority: $priority }) { id }
 *     }`;
 *
 * The operation header is everything needed: `mutation` vs `query` is read vs
 * write, the name becomes the tool, and the `$var: Type` list is the arguments
 * (a trailing `!` is required). The whole document is shipped so the widget's
 * graphql transport can POST it as `query`; the server does the rest.
 *
 * Only SELF-CONTAINED documents are emitted -- a `gql` template with no `${...}`
 * interpolation. A document that splices in a fragment cannot be reassembled
 * into a valid query statically without resolving every fragment reference, and
 * an operation whose document we cannot faithfully reproduce would be
 * addressable but uncallable -- the same trap that keeps Server Actions out.
 * Its header is still readable, but we do not pretend we can call it.
 * Subscriptions are skipped: they are not a request/response call.
 *
 * No AST of the GraphQL itself -- that would mean a graphql parser dependency.
 * The operation header is a small, regular grammar; the body we never inspect,
 * we only forward.
 */

/** A GraphQL variable type -> the manifest's small vocabulary. */
const SCALAR = { String: "string", ID: "string", Int: "number", Float: "number", Boolean: "boolean" };
function mapType(typeText) {
  const t = typeText.trim();
  if (/^\[.*\]/.test(t)) return "array"; // [String!], [ID!]! ...
  const base = t.replace(/[[\]!]/g, "").trim();
  return SCALAR[base] ?? "string"; // a custom scalar, enum or input object
}

/** Parse an operation header: `mutation Name($a: Int!, $b: T = 3) { ... }`. */
function parseOperation(doc) {
  const header = doc.match(/\b(query|mutation|subscription)\s+([A-Za-z_]\w*)\s*(\(([\s\S]*?)\))?/);
  if (!header) return null;
  const [, kind, name, , varsBlock] = header;
  if (kind === "subscription") return null;

  const variables = [];
  if (varsBlock) {
    for (const m of varsBlock.matchAll(/\$(\w+)\s*:\s*([^,)]+)/g)) {
      const rawType = m[2].split("=")[0].trim(); // drop a default value
      variables.push({ name: m[1], type: mapType(rawType), required: /!\s*$/.test(rawType) });
    }
  }
  return { kind, name, variables };
}

/** camelCase the operation name into a tool name: CreateTask -> createTask. */
const toolName = (name) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * The GraphQL endpoint, best-effort, from a client config -- `uri`/`url` on an
 * ApolloClient / HttpLink / urql createClient / GraphQLClient. Defaults to
 * `/graphql`, which is where the overwhelming majority of apps mount it.
 */
function findEndpoint(srcDir, visit) {
  for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
    let ast;
    try {
      ast = parseFile(file);
    } catch {
      continue;
    }
    let imports = false;
    let uri = null;
    visit(ast, {
      ImportDeclaration(p) {
        if (/^(@apollo\/client|urql|@urql\/|graphql-request)/.test(p.node.source?.value ?? "")) imports = true;
      },
      ObjectProperty(p) {
        const key = p.node.key?.name ?? p.node.key?.value;
        if ((key === "uri" || key === "url") && p.node.value?.type === "StringLiteral" && !uri) {
          const v = p.node.value.value;
          if (/graphql/i.test(v) || v.startsWith("/")) uri = v;
        }
      },
    });
    if (imports && uri) return uri.replace(/^https?:\/\/[^/]+/, "") || "/graphql";
  }
  return "/graphql";
}

export const graphqlOperations = {
  name: "graphql-operations",
  role: "producer",
  describe: "gql`query/mutation Name($v: T) {...}` operation documents",

  run({ srcDir }) {
    const visit = traverse.default ?? traverse;
    const queries = [];
    const actions = [];
    const seen = new Set();
    let endpoint = null; // resolved lazily, only if an operation is found

    const consider = (quasiNode) => {
      // Interpolated documents (fragments spliced in) cannot be reproduced
      // faithfully here, so they are not emitted as callable operations.
      if (quasiNode.expressions.length !== 0) return;
      const doc = quasiNode.quasis[0]?.value?.cooked ?? quasiNode.quasis[0]?.value?.raw;
      if (!doc) return;
      const parsed = parseOperation(doc);
      if (!parsed) return;
      const name = toolName(parsed.name);
      if (seen.has(name)) return;
      seen.add(name);

      endpoint ??= findEndpoint(srcDir, visit);
      const base = {
        name,
        description: `Auto-detected GraphQL ${parsed.kind} ${parsed.name}`,
        method: parsed.kind === "query" ? "GET" : "POST", // read vs write intent; the wire is always POST
        endpoint,
        transport: "graphql",
        operationName: parsed.name,
        document: doc.trim(),
        // GraphQL passes every argument as `variables`; the transport reads them
        // off bodyFields for queries and mutations alike.
        params: [],
        bodyFields: parsed.variables,
      };
      if (parsed.kind === "query") {
        queries.push(base);
      } else {
        actions.push({ ...base, requiresConfirmation: /delete|remove|destroy/i.test(parsed.name) });
      }
    };

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      visit(ast, {
        TaggedTemplateExpression(nodePath) {
          const tag = nodePath.node.tag;
          const tagName = tag?.type === "Identifier" ? tag.name : tag?.property?.name;
          if (tagName === "gql" || tagName === "graphql") consider(nodePath.node.quasi);
        },
      });
    }
    return { queries, actions };
  },
};
