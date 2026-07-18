# @errorgap/node

Node.js notifier for [Errorgap](https://errorgap.com). Captures exceptions,
normalizes V8 stack traces with bounded source excerpts for readable frames,
and ships notices to an Errorgap server. Ships
opt-in Express and Fastify integrations.

## Install

```sh
npm install @errorgap/node
```

Requires Node 20+.

## Configure

Import as early as possible in the app entry point:

```ts
import { Errorgap } from "@errorgap/node";

Errorgap.init({
  endpoint:    process.env.ERRORGAP_ENDPOINT,
  projectSlug: process.env.ERRORGAP_PROJECT_SLUG,
  apiKey:      process.env.ERRORGAP_API_KEY,
  environment: process.env.NODE_ENV,
});
```

`init` reads the same values from `ERRORGAP_ENDPOINT`,
`ERRORGAP_PROJECT_SLUG`, `ERRORGAP_PROJECT_ID`, `ERRORGAP_API_KEY` if you
don't pass them. `init` installs `uncaughtException` and `unhandledRejection`
hooks by default — pass `captureGlobals: false` to skip.

## Manual notification

```ts
try {
  await risky();
} catch (err) {
  await Errorgap.notify(err, { context: { component: "billing" } });
  throw err;
}
```

`notify` returns a `DeliveryResult` (`{ status, body }` on success,
`{ error }` on failure, `{ queued: true, status: 202 }` in async mode). The
SDK never throws.

## Express

```ts
import express from "express";
import { errorgapErrorHandler } from "@errorgap/node/express";

const app = express();
// ... your routes ...
app.use(errorgapErrorHandler()); // last middleware in the chain
```

## Fastify

```ts
import Fastify from "fastify";
import { errorgapPlugin } from "@errorgap/node/fastify";

const app = Fastify();
await app.register(errorgapPlugin);
```

## Configuration reference

| Option | Default | Notes |
|---|---|---|
| `endpoint` | `ERRORGAP_ENDPOINT` or `http://127.0.0.1:3030` | Base URL, no trailing slash |
| `projectSlug` | `ERRORGAP_PROJECT_SLUG` | **Required** |
| `projectId` | `ERRORGAP_PROJECT_ID` | Optional, embedded in payload |
| `apiKey` | `ERRORGAP_API_KEY` | Sent as `x-errorgap-project-key` |
| `environment` | `NODE_ENV` or `development` | |
| `rootDirectory` | `process.cwd()` | Used to mark frames as `in_app` |
| `async` | `true` | Fire-and-forget delivery |
| `logger` | `console` | Pass `null` to silence |
| `filterKeys` | `["password", "token", "secret", ...]` | Substring match, case-insensitive |
| `captureGlobals` | `true` | Install process error hooks |

## Verify

```sh
curl -sS -X POST "$ERRORGAP_ENDPOINT/api/projects/$ERRORGAP_PROJECT_SLUG/notices" \
  -H "content-type: application/json" \
  -H "x-errorgap-project-key: $ERRORGAP_API_KEY" \
  -d '{"errors":[{"type":"ErrorgapInstallTest","message":"Errorgap install verification"}],"context":{"environment":"development"}}'
```

Then trigger a real error and confirm it appears in the Errorgap UI.

## Development

```sh
npm install
npm test
npm run build
```

## License

MIT.
