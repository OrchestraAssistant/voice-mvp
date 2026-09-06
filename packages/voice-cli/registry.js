/**
 * Everything we can read, in one list.
 *
 * This is the file you edit to add coverage. A new framework is a directory
 * under frameworks/ exporting detectors, plus a line here. Nothing else in the
 * pipeline learns that the framework exists: not the runner, not the merge,
 * not the report, not the exclusion engine.
 *
 * Order within a role does not matter -- the runner sorts producers before
 * enrichers -- with one deliberate exception noted below.
 */
import { reactRouter } from "./frameworks/react/router.js";
import { requestHooks } from "./frameworks/react/requestHooks.js";
import { nextAppRouter, nextPagesRouter } from "./frameworks/next/routes.js";
import { nextRouteHandlers, nextPagesApi } from "./frameworks/next/api.js";
import { trpcRouters } from "./frameworks/trpc/router.js";
import { zodBodies } from "./schema/zod.js";
import { tsTypes } from "./schema/typescript.js";
import { pageMetadata } from "./schema/pageMetadata.js";

export const DETECTORS = [
  // Producers: find the operations.
  reactRouter,
  requestHooks,
  nextAppRouter,
  nextPagesRouter,
  nextRouteHandlers,
  nextPagesApi,
  trpcRouters,

  // Enrichers: fill in what the producers could not see. Zod before
  // TypeScript on purpose -- writing a schema is a statement of intent about
  // the wire, while a type that shares a name is a correlation, and the
  // TypeScript reader only fills what is still empty.
  zodBodies,
  tsTypes,
  pageMetadata,
];
