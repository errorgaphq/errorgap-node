import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { detectRelease } from "./release.js";
import { VERSION } from "./version.js";

/**
 * The `errorgap` command line: the things done from a terminal or a deploy
 * script rather than from inside the app.
 *
 *   npx @errorgap/node test
 *   npx @errorgap/node deploy --sha "$GIT_SHA" --branch main
 *   npx @errorgap/node sourcemaps dist --release "$GIT_SHA"
 *   npx @errorgap/node settings
 */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  cwd: string;
}

const USAGE = `errorgap ${VERSION}

Usage: errorgap <command> [options]

Commands:
  test                      Send a test error and print where it landed
  deploy                    Record a release (shows on Deploys, attributes errors)
      --version <v> --sha <sha> --branch <b> --environment <e>
  sourcemaps <dir>          Upload every .map under <dir> for a release
      --release <r>         Defaults to the detected commit
      --url-prefix <p>      Path the files are served from (default "/")
  settings                  Show what errorgap tells this project's SDKs to send

Options (or the ERRORGAP_* environment variables):
  --endpoint <url>          ERRORGAP_ENDPOINT
  --project <slug>          ERRORGAP_PROJECT_SLUG
  --key <key>               ERRORGAP_API_KEY     (the project's API key)
  --upload-key <key>        ERRORGAP_UPLOAD_KEY  (secret; sourcemaps and deploy)
`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      const next = argv[index + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next !== undefined && !next.startsWith("--")) flags[name] = argv[++index] as string;
      else flags[name] = "true";
    } else {
      positional.push(arg);
    }
  }
  return { command: positional.shift(), positional, flags };
}

interface Target {
  base: string;
  slug: string;
  key: string | undefined;
  uploadKey: string | undefined;
}

function target(flags: Record<string, string>, io: CliIo): Target | string {
  const endpoint = flags.endpoint ?? io.env.ERRORGAP_ENDPOINT;
  const slug = flags.project ?? io.env.ERRORGAP_PROJECT_SLUG;
  if (!endpoint) return "No endpoint: pass --endpoint or set ERRORGAP_ENDPOINT.";
  if (!slug) return "No project: pass --project or set ERRORGAP_PROJECT_SLUG.";
  return {
    base: `${endpoint.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(slug)}`,
    slug,
    key: flags.key ?? io.env.ERRORGAP_API_KEY,
    uploadKey: flags["upload-key"] ?? io.env.ERRORGAP_UPLOAD_KEY,
  };
}

function headers(to: Target, secret: boolean): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `errorgap-cli/${VERSION}`,
  };
  // Build-time actions use the secret upload key when there is one.
  if (secret && to.uploadKey) result["x-errorgap-upload-key"] = to.uploadKey;
  else if (to.key) result["x-errorgap-project-key"] = to.key;
  return result;
}

