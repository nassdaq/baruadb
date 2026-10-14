// Before a deploy: the SDK is one file, and the Worker serves it at /sdk.mjs
// (with its types at /sdk.d.ts) so it can be imported by URL or fetched into
// a project. The canonical copy lives in sdk/; this puts it where the
// Worker's static assets are read from.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public", { recursive: true });
copyFileSync("sdk/index.mjs", "public/sdk.mjs");
copyFileSync("sdk/index.d.ts", "public/sdk.d.ts");
console.log("sdk -> public/sdk.mjs, public/sdk.d.ts");
