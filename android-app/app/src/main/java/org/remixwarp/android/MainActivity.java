package org.remixwarp.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

/**
 * 离线编辑器外壳：用 WebView 加载打包进 APK 的网页产物，
 * 并把桌面版 Electron 里由主进程处理的自定义协议（扩展库 / 素材库）
 * 拦截到本地 assets。
 */
public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL =
            "https://" + APP_HOST + "/assets/www/editor/gui/gui.html";
    private static final int FILE_CHOOSER_REQUEST = 1;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#333333"));
        setContentView(root);

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new LocalAssetClient());
        webView.setWebChromeClient(new ChromeClient());
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private class LocalAssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String host = uri.getHost();
            if (host == null) {
                return null;
            }
            String path = uri.getPath();
            if (path == null) {
                path = "/";
            }

            String assetPath = null;
            if (APP_HOST.equals(host)) {
                if (path.startsWith("/assets/www/")) {
                    assetPath = path.substring("/assets/www/".length());
                } else {
                    // scratch-gui 里写死成根路径的资源（/monaco-editor-iframe.html 等）
                    assetPath = "editor" + path;
                }
            } else if ("extensions.turbowarp.org".equals(host)) {
                assetPath = "extensions" + path;
            } else if ("editors.astras.top".equals(host) && path.startsWith("/extensions")) {
                assetPath = "astra" + path.substring("/extensions".length());
            } else if ("extensions.mistium.com".equals(host)) {
                assetPath = "mw" + path;
            } else if ("sharkpools-extensions.vercel.app".equals(host)) {
                assetPath = "sp" + path;
            } else if ("cdn.assets.scratch.mit.edu".equals(host) || "assets.scratch.mit.edu".equals(host)) {
                String name = path.substring(path.lastIndexOf('/') + 1);
                assetPath = "library/" + name;
            }

            if (assetPath == null) {
                return null;
            }
            return openAsset(assetPath);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) {
                String host = uri.getHost();
                if (host != null && (host.endsWith("remixwarp.org") || host.endsWith("remixwarp.com"))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                        return true;
                    } catch (Exception ignored) {
                        return false;
                    }
                }
            }
            return false;
        }
    }

    private WebResourceResponse openAsset(String assetPath) {
        String decoded;
        try {
            decoded = URLDecoder.decode(assetPath, "UTF-8");
        } catch (Exception e) {
            decoded = assetPath;
        }
        // 防止 ../ 之类的路径穿越
        if (decoded.contains("..")) {
            return null;
        }
        try {
            InputStream stream = getAssets().open("www/" + decoded);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "public, max-age=31536000");
            return new WebResourceResponse(mimeType(decoded), "utf-8", 200, "OK", headers, stream);
        } catch (IOException e) {
            return null;
        }
    }

    private static String mimeType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico") || lower.endsWith(".cur")) return "image/x-icon";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".otf")) return "font/otf";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".xml")) return "text/xml";
        if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    private class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            try {
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, FILE_CHOOSER_REQUEST);
            } catch (Exception e) {
                filePathCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            request.grant(request.getResources());
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                      android.os.Message resultMsg) {
            // 桌面版会用 window.open 打开设置 / 关于 / 插件设置等窗口，
            // 这里用一个小弹窗里的 WebView 承接。
            final WebView popup = new WebView(MainActivity.this);
            popup.getSettings().setJavaScriptEnabled(true);
            popup.getSettings().setDomStorageEnabled(true);
            popup.setWebViewClient(new WebViewClient());

            final AlertDialog dialog = new AlertDialog.Builder(MainActivity.this)
                    .setView(popup)
                    .create();
            dialog.setOnDismissListener(d -> popup.destroy());
            dialog.show();

            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 供兼容层调用的原生能力 */
    public class Bridge {
        @JavascriptInterface
        public String getVersion() {
            return BuildConfig.VERSION_NAME;
        }

        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String base64) {
            new Thread(() -> {
                try {
                    byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                    String location = writeToDownloads(name, mime, bytes);
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "已保存到 " + location, Toast.LENGTH_LONG).show());
                } catch (final Exception e) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
                }
            }).start();
        }

        @JavascriptInterface
        public void setFullScreen(final boolean fullScreen) {
            runOnUiThread(() -> {
                if (fullScreen) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                }
            });
        }

        @JavascriptInterface
        public void toast(final String message) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }

    private String writeToDownloads(String name, String mime, byte[] bytes) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("无法创建下载文件");
            }
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    throw new IOException("无法写入下载文件");
                }
                out.write(bytes);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, values, null, null);
            return "下载/" + name;
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IOException("无法创建下载目录");
            }
            File file = new File(dir, name);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            MediaScannerConnection.scanFile(this,
                    new String[]{file.getAbsolutePath()}, new String[]{mime}, null);
            return file.getAbsolutePath();
        }
    }
}
