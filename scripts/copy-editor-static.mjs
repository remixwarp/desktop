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

const desktopRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(desktopRoot, 'node_modules', 'scratch-gui', 'static');
const targetDirectory = path.join(desktopRoot, 'dist-renderer-webpack', 'editor');

if (!fs.existsSync(sourceDirectory)) {
    console.warn(`[copy-editor-static] 未找到 ${sourceDirectory}，跳过（请先 npm install）`);
    process.exit(0);
}

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
