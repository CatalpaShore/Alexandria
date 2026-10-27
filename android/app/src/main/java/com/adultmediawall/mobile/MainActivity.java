package org.alexandria.publicmediawall;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcel;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String PREFS = "media_wall_mobile";
    private static final String PREF_BASE_URL = "nas_base_url";
    private static final int DISCOVERY_PORT = 5179;
    private static final int DISCOVERY_WORKERS = 32;
    private static final String STATE_WEBVIEW = "webview";
    private static final String STATE_URL = "page_url";
    private static final String STATE_BASE_URL = "page_base_url";

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean discoveryRunning = new AtomicBoolean(false);
    private FrameLayout root;
    private FrameLayout contentRoot;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private String baseUrl;
    private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(11, 11, 11));
        contentRoot = new FrameLayout(this);
        root.addView(contentRoot, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);
        applySystemBarInsets();
        registerBackGestureHandler();

        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        baseUrl = preferences.getString(PREF_BASE_URL, "");
        if (savedInstanceState != null && !baseUrl.isEmpty()
                && baseUrl.equals(savedInstanceState.getString(STATE_BASE_URL))) {
            showWebView(savedInstanceState);
            return;
        }
        showConnectionScreen(baseUrl.isEmpty() ? null : "正在检查上次连接并扫描局域网…");
    }

    private void showConnectionScreen(String message) {
        destroyWebView();
        contentRoot.removeAllViews();

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_HORIZONTAL);
        panel.setPadding(dp(24), dp(48), dp(24), dp(24));
        panel.setBackgroundColor(Color.rgb(245, 245, 245));

        TextView title = new TextView(this);
        title.setText(R.string.nas_address);
        title.setTextSize(24);
        title.setTextColor(Color.rgb(24, 24, 24));

        EditText address = new EditText(this);
        address.setHint(R.string.nas_address_hint);
        address.setSingleLine(true);
        address.setText(baseUrl);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);

        TextView status = new TextView(this);
        status.setText(message == null ? "正在自动扫描局域网内的 5179 服务…" : message);
        status.setTextColor(message == null ? Color.DKGRAY : Color.rgb(180, 30, 30));
        status.setPadding(0, dp(12), 0, dp(12));

        ProgressBar progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);

        Button connect = new Button(this);
        connect.setText(R.string.connect);
        connect.setOnClickListener(view -> {
            String normalized = normalizeBaseUrl(address.getText().toString());
            if (normalized == null) {
                status.setText("请输入有效的 http:// 或 https:// 地址。");
                return;
            }
            progress.setVisibility(View.VISIBLE);
            connect.setEnabled(false);
            status.setText("正在检查 /api/health ...");
            testConnection(normalized, (success, detail) -> runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || !status.isAttachedToWindow()) return;
                progress.setVisibility(View.GONE);
                connect.setEnabled(true);
                if (!success) {
                    status.setText(detail);
                    return;
                }
                baseUrl = normalized;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_BASE_URL, baseUrl).apply();
                showWebView();
            }));
        });

        panel.addView(title, matchWrap());
        panel.addView(address, matchWrap());
        panel.addView(status, matchWrap());
        panel.addView(progress, wrapWrap());
        panel.addView(connect, matchWrap());
        Button discover = new Button(this);
        discover.setText(R.string.auto_discover);
        discover.setOnClickListener(view -> startAutoDiscovery(address, status, progress, connect, discover));
        panel.addView(discover, matchWrap());
        if (!baseUrl.isEmpty()) {
            Button cancel = new Button(this);
            cancel.setText("返回媒体墙");
            cancel.setOnClickListener(view -> showWebView());
            panel.addView(cancel, matchWrap());
        }
        contentRoot.addView(panel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        startAutoDiscovery(address, status, progress, connect, discover);
    }

    private void showWebView() {
        showWebView(null);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showWebView(Bundle savedState) {
        destroyWebView();
        contentRoot.removeAllViews();
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " AdultMediaWallAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternalScheme(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showConnectionScreen("无法打开 NAS：" + error.getDescription());
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                contentRoot.setVisibility(View.GONE);
                setSystemBarsVisible(false);
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }
        });

        contentRoot.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        Bundle history = savedState == null ? null : savedState.getBundle(STATE_WEBVIEW);
        if (history != null && webView.restoreState(history) != null) return;
        String lastUrl = savedState == null ? null : savedState.getString(STATE_URL);
        webView.loadUrl(lastUrl != null && lastUrl.startsWith(baseUrl + "/") ? lastUrl : baseUrl + "/");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) {
            outState.putString(STATE_BASE_URL, baseUrl);
            outState.putString(STATE_URL, webView.getUrl());
            Bundle history = new Bundle();
            webView.saveState(history);
            Parcel parcel = Parcel.obtain();
            try {
                parcel.writeBundle(history);
                // Leave space for the framework state in Android's shared transaction limit.
                if (parcel.dataSize() < 256 * 1024) outState.putBundle(STATE_WEBVIEW, history);
            } finally {
                parcel.recycle();
            }
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    private void applySystemBarInsets() {
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets insets = windowInsets.getInsets(WindowInsets.Type.systemBars());
                left = insets.left;
                top = insets.top;
                right = insets.right;
                bottom = insets.bottom;
            } else {
                left = windowInsets.getSystemWindowInsetLeft();
                top = windowInsets.getSystemWindowInsetTop();
                right = windowInsets.getSystemWindowInsetRight();
                bottom = windowInsets.getSystemWindowInsetBottom();
            }
            contentRoot.setPadding(left, top, right, bottom);
            return windowInsets;
        });
        root.requestApplyInsets();
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsVisible(boolean visible) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            if (visible) {
                controller.show(WindowInsets.Type.systemBars());
            } else {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
            return;
        }

        getWindow().getDecorView().setSystemUiVisibility(visible
            ? View.SYSTEM_UI_FLAG_VISIBLE
            : View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    private boolean openExternalScheme(Uri uri) {
        String scheme = uri.getScheme();
        if ("mediawall".equalsIgnoreCase(scheme) && "configure-nas".equalsIgnoreCase(uri.getHost())) {
            showConnectionScreen(null);
            return true;
        }
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            return false;
        }
        if (!("vlc".equalsIgnoreCase(scheme) || "infuse".equalsIgnoreCase(scheme))) {
            Toast.makeText(this, "已阻止不受支持的链接", Toast.LENGTH_SHORT).show();
            return true;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, "未找到可打开此链接的应用", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void startAutoDiscovery(
        EditText address,
        TextView status,
        ProgressBar progress,
        Button connect,
        Button discover
    ) {
        if (!discoveryRunning.compareAndSet(false, true)) return;
        progress.setVisibility(View.VISIBLE);
        connect.setEnabled(false);
        discover.setEnabled(false);
        status.setText(baseUrl.isEmpty()
            ? "正在扫描当前 Wi-Fi 网段的 5179 端口…"
            : "正在检查上次连接，并扫描当前 Wi-Fi 网段的 5179 端口…");

        networkExecutor.execute(() -> {
            String discoveredUrl = null;
            String detail;
            try {
                if (!baseUrl.isEmpty() && isHealthy(baseUrl, 900, 1200)) {
                    discoveredUrl = baseUrl;
                    detail = "已连接上次使用的服务。";
                } else if (!hasNetwork()) {
                    detail = "当前没有可用网络，请连接服务所在 Wi-Fi。";
                } else {
                    List<String> candidates = buildDiscoveryCandidates();
                    discoveredUrl = scanCandidates(candidates);
                    detail = discoveredUrl == null
                        ? "未发现可用服务。请确认电脑已启动前后端，或手动输入 NAS 地址。"
                        : "已自动发现 " + discoveredUrl;
                }
            } catch (Exception error) {
                detail = "自动发现失败：" + error.getLocalizedMessage();
            }

            String resultUrl = discoveredUrl;
            String resultDetail = detail;
            discoveryRunning.set(false);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || status.getParent() == null
                        || !status.isAttachedToWindow()) return;
                progress.setVisibility(View.GONE);
                connect.setEnabled(true);
                discover.setEnabled(true);
                status.setText(resultDetail);
                if (resultUrl == null) return;
                address.setText(resultUrl);
                baseUrl = resultUrl;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_BASE_URL, baseUrl).apply();
                showWebView();
            });
        });
    }

    private List<String> buildDiscoveryCandidates() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network network = manager.getActiveNetwork();
        LinkProperties properties = manager.getLinkProperties(network);
        Set<String> candidates = new LinkedHashSet<>();
        if (properties == null) return new ArrayList<>();

        for (LinkAddress linkAddress : properties.getLinkAddresses()) {
            InetAddress inetAddress = linkAddress.getAddress();
            if (!(inetAddress instanceof Inet4Address) || !inetAddress.isSiteLocalAddress()) continue;
            byte[] octets = inetAddress.getAddress();
            int ownHost = octets[3] & 0xff;
            String prefix = (octets[0] & 0xff) + "." + (octets[1] & 0xff) + "." + (octets[2] & 0xff) + ".";
            for (int host = 1; host < 255; host += 1) {
                if (host == ownHost) continue;
                candidates.add("http://" + prefix + host + ":" + DISCOVERY_PORT);
            }
        }
        return new ArrayList<>(candidates);
    }

    private String scanCandidates(List<String> candidates) {
        if (candidates.isEmpty()) return null;
        ExecutorService scanner = Executors.newFixedThreadPool(Math.min(DISCOVERY_WORKERS, candidates.size()));
        CompletionService<String> completion = new ExecutorCompletionService<>(scanner);
        List<Future<String>> futures = new ArrayList<>();
        try {
            for (String candidate : candidates) {
                futures.add(completion.submit(() -> isHealthy(candidate, 400, 700) ? candidate : null));
            }
            for (int index = 0; index < candidates.size(); index += 1) {
                try {
                    String candidate = completion.take().get();
                    if (candidate == null) continue;
                    for (Future<String> future : futures) future.cancel(true);
                    return candidate;
                } catch (Exception ignored) {
                    // Continue collecting the remaining bounded probes.
                }
            }
            return null;
        } finally {
            scanner.shutdownNow();
        }
    }

    private boolean isHealthy(String candidate, int connectTimeoutMs, int readTimeoutMs) {
        return isAccessStatusEndpoint(candidate + "/api/access/status", connectTimeoutMs, readTimeoutMs)
            || isHealthyEndpoint(candidate + "/api/health/ping", connectTimeoutMs, readTimeoutMs)
            || isHealthyEndpoint(candidate + "/api/health", connectTimeoutMs, readTimeoutMs);
    }

    private boolean isAccessStatusEndpoint(String statusUrl, int connectTimeoutMs, int readTimeoutMs) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(statusUrl).openConnection();
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return false;
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.toLowerCase().contains("application/json")) return false;

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                connection.getInputStream(),
                StandardCharsets.UTF_8
            ))) {
                String line;
                while ((line = reader.readLine()) != null && body.length() < 4096) body.append(line);
            }
            JSONObject status = new JSONObject(body.toString());
            String mode = status.optString("mode", "");
            return ("local-only".equals(mode) || "lan-open".equals(mode) || "lan-protected".equals(mode))
                && status.has("requiresAuthentication")
                && status.has("authenticated");
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean isHealthyEndpoint(String healthUrl, int connectTimeoutMs, int readTimeoutMs) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(healthUrl).openConnection();
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            String contentType = connection.getContentType();
            return status >= 200 && status < 300
                && contentType != null
                && contentType.toLowerCase().contains("application/json");
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void testConnection(String candidate, ConnectionCallback callback) {
        if (!hasNetwork()) {
            callback.done(false, "当前没有可用网络，请连接 NAS 所在 Wi-Fi。");
            return;
        }
        networkExecutor.execute(() -> {
            try {
                boolean healthy = isHealthy(candidate, 5000, 5000);
                callback.done(
                    healthy,
                    healthy
                        ? "已找到 Alexandria 18+ 服务，正在直接打开…"
                        : "该地址没有返回可识别的 Alexandria 18+ 服务。"
                );
            } catch (Exception error) {
                callback.done(false, "连接失败：" + error.getLocalizedMessage());
            }
        });
    }

    private boolean hasNetwork() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network network = manager.getActiveNetwork();
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null && (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
    }

    private String normalizeBaseUrl(String raw) {
        try {
            String value = raw.trim();
            while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
            URI uri = URI.create(value);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null) {
                return null;
            }
            return value;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        contentRoot.setVisibility(View.VISIBLE);
        setSystemBarsVisible(true);
        customViewCallback.onCustomViewHidden();
        customViewCallback = null;
    }

    private void destroyWebView() {
        if (webView == null) return;
        webView.stopLoading();
        webView.destroy();
        webView = null;
    }

    private void registerBackGestureHandler() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        backInvokedCallback = this::handleBackNavigation;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            backInvokedCallback
        );
    }

    private void handleBackNavigation() {
        if (customView != null) {
            hideCustomView();
            return;
        }
        if (webView == null) {
            finish();
            return;
        }

        webView.evaluateJavascript(
            "window.__AMW_HANDLE_BACK__ ? (window.__AMW_HANDLE_BACK__() ? 'handled' : 'root') : 'unavailable'",
            result -> {
                if ("\"handled\"".equals(result)) return;
                if ("\"root\"".equals(result)) {
                    moveTaskToBack(true);
                } else if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        );
    }

    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
            backInvokedCallback = null;
        }
        destroyWebView();
        networkExecutor.shutdownNow();
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private LinearLayout.LayoutParams matchWrap() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(6), 0, dp(6));
        return params;
    }

    private LinearLayout.LayoutParams wrapWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private interface ConnectionCallback {
        void done(boolean success, String detail);
    }
}
