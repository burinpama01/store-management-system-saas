"use client";

import { useEffect, useRef } from "react";
import type * as LeafletNS from "leaflet";

const BANGKOK: [number, number] = [13.7563, 100.5018];

/**
 * Click-to-pick location map (Leaflet + OpenStreetMap, no API key).
 * Places a marker + geofence radius circle; reports picked lat/lng via onPick.
 */
export function MapPicker({
  lat,
  lng,
  radius,
  onPick,
  center = null,
  showRadius = true,
}: {
  lat: number | null;
  lng: number | null;
  radius: number | null;
  onPick: (lat: number, lng: number) => void;
  /** จุดกลางเริ่มต้นเมื่อยังไม่มีหมุด (เช่น ที่ตั้งร้าน) — ไม่มี = กรุงเทพฯ */
  center?: { lat: number; lng: number } | null;
  /** วงรัศมีรอบหมุด (จุดลงเวลาใช้) — ปักหมุดจุดส่งไม่ต้องมี */
  showRadius?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletNS.Map | null>(null);
  const markerRef = useRef<LeafletNS.CircleMarker | null>(null);
  const circleRef = useRef<LeafletNS.Circle | null>(null);
  const onPickRef = useRef(onPick);
  const placeRef = useRef<((la: number, ln: number) => void) | null>(null);
  /** ตำแหน่งที่ผู้ใช้เพิ่งแตะ — prop ที่ไหลกลับมาค่าเดียวกันไม่ต้องเลื่อนกล้อง */
  const lastPickRef = useRef<string | null>(null);
  useEffect(() => {
    onPickRef.current = onPick;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const L = await import("leaflet");
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !containerRef.current || mapRef.current) return;

      const start: [number, number] =
        lat != null && lng != null ? [lat, lng] : center ? [center.lat, center.lng] : BANGKOK;
      const map = L.map(containerRef.current).setView(start, lat != null ? 16 : center ? 15 : 11);
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(map);

      const place = (la: number, ln: number) => {
        if (markerRef.current) markerRef.current.setLatLng([la, ln]);
        else
          markerRef.current = L.circleMarker([la, ln], {
            radius: 8,
            color: "#b42318",
            fillColor: "#b42318",
            fillOpacity: 1,
          }).addTo(map);
        if (!showRadius) return;
        if (circleRef.current) circleRef.current.setLatLng([la, ln]);
        else
          circleRef.current = L.circle([la, ln], {
            radius: radius ?? 100,
            color: "#14765f",
            fillColor: "#14765f",
            fillOpacity: 0.12,
          }).addTo(map);
      };

      placeRef.current = place;
      if (lat != null && lng != null) place(lat, lng);
      map.on("click", (e: LeafletNS.LeafletMouseEvent) => {
        place(e.latlng.lat, e.latlng.lng);
        lastPickRef.current = `${e.latlng.lat},${e.latlng.lng}`;
        onPickRef.current(e.latlng.lat, e.latlng.lng);
      });
      setTimeout(() => map.invalidateSize(), 120);
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
        circleRef.current = null;
        placeRef.current = null;
      }
    };
    // init once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (circleRef.current && radius && radius > 0) circleRef.current.setRadius(radius);
  }, [radius]);

  // ค่าพิกัดเปลี่ยนจากภายนอก (เช่น กด "ใช้ตำแหน่งปัจจุบัน") → ย้ายหมุด + เลื่อนกล้องไปหา
  useEffect(() => {
    if (lat == null || lng == null || !placeRef.current || !mapRef.current) return;
    if (lastPickRef.current === `${lat},${lng}`) return;
    placeRef.current(lat, lng);
    mapRef.current.setView([lat, lng], Math.max(mapRef.current.getZoom(), 16));
  }, [lat, lng]);

  return <div ref={containerRef} className="h-64 w-full overflow-hidden rounded-md border border-[var(--border)]" />;
}
