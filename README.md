# In-memory Git forge

A single Node.js process serves Git smart HTTP, REST v3, GraphQL, and MCP on one shared store. Repositories are created through REST or MCP; their refs and objects are shared with Git and the contents API. There is no database, dependency install, or Git executable in the application.

Run `node main.ts` with Node 22.18+ and the suite-provided `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`, and optional `MAKEFUN_TRIAL_NOW`. The process binds an ephemeral port, registers it, and serves until the suite marks the run done. The contest fixture defines the default viewer; `FORGE_OWNER` can override that login for a local deployment. Run the project tests with `node --test 'test/*.test.ts'`.

This covers the published competition API subset, not GitHub in full. State lasts for the process lifetime. Pull requests support squash merges with conservative file-level conflict detection. MCP implements stateless HTTP POST, not a server-initiated stream.
