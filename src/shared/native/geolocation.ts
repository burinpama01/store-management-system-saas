"use client";

/**
 * ตำแหน่ง GPS ผ่าน native plugin (Capacitor) สำหรับแอปมือถือ
 *
 * ใน WebView ของแอป `navigator.geolocation` มักคืนตำแหน่งแบบเครือข่าย (coarse)
 * ที่คลาดเคลื่อนหลักกิโลเมตร ทำให้ geofence เข้างานไม่ผ่านทั้งที่อยู่หน้าร้าน —
 * ใช้ @capacitor/geolocation ได้ GPS จริงความแม่นสูง. บนเว็บปกติคืน null เพื่อให้
 * ผู้เรียก fallback ไป navigator.geolocation ตามเดิม
 */

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
}

export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export interface NativePosition {
  lat: number;
  lng: number;
  accuracy?: number;
}

export async function getNativePosition(): Promise<NativePosition | null> {
  if (!isNativeApp()) return null;
  try {
    const { Geolocation } = await import("@capacitor/geolocation");
    // ขอสิทธิ์ตำแหน่ง (iOS/Android 12+ ต้อง grant runtime) ก่อนอ่านค่า
    const perm = await Geolocation.requestPermissions();
    if (perm.location !== "granted" && perm.coarseLocation !== "granted") return null;

    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
    };
  } catch {
    return null;
  }
}
