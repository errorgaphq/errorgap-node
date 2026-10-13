import { runCli } from "./cli.js";

void runCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch,
  env: process.env,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code;
});
