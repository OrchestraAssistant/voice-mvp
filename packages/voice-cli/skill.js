#!/usr/bin/env node
/**
 * Installs the manifest-enrichment SKILL into the app's repo, so the developer's
 * agent (the one already open with the code loaded) can run the judgement pass.
 *
 * Shipped IN the package and copied from here, so it is version-locked to the
 * manifest format this version produces -- a hosted guide would drift from
 * whatever version the developer installed. No API key, no service: the skill is
 * a procedure the agent already present runs, which is the whole point (see
 * DESIGN-PHILOSOPHY 2).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = path.join(HERE, "skills", "enrich-voice-manifest", "SKILL.md");

export function installSkill(argv = []) {
  const body = fs.readFileSync(SKILL_SRC, "utf8");

  // --print: emit to stdout, for piping into an agent that reads no skill format.
  if (argv.includes("--print")) {
    process.stdout.write(body);
    return;
  }

  const rel = path.join(".claude", "skills", "enrich-voice-manifest", "SKILL.md");
  const dest = path.resolve(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  console.log(`Installed the enrichment skill -> ${rel}`);
  console.log(`  Claude Code discovers it automatically. Run it after 'voice-cli' generates a manifest,`);
  console.log(`  or whenever a voice session mis-calls an API.`);

  // --agents: a pointer for agents without a skill format (Codex, Cursor, ...),
  // written into AGENTS.md, which those tools already read. Same skill file, one
  // source; this just tells a non-Claude agent where it is.
  if (argv.includes("--agents")) {
    const agentsPath = path.resolve("AGENTS.md");
    const marker = "Enriching the @yourco/voice manifest";
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
    if (!existing.includes(marker)) {
      fs.writeFileSync(
        agentsPath,
        `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}\n## ${marker}\n\n` +
          `After running \`voice-cli\`, resolve the operations it flagged by following the procedure in ` +
          `\`${rel}\`.\n`,
      );
      console.log(`  Pointed AGENTS.md at it for non-Claude agents.`);
    }
  }
}

// Runnable directly as a bin; also dispatched from generate.js's `skill` subcommand.
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  installSkill(process.argv.slice(2));
}
