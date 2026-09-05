// Pushes the secrets of the selected fnox profile to Fly.io before `fly deploy`: the image bakes
// only non-secret values (.docker.env), and Fly injects nothing else at runtime.
// Run under `wb dotenv` so process.env holds the profile selected by WB_ENV. Values are piped to
// `fly secrets import` via stdin and never appear in argv or logs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SYNCED_KEYS = ['SUPERTOKENS_URI', 'SUPERTOKENS_API_KEY'];

const wbEnv = process.env.WB_ENV;
const appName = fs.readFileSync(`fly-${wbEnv}.toml`, 'utf8').match(/^app\s*=\s*['"]([^'"]+)['"]/m)?.[1];
if (!appName) {
  console.error(`Failed to read the app name from fly-${wbEnv}.toml.`);
  process.exit(1);
}

const lines = [];
for (const key of SYNCED_KEYS) {
  const value = process.env[key];
  if (!value) {
    console.error(`${key} is missing or empty in the ${wbEnv} profile of fnox.toml; refusing to deploy.`);
    process.exit(1);
  }
  // `fly secrets import` parses raw KEY=VALUE lines, so a newline would split the value.
  if (value.includes('\n')) {
    console.error(`${key} contains a newline, which \`fly secrets import\` cannot represent.`);
    process.exit(1);
  }
  lines.push(`${key}=${value}`);
}

// --stage records the secrets without restarting machines; the subsequent `fly deploy` applies them.
const result = spawnSync('fly', ['secrets', 'import', '--app', appName, '--stage'], {
  input: lines.join('\n') + '\n',
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (result.error || result.status !== 0) {
  console.error(`Failed to import Fly secrets (exit ${result.status ?? 'spawn error'}).`);
  process.exit(result.status ?? 1);
}
console.info(`Synced ${SYNCED_KEYS.length} secret(s) to Fly app ${appName}: ${SYNCED_KEYS.join(', ')}`);
