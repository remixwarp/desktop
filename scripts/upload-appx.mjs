import * as fsPromises from 'node:fs/promises';
import * as pathUtil from 'node:path';
import { spawnSync } from 'node:child_process';

const TOKEN = process.env.GH_TOKEN;
const OWNER = process.argv[2] || 'remixwarp';
const REPO = process.argv[3] || 'desktop';
const TAG = process.argv[4] || 'v1.0.5';
const ARTIFACT_IDS = {
  x64:   process.argv[5] || '9604108132',
  ia32:  process.argv[6] || '9604154430',
  arm64: process.argv[7] || '9604189421',
};

if (!TOKEN) { console.error('Need GH_TOKEN'); process.exit(1); }

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${TOKEN}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

const getContentType = (file) => {
  file = file.toLowerCase();
  if (file.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (file.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (file.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  if (file.endsWith('.appimage')) return 'application/vnd.appimage';
  if (file.endsWith('.tar.gz')) return 'application/gzip';
  if (file.endsWith('.appx')) return 'application/appx';
  return 'application/octet-stream';
};

async function downloadArtifact(id, destDir) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${id}/zip`;
  process.stderr.write(`Downloading artifact ${id} ...\n`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${id}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = pathUtil.join(destDir, `${id}.zip`);
  await fsPromises.writeFile(zipPath, buf);
  process.stderr.write(`Wrote ${zipPath} (${buf.length} bytes). Extracting...\n`);
  const r = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`unzip failed status=${r.status}`);
  return destDir;
}

async function getReleaseId(tag) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} getting release`);
  const j = await res.json();
  return j.id;
}

async function uploadAsset(releaseId, filePath) {
  const name = pathUtil.basename(filePath);
  const data = await fsPromises.readFile(filePath);
  process.stderr.write(`Uploading ${name} (${data.length} bytes)...\n`);
  const upUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(upUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': String(data.byteLength),
      'Content-Type': getContentType(name),
    },
    body: data,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} uploading ${name}: ${txt}`);
  }
  const j = await res.json();
  process.stderr.write(`OK -> ${j.browser_download_url}\n`);
  return j;
}

(async () => {
  const releaseId = await getReleaseId(TAG);
  console.log(`Release ID: ${releaseId}`);

  const base = '/tmp/appx';
  await fsPromises.mkdir(base, { recursive: true });

  for (const [arch, id] of Object.entries(ARTIFACT_IDS)) {
    await downloadArtifact(id, base);
  }

  const entries = await fsPromises.readdir(base);
  const appxFiles = entries
    .filter(f => f.toLowerCase().endsWith('.appx'))
    .map(f => pathUtil.join(base, f));
  process.stderr.write(`Found appx files: ${appxFiles.map(f => pathUtil.basename(f)).join(', ')}\n`);

  for (const f of appxFiles) {
    await uploadAsset(releaseId, f);
  }
  process.stderr.write('All done.\n');
})().catch(err => { console.error(err); process.exit(1); });
