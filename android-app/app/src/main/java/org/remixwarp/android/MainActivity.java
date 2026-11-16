package org.remixwarp.android;

import android.app.Activity;
import android.app.Dialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
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
import android.widget.LinearLayout;
import android.widget.TextView;
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
        // 和 Scratch 安卓端一样强制横屏
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        enterFullscreen();

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
        // 页面按桌面宽度排版后整体缩小显示，尽量一屏看到完整编辑器
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);

        webView.setWebViewClient(new LocalAssetClient());
        webView.setWebChromeClient(new ChromeClient());
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.loadUrl(START_URL);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 从后台返回或弹窗关闭后重新隐藏系统栏，保持全屏
        if (hasFocus) {
            enterFullscreen();
        }
    }

    /** 隐藏状态栏和导航栏，让编辑器占满整个屏幕 */
    private void enterFullscreen() {
        Window window = getWindow();
        window.setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
        }
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
            // 桌面版用 window.open 打开设置 / 关于 / 插件设置等自由窗口。
            // AlertDialog 会按内容包裹，WebView 没被测量出尺寸时只剩一条灰色长条，
            // 所以这里显式让弹窗和 WebView 铺满屏幕。
            final WebView popup = new WebView(MainActivity.this);
            WebSettings popupSettings = popup.getSettings();
            popupSettings.setJavaScriptEnabled(true);
            popupSettings.setDomStorageEnabled(true);
            popupSettings.setMediaPlaybackRequiresUserGesture(false);
            popupSettings.setSupportMultipleWindows(false);
            popupSettings.setUseWideViewPort(true);
            popupSettings.setLoadWithOverviewMode(true);
            popupSettings.setSupportZoom(true);
            popup.setWebViewClient(new LocalAssetClient());
            popup.setWebChromeClient(new ChromeClient());

            final LinearLayout container = new LinearLayout(MainActivity.this);
            container.setOrientation(LinearLayout.VERTICAL);
            container.setBackgroundColor(Color.WHITE);

            // 窗口标题栏：和桌面端自由窗口一样带最小化 / 最大化 / 关闭三个按钮
            final LinearLayout header = new LinearLayout(MainActivity.this);
            header.setOrientation(LinearLayout.HORIZONTAL);
            header.setGravity(Gravity.CENTER_VERTICAL);
            header.setBackgroundColor(Color.parseColor("#F1F3F5"));
            header.setPadding(dp(16), 0, dp(8), 0);

            final TextView title = new TextView(MainActivity.this);
            title.setText("RemixWarp");
            title.setTextSize(14);
            title.setTextColor(Color.parseColor("#2D3748"));
            title.setSingleLine(true);
            header.addView(title, new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

            final TextView minimizeButton = createWindowButton("—");
            final TextView maximizeButton = createWindowButton("☐");
            final TextView closeButton = createWindowButton("✕");
            header.addView(minimizeButton);
            header.addView(maximizeButton);
            header.addView(closeButton);

            container.addView(header, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));
            container.addView(popup, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

            final Dialog dialog = new Dialog(MainActivity.this,
                    android.R.style.Theme_DeviceDefault_NoActionBar);
            dialog.setContentView(container);
            dialog.setOnDismissListener(d -> popup.destroy());

            final android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
            final int normalWidth = Math.round(metrics.widthPixels * 0.88f);
            final int normalHeight = Math.round(metrics.heightPixels * 0.82f);
            final boolean[] maximized = {false};
            final boolean[] minimized = {false};

            minimizeButton.setOnClickListener(v -> {
                minimized[0] = true;
                popup.setVisibility(View.GONE);
                Window window = dialog.getWindow();
                if (window != null) {
                    WindowManager.LayoutParams params = window.getAttributes();
                    params.x = dp(16);
                    params.y = dp(16);
                    window.setAttributes(params);
                    window.setGravity(Gravity.BOTTOM | Gravity.START);
                    window.setLayout(dp(240), dp(44));
                }
            });
            maximizeButton.setOnClickListener(v -> {
                if (minimized[0]) return;
                maximized[0] = !maximized[0];
                maximizeButton.setText(maximized[0] ? "❐" : "☐");
                Window window = dialog.getWindow();
                if (window != null) {
                    window.setLayout(
                            maximized[0] ? metrics.widthPixels : normalWidth,
                            maximized[0] ? metrics.heightPixels : normalHeight);
                }
            });
            closeButton.setOnClickListener(v -> dialog.dismiss());
            // 最小化后点击标题栏还原
            title.setOnClickListener(v -> {
                if (!minimized[0]) return;
                minimized[0] = false;
                popup.setVisibility(View.VISIBLE);
                Window window = dialog.getWindow();
                if (window != null) {
                    WindowManager.LayoutParams params = window.getAttributes();
                    params.x = 0;
                    params.y = 0;
                    window.setAttributes(params);
                    window.setGravity(Gravity.CENTER);
                    window.setLayout(maximized[0] ? metrics.widthPixels : normalWidth,
                            maximized[0] ? metrics.heightPixels : normalHeight);
                }
            });

            dialog.show();

            Window window = dialog.getWindow();
            if (window != null) {
                // 以桌面端自由窗口的样子浮动在编辑器上方，而不是铺满整个屏幕
                window.setLayout(normalWidth, normalHeight);
                window.setGravity(Gravity.CENTER);
                window.setBackgroundDrawableResource(android.R.color.transparent);
            }

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

    /** 自由窗口标题栏上 44dp 高的图标按钮 */
    private TextView createWindowButton(String label) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setTextSize(16);
        button.setTextColor(Color.parseColor("#2D3748"));
        button.setGravity(Gravity.CENTER);
        button.setClickable(true);
        button.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(44), dp(44));
        params.setMargins(dp(2), 0, dp(2), 0);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(float value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
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
