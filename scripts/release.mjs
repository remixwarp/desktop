/**
 * release.mjs — 本地仓库版本发布核心逻辑。
 *
 * 作用：根据给定版本号与发布说明，更新 docs/index.html / docs/version.json /
 * package.json 三个文件，重建 .trae-html-share-packages/docs/index.html.zip，
 * 然后对这些文件执行 git add。**不会 commit、不会 push、不会打 tag**，
 * 这三个操作由用户在确认无误后手动完成。
 *
 * 调用方式：
 *   import { applyRelease } from './scripts/release.mjs';
 *   const result = await applyRelease({ version: '1.2.0', body: '修复了一部分已知bug' });
 *
 * 返回：{ prev, version, changed: [路径], added: [路径], steps: [手动命令提示] }
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** 中文日期 YYYY 年 M 月 D 日 */
function cnDate(date = new Date()) {
    return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/**
 * @param {string} v  e.g. "1.1.1"
 * @returns {string}  e.g. "v1.1.1"
 */
function tagOf(v) {
    return v.startsWith('v') ? v : `v${v}`;
}

/**
 * 读/写 JSON
 */
async function readJSON(rel) {
    const buf = await readFile(join(ROOT, rel), 'utf8');
    return JSON.parse(buf);
}
async function writeJSON(rel, obj) {
    await writeFile(join(ROOT, rel), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * 从 docs/index.html 提取当前 activeVersion（作为 prev）
 */
function extractPrevVersion(html) {
    const m = html.match(/var\s+activeVersion\s*=\s*'([^']+)';/);
    if (!m) throw new Error('无法从 docs/index.html 中解析 activeVersion');
    return m[1];
}

/**
 * 改 docs/index.html —— 推进版本、插入 changelog、写 RELEASES/VERSIONS、改 GitHub 发布链接
 */
async function patchIndexHtml(newVersion, prevVersion, bodyLines, cnDateStr) {
    const path = join(ROOT, 'docs/index.html');
    let t = await readFile(path, 'utf8');

    const vt = tagOf(newVersion);
    const pt = tagOf(prevVersion);
    const ver = newVersion;

    // 当前版本徽章
    t = t.replace(new RegExp(`当前版本：${prevVersion.replace('.', '\\.').replace(/^v/, '')}`),
                  `当前版本：${vt}`);
    // 安全一点的写法：按精确 pt
    t = t.replace(`当前版本：${pt}`, `当前版本：${vt}`);

    // GitHub 发布链接
    t = t.replace(`releases/tag/${pt}`, `releases/tag/${vt}`);

    // changelog：把旧的"当前版本"徽章去掉
    t = t.replace(
        new RegExp(prevVersion + '（[^）]+）<span class="changelog-badge">当前版本</span>'),
        (m) => m.replace('<span class="changelog-badge">当前版本</span>', '').trim()
    );

    // 在第一个 changelog-version h3 之前插入新版本条目
    const bulletBody = bodyLines.map(b => `          <li>${b}</li>`).join('\n');
    const block = `        <h3 class="changelog-version" data-version="${ver}" role="button" tabindex="0">
          ${vt}（${cnDateStr}）<span class="changelog-badge">当前版本</span>
        </h3>
        <ul>
${bulletBody}
        </ul>
`;
    t = t.replace(
        /      <div lang="zh-CN">\n        <h3 class="changelog-version" data-version="\d+\.\d+\.\d+"/,
        (m) => m.replace(/(<h3 class="changelog-version")/, block + '        <h3 class="changelog-version"')
    );

    // RELEASES
    const releaseBlock = `      '${ver}': {
        win: 'RemixWarp-Setup-${ver}-x64.exe',
        mac: 'RemixWarp-Setup-modern-${vt}.dmg',
        deb: 'RemixWarp-linux-amd64-${ver}.deb',
        appimage: 'RemixWarp-linux-x86_64-${ver}.AppImage',
        targz: 'RemixWarp-linux-x64-${ver}.tar.gz',
        appx64: 'RemixWarp-MS-Store-${ver}-x64.appx',
        appxia32: 'RemixWarp-MS-Store-${ver}-ia32.appx',
        appxarm64: 'RemixWarp-MS-Store-${ver}-arm64.appx'
      },
`;
    // 找到现有 RELEASES 第一个 key 的位置，在它之前插入
    t = t.replace(
        /(var RELEASES = \{\n)      '\d+\.\d+\.\d+': \{/,
        `$1${releaseBlock}      '${prevVersion}': {`
    );

    // VERSIONS
    t = t.replace(
        new RegExp(`\\{ version: '${prevVersion}', label: '最新版 ${pt}' \\},`),
        `{ version: '${ver}', label: '最新版 ${vt}' },\n      { version: '${prevVersion}', label: '旧版 ${pt}' },`
    );

    // activeVersion
    t = t.replace(
        new RegExp(`var activeVersion = '${prevVersion}';`),
        `var activeVersion = '${ver}';`
    );

    await writeFile(path, t, 'utf8');
}

/**
 * 重建 .trae-html-share-packages/docs/index.html.zip
 * 把 docs/ 整个目录直接打包进去（zip 里路径以 docs/ 为前缀）。
 * 用 Node 原生 Zlib + 手写 DEFLATE ZIP（不引入第三方库），满足项目已有的 zip 格式。
 */
async function rebuildDocsZip() {
    const zipPath = join(ROOT, '.trae-html-share-packages/docs/index.html.zip');
    const docsDir = join(ROOT, 'docs');
    if (!existsSync(docsDir)) return;

    // 收集所有文件
    const files = [];
    async function walk(dir) {
        const entries = await readFile(dir, 'utf8').then(() => null).catch(() => null);
        // 用 fs 模块
        const { readdir, stat } = await import('node:fs/promises');
        const ents = await readdir(dir, { withFileTypes: true });
        for (const e of ents) {
            const full = join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else files.push({ full, rel: 'docs/' + relative(docsDir, full) });
        }
    }
    // 上面 walk 没真引用 entries；重写
    files.length = 0;
    await walkReal(docsDir, 'docs', files);

    const outFD = await open(zipPath, 'w');
    const chunks = [];
    const offsets = [];

    // 先写入所有 local file headers + 压缩后的 data
    for (const f of files) {
        const data = await readFile(f.full);
        const compressed = zlib.deflateSync(data, { level: 6 });
        const crc = crc32(data);
        offsets.push(chunks.length);
        chunks.push(makeLocalFileHeader(f.rel, data.length, compressed.length, crc));
        chunks.push(compressed);
    }

    // central directory
    const cdStart = chunks.reduce((s, c) => s + c.length, 0);
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const data = await readFile(f.full);
        const compressed = zlib.deflateSync(data, { level: 6 });
        const crc = crc32(data);
        chunks.push(makeCentralDirEntry(f.rel, data.length, compressed.length, crc, offsets[i]));
    }
    const cdEnd = chunks.reduce((s, c) => s + c.length, 0);
    chunks.push(makeEndOfCentralDir(files.length, cdStart, cdEnd - cdStart));

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const buf = Buffer.concat(chunks, total);
    await writeFile(zipPath, buf);
}

// ——— ZIP 工具 ———
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function strBuf(s) { return Buffer.from(s, 'utf8'); }
function makeLocalFileHeader(name, size, csize, crc) {
    const nb = strBuf(name);
    const b = Buffer.alloc(30 + nb.length);
    b.writeUInt32LE(0x04034b50, 0);
    b.writeUInt16LE(20, 4);
    b.writeUInt16LE(0, 6);          // flags
    b.writeUInt16LE(8, 8);          // method = DEFLATE
    b.writeUInt16LE(0, 10); b.writeUInt16LE(0, 12);
    b.writeUInt32LE(crc, 14);
    b.writeUInt32LE(csize, 18);
    b.writeUInt32LE(size, 22);
    b.writeUInt16LE(nb.length, 26);
    b.writeUInt16LE(0, 28);
    nb.copy(b, 30);
    return b;
}
function makeCentralDirEntry(name, size, csize, crc, localOffset) {
    const nb = strBuf(name);
    const b = Buffer.alloc(46 + nb.length);
    b.writeUInt32LE(0x02014b50, 0);
    b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6);
    b.writeUInt16LE(0, 8); b.writeUInt16LE(8, 10); // DEFLATE
    b.writeUInt16LE(0, 12); b.writeUInt16LE(0, 14);
    b.writeUInt32LE(crc, 16);
    b.writeUInt32LE(csize, 20);
    b.writeUInt32LE(size, 24);
    b.writeUInt16LE(nb.length, 28);
    b.writeUInt16LE(0, 30); b.writeUInt16LE(0, 32); b.writeUInt16LE(0, 34); b.writeUInt16LE(0, 36);
    b.writeUInt32LE(localOffset, 38);
    nb.copy(b, 46);
    return b;
}
function makeEndOfCentralDir(count, cdStart, cdSize) {
    const b = Buffer.alloc(22);
    b.writeUInt32LE(0x06054b50, 0);
    b.writeUInt16LE(0, 4); b.writeUInt16LE(0, 6);
    b.writeUInt16LE(count, 8); b.writeUInt16LE(count, 10);
    b.writeUInt32LE(cdSize, 12);
    b.writeUInt32LE(cdStart, 16);
    b.writeUInt16LE(0, 20);
    return b;
}

/** 带 node:fs 的 walk */
async function walkReal(dir, prefix, out) {
    const { readdir, stat } = await import('node:fs/promises');
    const ents = await readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walkReal(full, join(prefix, e.name), out);
        else out.push({ full, rel: join(prefix, e.name).replace(/\\/g, '/') });
    }
}

/**
 * 主入口：应用版本发布到本地仓库。
 * @param {{version: string, body?: string|string[]}} opts
 * @returns {Promise<{prev: string, version: string, changed: string[], added: string[]}>}
 */
export async function applyRelease(opts) {
    const { version, body = '修复了一部分已知 bug' } = opts;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`版本号格式错误，应为 x.y.z（你给的是 "${version}"）`);
    }

    const bodyLines = Array.isArray(body)
        ? body.filter(Boolean)
        : String(body).split('\n').map(s => s.trim()).filter(Boolean);
    if (bodyLines.length === 0) bodyLines.push('修复了一部分已知 bug');

    const indexPath = join(ROOT, 'docs/index.html');
    const prevHtml = await readFile(indexPath, 'utf8');
    const prev = extractPrevVersion(prevHtml);

    // 1. docs/index.html
    await patchIndexHtml(version, prev, bodyLines, cnDate());
    // 2. docs/version.json
    const vj = await readJSON('docs/version.json');
    vj.latest = vj.latest_unstable = version;
    await writeJSON('docs/version.json', vj);
    // 3. package.json
    const pj = await readJSON('package.json');
    pj.version = version;
    await writeJSON('package.json', pj);
    // 4. 重建 zip
    await rebuildDocsZip();

    const changed = [
        'docs/index.html',
        'docs/version.json',
        'package.json',
        '.trae-html-share-packages/docs/index.html.zip'
    ];

    // git add 这些文件
    execFileSync('git', ['add', ...changed], { cwd: ROOT, stdio: 'pipe' });

    return { prev, version, tag: tagOf(version), changed, added: changed };
}

// CLI 入口：node scripts/release.mjs <version> [body...]
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
    const args = process.argv.slice(2);
    const version = args.shift();
    const body = args.join(' ');
    applyRelease({ version, body })
        .then(r => {
            console.log(`✅ 已应用版本 ${r.tag}（上一版：${tagOf(r.prev)}）`);
            console.log('已暂存的文件：');
            r.added.forEach(f => console.log('  +', f));
            console.log('');
            console.log('接下来请手动执行：');
            console.log(`  git commit -m "feat: 添加 ${r.tag}"`);
            console.log(`  git tag ${r.tag}`);
            console.log(`  git push --force origin main`);
            console.log(`  git push origin ${r.tag}`);
        })
        .catch(err => { console.error('❌', err.message); process.exit(1); });
}
