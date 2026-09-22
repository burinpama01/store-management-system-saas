package com.storeos.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.service.notification.StatusBarNotification;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.RemoteMessage;
import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;
import java.util.Map;

/**
 * รับ push ของ FCM แทนตัวของ plugin (ต่อยอด ไม่ได้ตัดทิ้ง — ยังส่งต่อให้ plugin ทุกข้อความ)
 *
 * ออเดอร์ใหม่ที่เซิร์ฟเวอร์ส่งแบบ data-only (`alert=order_insistent`, แอป 1.0.3+) จะถูกสร้าง
 * แจ้งเตือนเองพร้อม FLAG_INSISTENT ให้เสียงดังวนจนกว่าจะแตะแจ้งเตือน/เปิดแอป — แจ้งเตือนที่
 * ระบบแสดงให้เอง (มี notification block) ดังได้แค่รอบเดียวและแอปแก้อะไรไม่ได้
 * ถ้าแอปเปิดอยู่หน้าจอ ไม่ต้องสร้าง: dialog ในเว็บดังวนของมันเองอยู่แล้ว
 */
public class OrderAlertMessagingService extends MessagingService {

    static final String INSISTENT_ALERT = "order_insistent";
    static final String NOTIFICATION_TAG = "storeos_order_alert";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (INSISTENT_ALERT.equals(data.get("alert")) && !MainActivity.isInForeground()) {
            showInsistentOrderAlert(data);
        }
        super.onMessageReceived(remoteMessage);
    }

    private void showInsistentOrderAlert(Map<String, String> data) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        MainActivity.createOrderNotificationChannel(this);

        String title = data.get("title");
        String body = data.get("body");
        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(this, MainActivity.ORDER_CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title != null && !title.isEmpty() ? title : "StoreOS")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            // Android < 8 ไม่มีช่อง — ใส่เสียงตรงนี้ (8+ ใช้เสียงของช่องและไม่สนค่านี้)
            .setSound(Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + getPackageName() + "/" + R.raw.alert_new_order))
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .build();
        // ให้เสียงของช่อง storeos_orders ดังวนซ้ำจนกว่าจะแตะ/ปัดทิ้ง/เปิดแอป
        notification.flags |= Notification.FLAG_INSISTENT;

        manager.notify(NOTIFICATION_TAG, (int) System.currentTimeMillis(), notification);
    }

    /** เปิดแอปแล้ว = หยุดเสียงวน (dialog ในแอปรับช่วงเตือนต่อเอง) */
    static void cancelOrderAlerts(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (NOTIFICATION_TAG.equals(active.getTag())) manager.cancel(NOTIFICATION_TAG, active.getId());
        }
    }
}
