import { redact } from "./redact.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  readonly level: LogLevel;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface LoggerOptions {
  level: LogLevel;
  prefix?: string;
}

/**
 * Logging always goes to stderr. stdout belongs to `--json` output, and a stray
 * log line there would corrupt a caller's parse.
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = ORDER[options.level];
  const prefix = options.prefix ? `${options.prefix} ` : "";

  const emit = (level: Exclude<LogLevel, "silent">, args: unknown[]): void => {
    if (threshold < ORDER[level]) return;
    const body = args.map(redact).join(" ");
    process.stderr.write(`${prefix}[${level}] ${body}\n`);
  };

  return {
    level: options.level,
    error: (...args) => emit("error", args),
    warn: (...args) => emit("warn", args),
    info: (...args) => emit("info", args),
    debug: (...args) => emit("debug", args),
  };
}

/** A logger that discards everything. Useful as a default in library code. */
export const silentLogger: Logger = createLogger({ level: "silent" });
