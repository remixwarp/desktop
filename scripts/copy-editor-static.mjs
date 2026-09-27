// 把 scratch-gui 中以根路径（"/xxx.html"）引用的静态页面复制到 tw-editor 协议
// 的根目录 dist-renderer-webpack/editor/。
//
// 背景：桌面端编辑器页面通过自定义协议 tw-editor:// 加载（root =
// dist-renderer-webpack/editor）。页面上形如 src="/monaco-editor-iframe.html"
// 的根相对 URL 会被解析成 tw-editor://./monaco-editor-iframe.html，协议处理器
// 随即去读 dist-renderer-webpack/editor/monaco-editor-iframe.html。
// 网页端不会出现这个问题，因为 scratch-gui 的 webpack 会把 static/ 整个复制到
// 构建根目录；而桌面端只打包自己 dist-renderer-webpack 里的产物，缺少这些文件
// 就会弹出 "Protocol handler error ... ENOENT"。
//
// 新增需要以根路径引用的页面时，把文件名加进 ROOT_PAGES 即可。
import fs from 'fs';
import path from 'path';
import url from 'url';

const ROOT_PAGES = [
    'monaco-editor-iframe.html'
];

// Monaco 编辑器的 AMD 运行时，会被复制成
// dist-renderer-webpack/editor/monaco/vs（对应 tw-editor://./monaco/vs）。
const MONACO_DIRECTORY = path.join('node_modules', 'monaco-editor', 'min', 'vs');
const MONACO_TARGET_NAME = path.join('monaco', 'vs');

const desktopRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// scratch-gui 的 static 目录来源：优先 node_modules（构建环境已 npm install），
// 回退到工作区同级目录（尚未 npm install scratch-gui 时也能从源码取到页面）。
const STATIC_CANDIDATES = [
    path.join(desktopRoot, 'node_modules', 'scratch-gui', 'static'),
    path.join(desktopRoot, '..', 'scratch-gui', 'static')
];
const sourceDirectory = STATIC_CANDIDATES.find(candidate => fs.existsSync(candidate));
const targetDirectory = path.join(desktopRoot, 'dist-renderer-webpack', 'editor');

if (!sourceDirectory) {
    console.warn('[copy-editor-static] 未找到 scratch-gui 的 static 目录，跳过（请先 npm install 或确认工作区同级存在 scratch-gui）');
    process.exit(0);
}
console.log(`[copy-editor-static] 使用来源目录：${sourceDirectory}`);

fs.mkdirSync(targetDirectory, {recursive: true});

for (const file of ROOT_PAGES) {
    const from = path.join(sourceDirectory, file);
    const to = path.join(targetDirectory, file);
    if (!fs.existsSync(from)) {
        console.warn(`[copy-editor-static] 缺少 ${from}，跳过`);
        continue;
    }
    fs.copyFileSync(from, to);
    console.log(`[copy-editor-static] ${file} -> dist-renderer-webpack/editor/`);
}

// monaco-editor 可能在桌面端根目录，也可能装在 scratch-gui 的 node_modules 里
//（node_modules/scratch-gui 或工作区同级 scratch-gui）。
const monacoCandidates = [
    path.join(desktopRoot, MONACO_DIRECTORY),
    path.join(desktopRoot, 'node_modules', 'scratch-gui', MONACO_DIRECTORY),
    path.join(desktopRoot, '..', 'scratch-gui', 'node_modules', 'monaco-editor', 'min', 'vs')
];
const monacoSource = monacoCandidates.find(candidate => fs.existsSync(candidate));

if (!monacoSource) {
    console.warn('[copy-editor-static] 未找到 monaco-editor/min/vs，Monaco 编辑器将回退到 CDN');
} else {
    const monacoTarget = path.join(targetDirectory, MONACO_TARGET_NAME);
    fs.rmSync(monacoTarget, {recursive: true, force: true});
    fs.cpSync(monacoSource, monacoTarget, {recursive: true});
    console.log('[copy-editor-static] monaco-editor/min/vs -> dist-renderer-webpack/editor/monaco/vs');
}
