# สั่งงานด้วยเสียงใน POS รวม — ตารางเบราว์เซอร์ที่ต้องทดสอบด้วยมือ (U16, v0.38.3)

แผนอ้างอิง: `Plan/QR Order Voice Unified POS Implementation Plan v2.html` — Task U16
เกณฑ์: **Chrome/Edge รองรับ; Safari/Firefox/ไม่อนุญาตไมโครโฟน ต้องกลับไปพิมพ์คำสั่งได้โดยไม่ค้างและไม่พัง**

## กติกาที่โค้ดบังคับไว้แล้ว (มีเทสต์คุม)

| ข้อกำหนด | บังคับที่ไหน | เทสต์ |
| --- | --- | --- |
| ตรวจการรองรับจาก runtime capability ไม่ใช่ user-agent | `speech-adapter.ts` → `isSupported()` อ่าน `window.SpeechRecognition`/`webkitSpeechRecognition` | `voice-pos-speech-adapter.test.ts` |
| เบราว์เซอร์ไม่รองรับ = ปุ่ม disabled พร้อมเหตุผล | `VoiceCommandButton.tsx` | `voice-command-button.test.tsx` |
| ไม่อนุญาตไมโครโฟน = ข้อความกู้คืนได้ และกดใหม่ได้ | `speech-adapter.ts` (`permission_denied`) + ปุ่ม | unit + e2e `-g "permission"` |
| ไม่บันทึกเสียง/คำพูดที่ไหนเลย | `telemetry.ts`, ไม่มี storage/console ในเส้นทางเสียง | `voice-pos-privacy.test.ts` |
| touch target ≥ 44px และเคารพ prefers-reduced-motion | `VoiceCommandButton.tsx` (`min-h-11 min-w-11`, `motion-reduce:transition-none`) | `voice-command-button.test.tsx` |

## ตารางที่ต้องทดสอบด้วยมือก่อนขึ้น staging (U19)

| เบราว์เซอร์ | เวอร์ชันที่ทดสอบ | ผลที่คาดไว้ | ผลจริง | วันที่ / ผู้ทดสอบ |
| --- | --- | --- | --- | --- |
| Chrome (Windows) | | ปุ่มทำงาน, ฟัง th-TH, คำสั่งนำทาง/ตะกร้าได้ | | |
| Chrome (Android) | | เหมือนข้างบน + touch target ใช้ได้จริง | | |
| Edge (Windows) | | ปุ่มทำงาน (เสียงอาจถูกส่งไป Azure — แจ้งผู้ใช้แล้ว) | | |
| Safari (macOS) | | ปุ่ม disabled หรือแจ้งไม่รองรับ ไม่ crash | | |
| Safari (iOS/iPad) | | เหมือนข้างบน + ยังใช้ปุ่มบนหน้าจอได้ปกติ | | |
| Firefox (Windows) | | ปุ่ม disabled หรือแจ้งไม่รองรับ ไม่ crash | | |
| Chrome + ปฏิเสธไมโครโฟน | | ข้อความ "ยังไม่ได้อนุญาตให้ใช้ไมโครโฟน" และกดใหม่ได้ | | |
| Chrome + ตัดเน็ตระหว่างฟัง | | ข้อความ network และกลับมากดใหม่ได้ | | |
| โปรแกรมอ่านหน้าจอ (NVDA/VoiceOver) | | ได้ยิน "สถานะ" เท่านั้น ไม่อ่านคำพูดของผู้ใช้ | | |
| ระบบตั้งค่า reduced motion | | ปุ่มไม่มี transition กระพริบ | | |

> ช่อง "ผลจริง" ต้องกรอกจากการทดสอบบนเครื่องจริงในรอบ U19 (staging RC) — ห้ามสรุปจากเอกสารนี้เพียงอย่างเดียว

## ข้อจำกัดที่ทราบ ณ v0.38.3

- หน้า `/pos` ไม่ได้อยู่ใต้ layout `(dashboard)` จึง **ไม่มี Ctrl+K command palette** บนหน้านี้ —
  ทางสำรองของหน้า POS คือแท็บและปุ่มบนหน้าจอ (ข้อความใน UI ระบุตามนี้)
- คำสั่ง "ค้นหา" จะโฟกัสได้ก็ต่อเมื่อหน้านั้นมี element ที่ติด `[data-voice-focus="search"]`
  ปัจจุบันหน้าขายมีเฉพาะ `[data-voice-focus="cart"]`
- Edge Web Speech อาจส่งเสียงไปประมวลผลบน Azure Cognitive Services — ระบบแจ้งผู้ใช้ก่อนใช้งานแล้ว
  ทั้งในปุ่มและหน้า ตั้งค่า → สั่งงานด้วยเสียง
