// Manifest sanity check. Run before committing or publishing:
//   node scripts/check-package.mjs
//
// It exists because a stray UTF-8 BOM in package.json is enough to make DSH
// skip the whole bundle at startup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const problems = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const manifestText = read('package.json');
if (manifestText.charCodeAt(0) === 0xfeff) {
  problems.push('package.json starts with a UTF-8 BOM; DSH cannot parse it');
}

let manifest;
try {
  manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''));
} catch (error) {
  problems.push(`package.json is not valid JSON: ${error.message}`);
  manifest = null;
}

if (manifest) {
  for (const field of ['name', 'version', 'description']) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) problems.push(`package.json: missing ${field}`);
  }
  if (!manifest.dsh?.bundle?.patch) problems.push('package.json: missing dsh.bundle.patch');
  if (manifest.dsh?.client?.platform !== 'web') problems.push('package.json: dsh.client.platform must be "web"');
  if (!manifest.exports?.['./client']) problems.push('package.json: missing the ./client export');
  if (!manifest.exports?.['./icon']) problems.push('package.json: missing the ./icon export');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) problems.push('package.json: missing files list');
}

const patchFile = manifest?.dsh?.bundle?.patch;
if (patchFile) {
  const text = read(patchFile);
  if (!/insert:/.test(text)) problems.push(`${patchFile}: no insert entry`);
}

for (const entry of ['index.js', 'client.js', 'icon.svg', 'README.md', 'README.zh.md', 'LICENSE']) {
  if (!fs.existsSync(path.join(root, entry))) problems.push(`missing ${entry}`);
}

for (const locale of ['locale/zh.json', 'locale/en.json']) {
  try {
    const data = JSON.parse(read(locale).replace(/^\uFEFF/, ''));
    if (!data?.meta?.title || !data?.meta?.description) problems.push(`${locale}: missing meta.title/description`);
  } catch (error) {
    problems.push(`${locale}: ${error.message}`);
  }
}

const icon = path.join(root, manifest?.icon || 'icon.svg');
if (fs.existsSync(icon) && fs.statSync(icon).size > 256 * 1024) problems.push('icon exceeds 256 KiB');

const client = read('client.js');
if (!client.includes("window.__ModuleLoader__.load")) problems.push('client.js does not register a module loader factory');

if (problems.length) {
  console.error('manifest check failed:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log(`manifest OK: ${manifest.name}@${manifest.version}`);
