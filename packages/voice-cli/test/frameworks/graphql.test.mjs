import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { graphqlOperations } from "../../frameworks/graphql/operations.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "graphql-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("graphql-operations producer", () => {
  test("mutations become actions with typed variables, document and transport", () => {
    const dir = src({
      "ops.ts": `import { gql } from "@apollo/client";
        export const CREATE_TASK = gql\`
          mutation CreateTask($title: String!, $priority: Priority, $tagIds: [ID!]) {
            createTask(input: { title: $title, priority: $priority, tagIds: $tagIds }) { id }
          }\`;`,
    });
    const { actions } = graphqlOperations.run({ srcDir: dir });
    const a = actions.find((x) => x.name === "createTask");
    assert.ok(a, "mutation not found");
    assert.equal(a.transport, "graphql");
    assert.equal(a.method, "POST");
    assert.equal(a.operationName, "CreateTask");
    assert.match(a.document, /mutation CreateTask/);
    const f = Object.fromEntries(a.bodyFields.map((v) => [v.name, v]));
    assert.equal(f.title.type, "string");
    assert.equal(f.title.required, true);
    assert.equal(f.priority.required, false);
    assert.equal(f.tagIds.type, "array");
  });

  test("queries become queries with GET intent (the wire is still POST)", () => {
    const dir = src({
      "q.ts": `import { gql } from "urql";
        export const TASKS = gql\`query Tasks($limit: Int) { tasks(limit: $limit) { id } }\`;`,
    });
    const { queries, actions } = graphqlOperations.run({ srcDir: dir });
    assert.equal(actions.length, 0);
    const q = queries[0];
    assert.equal(q.name, "tasks");
    assert.equal(q.method, "GET");
    assert.equal(q.transport, "graphql");
    assert.equal(q.bodyFields[0].name, "limit");
  });

  test("a delete-ish mutation requires confirmation", () => {
    const dir = src({
      "d.ts": `import { gql } from "graphql-tag";
        export const D = gql\`mutation DeleteTask($id: ID!) { deleteTask(id: $id) }\`;`,
    });
    const { actions } = graphqlOperations.run({ srcDir: dir });
    assert.equal(actions[0].requiresConfirmation, true);
  });

  test("an interpolated (fragment) document is NOT emitted -- it can't be reproduced", () => {
    const dir = src({
      "frag.ts": `import { gql } from "@apollo/client";
        const FIELDS = gql\`fragment Fields on Task { id title }\`;
        export const GET = gql\`query GetTask($id: ID!) { task(id: $id) { ...Fields } } \${FIELDS}\`;`,
    });
    const { queries } = graphqlOperations.run({ srcDir: dir });
    // The fragment itself has no operation header; the interpolated query is skipped.
    assert.equal(queries.length, 0);
  });

  test("subscriptions are skipped; a non-gql tag is ignored", () => {
    const dir = src({
      "s.ts": `import { gql } from "@apollo/client";
        export const SUB = gql\`subscription OnTask { taskAdded { id } }\`;
        const css = styled\`mutation NotReal($x: Int) { y }\`;`,
    });
    const { queries, actions } = graphqlOperations.run({ srcDir: dir });
    assert.equal(queries.length + actions.length, 0);
  });

  test("endpoint is discovered from an Apollo client uri, else defaults to /graphql", () => {
    const discovered = src({
      "client.ts": `import { ApolloClient } from "@apollo/client";
        export const client = new ApolloClient({ uri: "https://api.example.com/graphql", cache });`,
      "ops.ts": `import { gql } from "@apollo/client";
        export const PING = gql\`query Ping { ping }\`;`,
    });
    assert.equal(graphqlOperations.run({ srcDir: discovered }).queries[0].endpoint, "/graphql");

    const dflt = src({ "ops.ts": `import { gql } from "@apollo/client"; export const P = gql\`query P { ping }\`;` });
    assert.equal(graphqlOperations.run({ srcDir: dflt }).queries[0].endpoint, "/graphql");
  });
});
