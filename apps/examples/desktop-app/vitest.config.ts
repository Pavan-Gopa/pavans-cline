import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			// [+pavan] Workflow board UI lives in .pavan/overlay (outside the
			// webview root), so bare react imports there resolve against
			// nothing. The Next build handles this via project-root
			// resolution; mirror it here so pane tests can import it.
			// Specific subpaths first: "react" alone would prefix-match them.
			{
				find: "react/jsx-dev-runtime",
				replacement: fileURLToPath(new URL("./node_modules/react/jsx-dev-runtime.js", import.meta.url)),
			},
			{
				find: "react/jsx-runtime",
				replacement: fileURLToPath(new URL("./node_modules/react/jsx-runtime.js", import.meta.url)),
			},
			{
				find: "react",
				replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)),
			},
			{
				find: "@",
				replacement: fileURLToPath(new URL("./webview", import.meta.url)),
			},
		],
	},
	test: {
		environment: "node",
		// First test in a file pays the @cline/core → llms module-graph import
		// cost, which sits near the 5s default under CI contention.
		testTimeout: 20_000,
	},
});
