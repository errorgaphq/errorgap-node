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

After reporting an uncaught exception or unhandled rejection the SDK exits the
process with code 1, as Node does when nothing listens for those events (a
process that carries on after one is in an unknown state). It leaves the exit
to you when your app has its own listener for the event, or with
`exitOnUncaught: false`.

### Filtering and dropping notices

```ts
Errorgap.init({
  filterKeys: ["password", "token", /^ssn$/],
  beforeNotify(notice) {
    if (notice.errors[0]?.type === "AbortError") return false; // drop it
    notice.context.team = "billing";                            // or change it
  },
});
```

`filterKeys` are masked at any depth in `params` and `session`. Values that
cannot be serialized (cycles, bigints) and oversized strings or collections
are cut rather than losing the notice.

### Users, causes and releases

`notify(err, { user: { id, email } })` names the user an error happened to;
the Express error handler reads `req.user` for you. An error's `cause` chain
is reported with it. `release` defaults to `ERRORGAP_RELEASE`, the hosting
platform's commit variable (`SOURCE_VERSION`, `HEROKU_SLUG_COMMIT`,
`RENDER_GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, …) or the git checkout, and
`await Errorgap.trackRelease({ sha, branch })` records a deploy.

### Delivery

Notices are queued (at most `queueSize`, oldest dropped first) and sent a few
at a time with a `timeout`. A send that fails on the network or with a 5xx is
retried up to three times; after a 429 the SDK stops sending for the server's
`Retry-After`. `await Errorgap.flush()` before a planned exit.

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

## Sign-ins

Report sign-ins to your app; errorgap shows them beside SSH logins in
Security › Logins and flags a new IP, country or hour for a user. Off until
you opt in, since events carry user names and IPs:

```ts
Errorgap.init({ projectSlug: "ox-coffee", apiKey: process.env.ERRORGAP_API_KEY, authEvents: true, appName: "oxcoffee-web" });

// after your own credential check:
Errorgap.signIn(ok ? "success" : "failure", { user: email, req });
Errorgap.signIn("mfa_failure", { user: email, req });
```

Outcomes: `success`, `failure`, `password_reset`, `mfa_failure`, `locked`.
`req` (Express, Fastify or a plain Node request) supplies the IP (Express and
Fastify honor their trust-proxy setting), user agent and path, without the
query string. Never pass passwords or tokens; errorgap can also store user
names hashed (Security › Logins › Web apps › Privacy).

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
| `filterKeys` | `["password", "token", "secret", ...]` | Substrings (case-insensitive) or regexps, any depth |
| `beforeNotify` | none | Change a notice, or return `false` to drop it |
| `release` | `ERRORGAP_RELEASE`, platform commit variable, git checkout | Sent as `context.release` |
| `trackRelease` | `false` | Record the release when the first error is reported |
| `ignoreEnvironments` | `ERRORGAP_IGNORE_ENVIRONMENTS` or `[]` | Send nothing in these environments |
| `timeout` | `5` | Seconds per request |
| `queueSize` | `100` | Queued payloads; the oldest is dropped when full |
| `exitOnUncaught` | `true` | Exit with code 1 after reporting an uncaught error |
| `apmEnabled` | `false` | Send APM transactions |
| `apmSampleRate` | `1.0` | Fraction of transactions sent (errors are unaffected) |
| `captureGlobals` | `true` | Install process error hooks |
| `authEvents` | `false` | Send `signIn` events |
| `appName` | `ERRORGAP_APP_NAME` or the project slug | The app's name in Security › Logins |

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
