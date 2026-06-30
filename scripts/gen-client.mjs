import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import * as renderers from "@codama/renderers-js";
import { readFileSync } from "node:fs";

const idl = JSON.parse(
  readFileSync(new URL("../target/idl/touchline.json", import.meta.url)),
);
const codama = createFromRoot(rootNodeFromAnchor(idl));
const render =
  renderers.renderVisitor ??
  renderers.renderJavaScriptVisitor ??
  renderers.default;
codama.accept(render("packages/venue-client"));
console.log("generated venue-client into packages/venue-client");
