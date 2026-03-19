// ─────────────────────────────────────────────────────
// VITA Platform — Structured Logger
// JSON formatında yapısal loglama — dış bağımlılık yok
// Production'da dosyaya yazılabilir, şimdilik console
// ─────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
  error?: string;
  stack?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[MIN_LEVEL];
}

function formatEntry(entry: LogEntry): string {
  if (process.env.NODE_ENV === 'production') {
    // Production: JSON format (ELK/CloudWatch uyumlu)
    return JSON.stringify(entry);
  }

  // Development: okunabilir format
  const levelColors: Record<LogLevel, string> = {
    debug: '\x1b[36m', // cyan
    info: '\x1b[32m',  // green
    warn: '\x1b[33m',  // yellow
    error: '\x1b[31m', // red
  };
  const reset = '\x1b[0m';
  const color = levelColors[entry.level];

  let msg = `${entry.timestamp} ${color}[${entry.level.toUpperCase()}]${reset} [${entry.module}] ${entry.message}`;
  if (entry.data) {
    msg += ` ${JSON.stringify(entry.data)}`;
  }
  if (entry.error) {
    msg += ` ERR: ${entry.error}`;
  }
  return msg;
}

function log(level: LogLevel, module: string, message: string, extra?: { data?: any; error?: any }) {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };

  if (extra?.data) entry.data = extra.data;
  if (extra?.error) {
    entry.error = extra.error instanceof Error ? extra.error.message : String(extra.error);
    if (extra.error instanceof Error && extra.error.stack) {
      entry.stack = extra.error.stack;
    }
  }

  const output = formatEntry(entry);

  switch (level) {
    case 'error':
      console.error(output);
      break;
    case 'warn':
      console.warn(output);
      break;
    default:
      console.log(output);
  }
}

// ── Module-scoped logger factory ──
export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: any) => log('debug', module, msg, { data }),
    info: (msg: string, data?: any) => log('info', module, msg, { data }),
    warn: (msg: string, data?: any) => log('warn', module, msg, { data }),
    error: (msg: string, err?: any, data?: any) => log('error', module, msg, { error: err, data }),
  };
}

// ── HTTP request logger middleware ──
export function requestLogger() {
  const logger = createLogger('HTTP');

  return (req: any, res: any, next: any) => {
    const start = Date.now();

    // Response bitince logla
    const originalEnd = res.end;
    res.end = function (...args: any[]) {
      const duration = Date.now() - start;
      const logData = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip || req.connection?.remoteAddress,
      };

      if (res.statusCode >= 500) {
        logger.error(`${req.method} ${req.path} ${res.statusCode}`, null, logData);
      } else if (res.statusCode >= 400) {
        logger.warn(`${req.method} ${req.path} ${res.statusCode}`, logData);
      } else {
        logger.info(`${req.method} ${req.path} ${res.statusCode}`, logData);
      }

      originalEnd.apply(res, args);
    };

    next();
  };
}

// Default logger
export const logger = createLogger('App');
