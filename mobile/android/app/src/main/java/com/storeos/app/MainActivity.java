package com.storeos.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * ช่องแจ้งเตือนออเดอร์ใหม่ (QR / บุฟเฟต์ / เดลิเวอรี) — ต้องตรงกับ
     * ORDER_ALERT_ANDROID_CHANNEL ใน src/modules/notifications/push.ts
     * Android ล็อกเสียงของช่องไว้ตั้งแต่สร้างครั้งแรก: เปลี่ยนไฟล์เสียง = ต้องใช้ id ใหม่
     */
    static final String ORDER_CHANNEL_ID = "storeos_orders";

    /** OrderAlertMessagingService ใช้ตัดสินว่าต้องสร้างแจ้งเตือนเสียงวนไหม (แอปอยู่หน้าจอ = ไม่ต้อง) */
    private static volatile boolean inForeground = false;

    static boolean isInForeground() {
        return inForeground;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createOrderNotificationChannel(this);
        // สภาพเครื่องตอนเปิดแอป: ปิดแจ้งเตือน/ปิดช่องออเดอร์/โดนประหยัดแบต ไหม
        DeviceLog.send(this, "app_open", DeviceLog.deviceState(this));
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
        OrderAlertMessagingService.cancelOrderAlerts(this);
    }

    @Override
    public void onPause() {
        inForeground = false;
        super.onPause();
    }

    static void createOrderNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(ORDER_CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            ORDER_CHANNEL_ID,
            "ออเดอร์ใหม่",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("แจ้งเตือนเมื่อมีออเดอร์ QR หรือเดลิเวอรีเข้า");
        Uri sound = Uri.parse(
            ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/" + R.raw.alert_new_order
        );
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        channel.setSound(sound, attributes);
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 120, 80, 120, 80, 120 });
        manager.createNotificationChannel(channel);
    }
}
