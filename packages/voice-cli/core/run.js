import { validateRegistry } from "./contract.js";

/**
 * Runs the registry and collects what each detector found.
 *
 * Producers first, then enrichers, by ROLE rather than by array order. The
 * context accumulates as it goes, which is how an enricher sees the actions a
 * producer discovered -- stated here because it used to be an undocumented
 * side effect of a loop.
 *
 * A detector that throws is reported and skipped. One framework's bad day
 * should not cost a user every other framework's results.
 */
export function runDetectors(detectors, base) {
  const errors = validateRegistry(detectors);
  if (errors.length) throw new Error(`Detector registry is invalid:\n  ${errors.join("\n  ")}`);

  const context = { ...base, routes: [], queries: [], actions: [] };
  const results = [];

  for (const role of ["producer", "enricher"]) {
    for (const detector of detectors.filter((d) => d.role === role)) {
      if (detector.applies && !detector.applies(context)) {
        results.push({ detector: detector.name, found: {}, skipped: true });
        continue;
      }
      let found;
      try {
        found = detector.run(context) ?? {};
      } catch (err) {
        results.push({ detector: detector.name, found: {}, failed: err.message });
        continue;
      }
      results.push({ detector: detector.name, found });
      for (const kind of ["routes", "queries", "actions"]) context[kind].push(...(found[kind] ?? []));
    }
  }
  return { results, context };
}

/** Exclusion rules contributed by the detectors that actually applied. */
export function activeExcludes(detectors, results) {
  const ran = new Set(results.filter((r) => !r.skipped).map((r) => r.detector));
  return detectors.filter((d) => ran.has(d.name)).flatMap((d) => d.excludes ?? []);
}
