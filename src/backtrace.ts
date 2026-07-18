import { readFileSync, statSync } from "node:fs";
import { sep as pathSep } from "node:path";

export interface SourceExcerpt {
  start_line: number;
  lines: string[];
}

export interface BacktraceFrame {
  file?: string;
  line?: number;
  function?: string;
  in_app?: boolean;
  index: number;
  source?: SourceExcerpt;
}

const V8_AT = /^\s*at\s+(?:(.*?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/;
export const SOURCE_CONTEXT_RADIUS = 6;
export const MAX_SOURCE_LINE_CHARS = 400;
export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

export function parseBacktrace(
  error: Error,
  rootDirectory: string,
): BacktraceFrame[] {
  const stack = typeof error.stack === "string" ? error.stack : "";
  const lines = stack.split("\n");
  const frames: BacktraceFrame[] = [];
  let index = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;

    const match = line.match(V8_AT);
    if (!match) continue;

    const fnName = match[1];
    const location = stripFileScheme(match[2] ?? "");
    const lineNumber = match[3] ? Number(match[3]) : undefined;

    const source = sourceExcerpt(location, lineNumber);
    frames.push({
      file: relativeFile(location, rootDirectory),
      line: lineNumber,
      function: fnName || undefined,
      in_app: isInApp(location, rootDirectory),
      index: index++,
      ...(source ? { source } : {}),
    });
  }

  return frames;
}

export function sourceExcerpt(file: string, line?: number): SourceExcerpt | undefined {
  if (!line || line < 1 || file.startsWith("node:") || file.startsWith("<")) {
    return undefined;
  }

  try {
    if (statSync(file).size > MAX_SOURCE_FILE_BYTES) return undefined;
    const sourceLines = readFileSync(file, "utf8").split(/\r?\n/);
    if (line > sourceLines.length) return undefined;

    const startLine = Math.max(1, line - SOURCE_CONTEXT_RADIUS);
    const endLine = Math.min(sourceLines.length, line + SOURCE_CONTEXT_RADIUS);
    return {
      start_line: startLine,
      lines: sourceLines
        .slice(startLine - 1, endLine)
        .map((sourceLine) => sourceLine.slice(0, MAX_SOURCE_LINE_CHARS)),
    };
  } catch {
    return undefined;
  }
}

function stripFileScheme(location: string): string {
  if (location.startsWith("file://")) {
    try {
      return new URL(location).pathname;
    } catch {
      return location;
    }
  }
  return location;
}

function relativeFile(file: string, root: string): string {
  if (!root) return file;
  const normalizedRoot = root.endsWith(pathSep) ? root : root + pathSep;
  if (file.startsWith(normalizedRoot)) {
    return file.slice(normalizedRoot.length);
  }
  return file;
}

function isInApp(file: string, root: string): boolean {
  if (!root) return false;
  if (file.includes("node_modules")) return false;
  if (file.startsWith("node:")) return false;
  return file.startsWith(root);
}
