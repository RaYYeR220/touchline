import { defineConfig, searchForWorkspaceRoot } from "vite";

// The dashboard reads decoders straight from the sibling @touchline/venue-client
// and @touchline/agent workspace packages (npm workspaces symlinks, TS sources,
// no build step). Vite needs the monorepo root in its allow-list to serve them.
export default defineConfig({
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())],
    },
  },
  // @touchline/venue-client's Codama-generated error module guards its dev-only
  // error registration behind `process.env["NODE_ENV"]`, which is a Node-ism
  // that doesn't exist in the browser. Define `process.env` as an empty object
  // so that check evaluates to `undefined` instead of throwing a ReferenceError.
  define: {
    "process.env": "{}",
  },
});
