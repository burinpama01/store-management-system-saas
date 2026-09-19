"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  getLauncherDeviceSnapshot,
  getServerLauncherDeviceSnapshot,
  initLauncherDevice,
  subscribeLauncherDevice,
  type LauncherDeviceSnapshot,
} from "./device-host";

/** สถานะของ Launcher ที่เปิดหน้านี้อยู่ (ถ้ามี) — เบราว์เซอร์ปกติได้ inLauncher=false เสมอ */
export function useLauncherDevice(): LauncherDeviceSnapshot {
  useEffect(() => {
    initLauncherDevice();
  }, []);
  return useSyncExternalStore(subscribeLauncherDevice, getLauncherDeviceSnapshot, getServerLauncherDeviceSnapshot);
}
