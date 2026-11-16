// 把桌面端的渲染产物整理成 Android WebView 可以直接加载的离线目录。
//
// 结构（android-app/app/src/main/assets/www/）：
//   editor/       dist-renderer-webpack/editor（编辑器 GUI、addons、settings、monaco）
//   library/      dist-library-files（素材库，构建产物是 brotli，这里解压成原始文件）
//   extensions/   dist-extensions（TurboWarp 扩展库）
//   astra/ mw/ sp/ bilup/  其它扩展库
//   about/ privacy/ packager/  桌面版用自定义协议打开的子页面
//   l10n/         桌面主进程的翻译表，供兼容层实现 setLocale
//
// 用法：node scripts/build-android-web.mjs [--version x.y.z]
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'android-app', 'app', 'src', 'main', 'assets', 'www');

const args = process.argv.slice(2);
const versionIndex = args.indexOf('--version');
const version = versionIndex === -1 ? '0.0.0' : args[versionIndex + 1];

const copyTree = (from, to) => {
    if (!fs.existsSync(from)) {
        throw new Error(`缺少构建产物：${path.relative(root, from)}`);
    }
    fs.cpSync(from, to, {recursive: true});
};

/**
 * 递归复制目录，并把 brotli 压缩（.br）的文件还原成原始文件。
 */
const copyTreeDecompressed = (from, to) => {
    if (!fs.existsSync(from)) {
        console.warn(`[android] 跳过不存在的目录：${path.relative(root, from)}`);
        return;
    }
    const walk = (source, target) => {
        fs.mkdirSync(target, {recursive: true});
        for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
            const sourcePath = path.join(source, entry.name);
            if (entry.isDirectory()) {
                walk(sourcePath, path.join(target, entry.name));
                continue;
            }
            if (entry.name.endsWith('.br')) {
                const targetPath = path.join(target, entry.name.slice(0, -3));
                fs.writeFileSync(targetPath, zlib.brotliDecompressSync(fs.readFileSync(sourcePath)));
            } else {
                fs.copyFileSync(sourcePath, path.join(target, entry.name));
            }
        }
    };
    walk(from, to);
};

const patchGuiHTML = (file, configFile, shimFile) => {
    let html = fs.readFileSync(file, 'utf-8');
    // 让编辑器按桌面端宽度（1200px）排版，再由 WebView 整体缩放适配屏幕，
    // 这样手机上看到的是和 Scratch 安卓端一样完整缩小后的界面。
    html = html.replace(
        /<meta name="viewport"[^>]*>/,
        '<meta name="viewport" content="width=1200, initial-scale=1, maximum-scale=5, user-scalable=yes">'
    );
    if (html.includes(shimFile)) {
        fs.writeFileSync(file, html);
        return;
    }
    const tag = `<script src="${configFile}"></script>\n    <script src="${shimFile}"></script>\n    `;
    if (html.includes('<script src="index.js"')) {
        html = html.replace('<script src="index.js"', `${tag}<script src="index.js"`);
    } else {
        html = html.replace('</body>', `${tag}</body>`);
    }
    fs.writeFileSync(file, html);
};

fs.rmSync(output, {recursive: true, force: true});
fs.mkdirSync(output, {recursive: true});

// 1. 编辑器主体
copyTree(
    path.join(root, 'dist-renderer-webpack', 'editor'),
    path.join(output, 'editor')
);

// 2. 素材库与扩展库（brotli -> 原始文件）
copyTreeDecompressed(path.join(root, 'dist-library-files'), path.join(output, 'library'));
copyTreeDecompressed(path.join(root, 'dist-extensions'), path.join(output, 'extensions'));
copyTreeDecompressed(path.join(root, 'dist-bilup-extensions'), path.join(output, 'bilup'));
copyTreeDecompressed(path.join(root, 'dist-astra-extensions'), path.join(output, 'astra'));
copyTreeDecompressed(path.join(root, 'dist-mw-extensions'), path.join(output, 'mw'));
copyTreeDecompressed(path.join(root, 'dist-sp-extensions'), path.join(output, 'sp'));

// 3. 桌面版用自定义协议打开的子页面
copyTree(path.join(root, 'src-renderer', 'about'), path.join(output, 'about'));
copyTree(path.join(root, 'src-renderer', 'privacy'), path.join(output, 'privacy'));
copyTree(path.join(root, 'src-renderer', 'packager'), path.join(output, 'packager'));

// 4. 翻译表
const l10nOutput = path.join(output, 'l10n');
fs.mkdirSync(l10nOutput, {recursive: true});
for (const file of ['en.json', 'generated-translations.json']) {
    fs.copyFileSync(path.join(root, 'src-main', 'l10n', file), path.join(l10nOutput, file));
}

// 5. 兼容层 + 运行时版本信息
const guiDirectory = path.join(output, 'editor', 'gui');
fs.writeFileSync(
    path.join(guiDirectory, 'rw-android-config.js'),
    `window.__RW_ANDROID__ = ${JSON.stringify({version})};\n`
);
fs.copyFileSync(
    path.join(root, 'src-android', 'preload-shim.js'),
    path.join(guiDirectory, 'preload-shim.js')
);
patchGuiHTML(path.join(guiDirectory, 'gui.html'), 'rw-android-config.js', 'preload-shim.js');

fs.writeFileSync(
    path.join(output, 'version.json'),
    `${JSON.stringify({version, platform: 'android'}, null, 2)}\n`
);

// 6. 应用图标
const iconSource = path.join(root, 'art', 'icon.png');
const iconTarget = path.join(
    root, 'android-app', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'
);
if (fs.existsSync(iconSource)) {
    fs.mkdirSync(path.dirname(iconTarget), {recursive: true});
    fs.copyFileSync(iconSource, iconTarget);
}

const size = (directory) => {
    let total = 0;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const entryPath = path.join(directory, entry.name);
        total += entry.isDirectory() ? size(entryPath) : fs.statSync(entryPath).size;
    }
    return total;
};

console.log(`[android] 离线资源已生成：${path.relative(root, output)}（${(size(output) / 1024 / 1024).toFixed(1)} MB）`);
