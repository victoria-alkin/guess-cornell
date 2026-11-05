// Upload panoramas in panos/ to the Cloudflare R2 bucket.
//
//   npx wrangler login        (once, opens a browser)
//   npm run upload
//
// Files already uploaded (listed in panos/.uploaded.json) are skipped. Photo
// names are content hashes, so a changed photo gets a new name and is uploaded
// fresh; that's why browsers may cache them forever.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BUCKET = process.env.R2_BUCKET || 'guess-cornell-photos';
const DIR = 'panos';
const LOG = `${DIR}/.uploaded.json`;

const uploaded = new Set(existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : []);
const todo = readdirSync(DIR).filter((f) => /^[0-9a-f]+\.jpg$/.test(f) && !uploaded.has(f));

if (todo.length === 0) {
  console.log(`Nothing to upload. ${uploaded.size} photo(s) already in ${BUCKET}.`);
  process.exit(0);
}

console.log(`Uploading ${todo.length} photo(s) to R2 bucket "${BUCKET}"…`);
for (const file of todo) {
  console.log(`  ${file}`);
  // Filenames are hex hashes, so building the command string is safe.
  execSync(
    `npx --yes wrangler r2 object put "${BUCKET}/${file}" --file "${DIR}/${file}" ` +
      `--content-type image/jpeg --cache-control "public,max-age=31536000,immutable" --remote`,
    { stdio: 'inherit' },
  );
  uploaded.add(file);
  writeFileSync(LOG, JSON.stringify([...uploaded].sort(), null, 2) + '\n');
}
console.log('Done.');
