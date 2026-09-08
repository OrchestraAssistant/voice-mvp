import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSkill } from "./skill.js";

/** Run installSkill with cwd pointed at a throwaway dir. */
function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("installing the enrichment skill", () => {
  test("writes the shipped SKILL.md into .claude/skills, version-locked", () => {
    inDir((dir) => {
      installSkill([]);
      const path = join(dir, ".claude", "skills", "enrich-voice-manifest", "SKILL.md");
      assert.ok(existsSync(path), "skill written where Claude Code discovers it");
      const body = readFileSync(path, "utf8");
      // It is the real skill: frontmatter a discoverer reads, and the flag
      // worklist it operates on.
      assert.match(body, /^---[\s\S]*name: enrich-voice-manifest/);
      assert.match(body, /manifest\.overlay\.json/);
      assert.match(body, /review|confidence|bodyFields/);
    });
  });

  test("--agents points AGENTS.md at the skill for non-Claude agents", () => {
    inDir((dir) => {
      installSkill(["--agents"]);
      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      assert.match(agents, /Enriching the @yourco\/voice manifest/);
      assert.match(agents, /\.claude\/skills\/enrich-voice-manifest\/SKILL\.md/);
    });
  });

  test("--agents is idempotent: a second run does not duplicate the pointer", () => {
    inDir((dir) => {
      installSkill(["--agents"]);
      installSkill(["--agents"]);
      const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      assert.equal(agents.match(/Enriching the @yourco\/voice manifest/g).length, 1);
    });
  });
});
