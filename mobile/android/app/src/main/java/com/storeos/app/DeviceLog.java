package com.storeos.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.webkit.CookieManager;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.CapConfig;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * ส่ง log จากฝั่ง native ไปที่ /api/app/device-log (ลง system_event_logs source=mobile.android)
 *
 * ทำไมต้องมี: ปัญหา "push ไม่มา / ดังครั้งเดียวไม่วน" เกิดที่เครื่องพนักงาน ฝั่งเซิร์ฟเวอร์มองไม่เห็นว่า
 * เครื่องได้รับข้อความไหม ปิดแจ้งเตือนไว้ไหม โดนประหยัดแบตไหม — ต้องให้เครื่องรายงานเอง
 * ใช้ cookie ของ WebView เป็นตัวยืนยันตัวตน (session เดียวกับหน้าเว็บในแอป); ห้ามส่ง token/ข้อมูลลูกค้า
 * ล้มเหลว = เงียบ (log ต้องไม่ทำให้แจ้งเตือนหรือแอปพัง)
 */
final class DeviceLog {

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int TIMEOUT_MS = 5000;

    private DeviceLog() {}

    static void send(Context context, String event, JSONObject detail) {
        final Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            try {
                String serverUrl = CapConfig.loadDefault(app).getServerUrl();
                if (serverUrl == null || serverUrl.isEmpty()) return;
                String base = serverUrl.endsWith("/") ? serverUrl.substring(0, serverUrl.length() - 1) : serverUrl;
                String cookies = CookieManager.getInstance().getCookie(base);
                if (cookies == null || cookies.isEmpty()) return;

                JSONObject body = new JSONObject();
                body.put("event", event);
                body.put("detail", detail != null ? detail : new JSONObject());
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

                HttpURLConnection connection = (HttpURLConnection) new URL(base + "/api/app/device-log").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Cookie", cookies);
                // เซิร์ฟเวอร์อ่านรุ่นแอปจาก UA เหมือนหน้าเว็บ (StoreOSApp/x.y.z)
                connection.setRequestProperty("User-Agent", "StoreOSApp/" + versionName(app) + " Android native");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(payload);
                }
                connection.getResponseCode();
                connection.disconnect();
            } catch (Throwable ignored) {
                // log ห้ามทำให้อย่างอื่นพัง
            }
        });
    }

    /** versionName ของแอป (AGP 8 ปิด BuildConfig ไว้ จึงอ่านจาก PackageManager) */
    private static String versionName(Context context) {
        try {
            String name = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
            return name != null ? name : "0";
        } catch (Exception e) {
            return "0";
        }
    }

    /** สภาพเครื่องที่มีผลกับแจ้งเตือน — แนบกับทุก event เพื่อไล่ปัญหาได้ในแถวเดียว */
    static JSONObject deviceState(Context context) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("sdk", Build.VERSION.SDK_INT);
            detail.put("manufacturer", Build.MANUFACTURER);
            detail.put("model", Build.MODEL);
            detail.put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                NotificationChannel channel = manager != null ? manager.getNotificationChannel(MainActivity.ORDER_CHANNEL_ID) : null;
                // -1 = ยังไม่มีช่อง, 0 = ผู้ใช้ปิดช่องนี้, 4 = HIGH (ตั้งใจ)
                detail.put("orderChannelImportance", channel != null ? channel.getImportance() : -1);
                detail.put("orderChannelHasSound", channel != null && channel.getSound() != null);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (power != null) {
                    detail.put("ignoringBatteryOptimizations", power.isIgnoringBatteryOptimizations(context.getPackageName()));
                    detail.put("interactive", power.isInteractive());
                }
            }
            detail.put("inForeground", MainActivity.isInForeground());
        } catch (Throwable ignored) {
            // เก็บเท่าที่ได้
        }
        return detail;
    }
}
