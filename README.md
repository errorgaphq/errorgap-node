# @errorgap/node

Node.js notifier for [Errorgap](https://errorgap.com). Captures exceptions,
normalizes V8 stack traces with bounded source excerpts for readable frames,
and ships notices to an Errorgap server. Records APM transactions (requests
and jobs) that link to the errors they raised. Ships opt-in Express and
Fastify integrations.

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

### Express performance (APM)

Mount `errorgapRequestHandler()` first and enable APM. Each request is
recorded as a transaction under its route template (`/orders/:id`); errors
reported while it runs — including by `errorgapErrorHandler` — carry its
transaction id, so errorgap shows the error a request raised on its trace.

```ts
import { errorgapErrorHandler, errorgapRequestHandler, requestSpans } from "@errorgap/node/express";

Errorgap.init({ apmEnabled: true, apmSampleRate: 1.0 });

const app = express();
app.use(errorgapRequestHandler()); // first
app.get("/orders/:id", async (req, res) => {
  const started = performance.now();
  const order = await db.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  requestSpans(res)?.database("SELECT * FROM orders WHERE id = $1", performance.now() - started);
  res.json(order);
});
app.use(errorgapErrorHandler()); // last
```

When the errorgap browser SDK (`@errorgap/browser` 0.3+) is on the page, its
API calls send an `x-errorgap-trace` header. The request handler records it,
so the browser Performance view links each call to the server request that
answered it. Cross-origin APIs need the header allowed by CORS and listed in
the browser SDK's `performance.tracePropagationTargets`.

## Transactions and jobs

```ts
await Errorgap.trackTransaction(
  { method: "GET", path: "/orders/:id", pathRaw: "/orders/123" },
  async (spans) => {
    spans.database("SELECT * FROM orders WHERE id = 123", 4.2);
    spans.external(88.0);
  },
);

await Errorgap.trackJob("ReceiptJob", async (spans) => {
  // ...
}, { queue: "mailers" });
```

Both time the callback and deliver on completion even if it throws. Errors
reported while the callback runs carry the transaction id
(`context.transaction_id`); the id follows awaits through `AsyncLocalStorage`,
so concurrent requests never share one. `Errorgap.currentTransactionId()`
returns the id in effect. Use `Errorgap.notifyTransaction(...)` for a
pre-measured transaction, with `traceId: browserTraceId(header)` to link a
browser call.

## Fastify

```ts
import Fastify from "fastify";
import { errorgapPlugin } from "@errorgap/node/fastify";

const app = Fastify();
await app.register(errorgapPlugin);
```

The plugin also records each request as an APM transaction (with
`apmEnabled: true`) under its route template (`/orders/:id`), links errors
reported during it, and records the browser SDK's `x-errorgap-trace` header.
Record spans with `requestSpans(request)?.database(sql, ms)` from
`@errorgap/node/fastify`.

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
| `apmEnabled` | `false` | Send APM transactions |
| `apmSampleRate` | `1.0` | Fraction of transactions sent (errors are unaffected) |
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
