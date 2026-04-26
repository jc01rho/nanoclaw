/**
 * Step: auth — Verify or write an Anthropic credential to .env.
 *
 * Modes:
 *   --check                   (default) Verify ANTHROPIC_API_KEY exists in .env.
 *   --create --value <token>  Write ANTHROPIC_API_KEY to .env.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

function readDotEnv(): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return {};
  const content = fs.readFileSync(envFile, 'utf-8');
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value) result[key] = value;
  }
  return result;
}

function writeDotEnv(data: Record<string, string>): void {
  const envFile = path.join(process.cwd(), '.env');
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const keptLines = existing
    .split('\n')
    .filter((line) => !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=/.test(line));
  const lines = [...keptLines.filter((line) => line.length > 0), ...Object.entries(data).map(([k, v]) => `${k}=${v}`)];
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
}

interface Args {
  mode: 'check' | 'create';
  value?: string;
  force: boolean;
}

function parseArgs(args: string[]): Args {
  let mode: 'check' | 'create' = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--create':
        mode = 'create';
        break;
      case '--value':
        value = val;
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (mode === 'create' && !value) {
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'missing_value_for_create',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { mode, value, force };
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);

  const env = readDotEnv();
  const existing = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN;

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: !!existing,
      ANTHROPIC_OK: !!existing,
      STATUS: existing ? 'success' : 'missing',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (existing && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'anthropic_credential_already_in_env',
      HINT: 'Re-run with --force to replace.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const nextVars = value!.startsWith('sk-ant-oat') ? { ANTHROPIC_AUTH_TOKEN: value! } : { ANTHROPIC_API_KEY: value! };
  writeDotEnv(nextVars);
  log.info('Wrote Anthropic credential to .env', {
    variable: value!.startsWith('sk-ant-oat') ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY',
  });

  emitStatus('AUTH', {
    SECRET_PRESENT: true,
    ANTHROPIC_OK: true,
    CREATED: true,
    STATUS: 'success',
    AUTH_VARIABLE: value!.startsWith('sk-ant-oat') ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY',
    LOG: 'logs/setup.log',
  });
}
