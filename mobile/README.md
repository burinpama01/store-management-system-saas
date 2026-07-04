# StoreOS Mobile (Capacitor Shell)

แอปมือถือ iOS/Android ของ StoreOS — เป็น native shell ที่โหลดเว็บ production (`https://store-os-manage.vercel.app`) ใน WebView และเสริมความสามารถที่เว็บทำไม่ได้:

- **Push notification** ผ่าน FCM/APNs (Phase 2)
- **เชื่อมเครื่องพิมพ์บน iOS** ผ่าน BLE + TCP 9100 (Phase 3)

deploy เว็บ = แอปได้ฟีเจอร์ใหม่ทันที ไม่ต้องส่ง store review (ยกเว้นแก้ส่วน native)

## โครงสร้าง

- `capacitor.config.ts` — appId `com.storeos.app`, ชี้ `server.url` ไปเว็บ prod
- `www/` — หน้า offline fallback เท่านั้น (แอปจริงโหลดจากเว็บ)
- `android/`, `ios/` — โปรเจกต์ native (generate โดย `npx cap add`)
- `assets/logo.png` — ต้นฉบับไอคอน/splash (generate ด้วย `npm run assets`)
- `android/app/google-services.json`, `ios/App/App/GoogleService-Info.plist` — Firebase client config (โปรเจกต์ `storeos-9d84d`)

> ⚠️ **ห้าม** นำไฟล์ service account (`*-firebase-adminsdk-*.json`) เข้า repo — ใช้เป็น env var บน Vercel เท่านั้น

## Build Android (บนเครื่องนี้)

ต้องใช้ JDK 17+ — เครื่องนี้ JDK ใน PATH เป็น 11 ให้ชี้ JAVA_HOME ไปที่ Android Studio JBR ก่อน:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd mobile\android
.\gradlew assembleDebug
# APK: android\app\build\outputs\apk\debug\app-debug.apk
```

ติดตั้งลงมือถือ: เปิด USB debugging แล้ว `adb install app-debug.apk` หรือส่งไฟล์ APK ไปติดตั้งตรง ๆ

## Build iOS

ทำบนเครื่องนี้ไม่ได้ (Windows) — ใช้ Codemagic build → TestFlight (Phase 4)

## หลังแก้ config / เพิ่ม plugin

```powershell
cd mobile
npx cap sync
```
