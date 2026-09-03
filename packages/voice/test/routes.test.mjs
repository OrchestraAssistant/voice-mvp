import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoutePath } from "../src/routes.js";

const routes = [
  { path: "/", component: "Dashboard" },
  { path: "/tasks/new", component: "NewTask" },
  { path: "/tasks/:id", component: "TaskDetail" },
  { path: "/settings", component: "Settings" },
];

describe("resolveRoutePath", () => {
  test("the well-formed call still works", () => {
    assert.equal(resolveRoutePath({ path: "/settings" }, routes), "/settings");
    assert.equal(resolveRoutePath({ path: "/" }, routes), "/");
  });

  test("the route in the key instead of the value", () => {
    // Observed live, four times in one session, every one an error.
    assert.equal(resolveRoutePath({ "/": "settings" }, routes), "/settings");
    assert.equal(resolveRoutePath({ "/": "dashboard" }, routes), "/");
  });

  test("a component name resolves to its path", () => {
    // "dashboard" is "/", which no amount of string matching on the path finds.
    assert.equal(resolveRoutePath({ path: "dashboard" }, routes), "/");
    assert.equal(resolveRoutePath({ page: "Settings" }, routes), "/settings");
  });

  test("a missing leading slash", () => {
    assert.equal(resolveRoutePath({ path: "settings" }, routes), "/settings");
  });

  test("a parameterised route is allowed through unrecognised", () => {
    // /tasks/3 is legitimate and will never be in the list literally.
    assert.equal(resolveRoutePath({ path: "/tasks/3" }, routes), "/tasks/3");
  });

  test("nothing usable returns null rather than a guess", () => {
    assert.equal(resolveRoutePath({}, routes), null);
    assert.equal(resolveRoutePath({ id: 4 }, routes), null);
    assert.equal(resolveRoutePath(undefined, routes), null);
  });

  test("`path` wins when both are present", () => {
    assert.equal(resolveRoutePath({ path: "/settings", other: "dashboard" }, routes), "/settings");
  });
});
