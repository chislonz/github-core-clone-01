# In-memory Git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/chislonz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/chislonz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone Git forge for the make.fun competition. One Node.js process serves Git smart HTTP, REST v3, GraphQL, and MCP over a shared in-memory store. Repositories created through REST or MCP share their refs and objects with Git and the contents API. The application uses only the Node.js standard library and its own code.

## Run it

```sh
node main.ts
```

Use Node 22.18+ with the suite-provided `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`, and optional `MAKEFUN_TRIAL_NOW`. The forge binds an ephemeral port, registers it with the suite, and serves until the suite marks the run done. `FORGE_OWNER` can override the default viewer login for a local deployment. Run the project tests with `node --test`.

The forge implements the published competition API subset. State lasts for the process lifetime. Pull requests support squash merges with file-level conflict detection. MCP uses stateless HTTP POST.