async function explain(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const hint =
    response.status === 401 ? " (check the key)" : response.status === 404 ? " (check the endpoint and project)" : "";
  return `HTTP ${response.status}${hint}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

/** Every `.map` under `dir`, as paths relative to it with forward slashes. */
export function findSourceMaps(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      if (name === "node_modules") continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".map")) found.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return found;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    io.out(USAGE);
    return command ? 0 : 1;
  }
  if (command === "version" || flags.version === "true") {
    io.out(VERSION);
    return 0;
  }
  if (!["test", "deploy", "sourcemaps", "settings"].includes(command)) {
    io.err(`Unknown command "${command}".\n\n${USAGE}`);
    return 1;
  }
  const to = target(flags, io);
  if (typeof to === "string") {
    io.err(to);
    return 1;
  }

  try {
    if (command === "test") {
      const response = await io.fetch(`${to.base}/notices`, {
        method: "POST",
        headers: headers(to, false),
        body: JSON.stringify({
          received_at: new Date().toISOString(),
          errors: [{ type: "ErrorgapInstallTest", message: "Errorgap install verification", backtrace: [] }],
          context: {
            notifier: "errorgap-cli",
            notifier_version: VERSION,
            environment: flags.environment ?? io.env.ERRORGAP_ENVIRONMENT ?? "development",
          },
        }),
      });
      if (response.status !== 201 && response.status !== 202) {
        io.err(`The test error was not accepted: ${await explain(response)}`);
        return 1;
      }
      const body = (await response.json().catch(() => ({}))) as { group_id?: string };
      io.out(
        response.status === 201
          ? `Sent a test error to ${to.slug}${body.group_id ? ` (group ${body.group_id})` : ""}.`
          : `The test error reached ${to.slug} but was not stored (sampled out or over a limit).`,
      );
      return 0;
    }

    if (command === "deploy") {
      const release: Record<string, string> = {};
      const detected = detectRelease(io.cwd, io.env);
      const fields = {
        version: flags.version ?? flags.sha ?? detected,
        sha: flags.sha ?? detected,
        branch: flags.branch,
        environment: flags.environment ?? io.env.ERRORGAP_ENVIRONMENT ?? "production",
      };
      for (const [name, value] of Object.entries(fields)) if (value) release[name] = value;
      if (!release.version && !release.sha) {
        io.err("No release to record: pass --sha or --version (none could be detected here).");
        return 1;
      }
      const response = await io.fetch(`${to.base}/releases`, {
        method: "POST",
        headers: headers(to, true),
        body: JSON.stringify(release),
      });
      if (response.status !== 200 && response.status !== 201) {
        io.err(`The release was not recorded: ${await explain(response)}`);
        return 1;
      }
      io.out(`Recorded release ${release.sha ?? release.version} for ${to.slug} (${release.environment}).`);
      return 0;
    }

    if (command === "sourcemaps") {
      const dir = positional[0];
      const release = flags.release ?? detectRelease(io.cwd, io.env);
      if (!dir) {
        io.err("Which directory? errorgap sourcemaps <dir> --release <release>");
        return 1;
      }
      if (!release) {
        io.err("No release: pass --release (none could be detected here).");
        return 1;
      }
      if (!to.uploadKey) {
        io.err("Source maps need the project's upload key: pass --upload-key or set ERRORGAP_UPLOAD_KEY.");
        return 1;
      }
      const prefix = `/${(flags["url-prefix"] ?? "").replace(/^\/+|\/+$/g, "")}`.replace(/\/$/, "");
      const maps = findSourceMaps(dir);
      let failed = 0;
      for (const map of maps) {
        // A map is filed under the URL of the script it describes.
        const file = `${prefix}/${map.replace(/\.map$/, "")}`;
        const response = await io.fetch(
          `${to.base}/sourcemaps?release=${encodeURIComponent(release)}&file=${encodeURIComponent(file)}`,
          { method: "PUT", headers: headers(to, true), body: readFileSync(join(dir, map)) },
        );
        if (response.status >= 300) {
          failed++;
          io.err(`  failed ${file}: ${await explain(response)}`);
        }
      }
      io.out(`${maps.length - failed} uploaded, ${failed} failed (release ${release}).`);
      return failed === 0 && maps.length > 0 ? 0 : 1;
    }

    const response = await io.fetch(`${to.base}/config`, { headers: headers(to, false) });
    if (response.status !== 200) {
      io.err(`The settings could not be read: ${await explain(response)}`);
      return 1;
    }
    const settings = (await response.json()) as Record<string, unknown>;
    for (const [label, field] of [["Errors", "errors_enabled"], ["Performance", "apm_enabled"], ["Logs", "logs_enabled"]] as const) {
      io.out(`${label.padEnd(12)} ${settings[field] === false ? "off" : "on"}`);
    }
    return 0;
  } catch (exception) {
    io.err(`Could not reach errorgap: ${exception instanceof Error ? exception.message : String(exception)}`);
    return 1;
  }
}
