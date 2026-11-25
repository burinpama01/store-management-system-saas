// ขนาดการ์ดเมนูบนหน้า POS — เลือกเองต่อเครื่อง (ร้านเมนูเยอะ = เล็ก, คาเฟ่รูปสวย = ใหญ่)
// เก็บใน localStorage ของเครื่องนั้น ไม่ต้องมี migration; อ่าน/เขียนไม่ได้ (โหมดส่วนตัว) = ใช้ "กลาง"

export type PosTileSize = "sm" | "md" | "lg";

export const POS_TILE_SIZE_KEY = "storeos.pos.tileSize";
const CHANGE_EVENT = "storeos:pos-tile-size";

export const POS_TILE_SIZE_ORDER: readonly PosTileSize[] = ["sm", "md", "lg"];

export const POS_TILE_SIZE_LABEL: Record<PosTileSize, string> = {
  sm: "เล็ก",
  md: "กลาง",
  lg: "ใหญ่",
};

// class ต้องเป็น string ตายตัวในไฟล์ (Tailwind สแกนจากซอร์ส ห้ามต่อ string)
// md+ มีแผงออร์เดอร์ 320px กินที่ → การ์ดขั้นต่ำช่วง md เล็กกว่า sm
export const POS_TILE_GRID_CLASS: Record<PosTileSize, string> = {
  sm: "grid grid-cols-4 gap-1.5 sm:grid-cols-[repeat(auto-fill,minmax(96px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(76px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(100px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(110px,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(135px,1fr))]",
  md: "grid grid-cols-3 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(112px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(96px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(120px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(135px,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]",
  lg: "grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(130px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]",
};

export function parseTileSize(value: string | null | undefined): PosTileSize {
  return value === "sm" || value === "lg" ? value : "md";
}

export function nextTileSize(current: PosTileSize): PosTileSize {
  const index = POS_TILE_SIZE_ORDER.indexOf(current);
  return POS_TILE_SIZE_ORDER[(index + 1) % POS_TILE_SIZE_ORDER.length];
}

export function readTileSize(): PosTileSize {
  try {
    return parseTileSize(window.localStorage.getItem(POS_TILE_SIZE_KEY));
  } catch {
    return "md";
  }
}

/** ค่าฝั่ง server / ก่อน hydrate — ต้องตรงกันทุกครั้งเพื่อไม่ให้ hydration mismatch */
export function serverTileSize(): PosTileSize {
  return "md";
}

// localStorage เขียนไม่ได้ (โหมดส่วนตัว) → จำไว้ในหน่วยความจำ ให้ปุ่มยังสลับได้ในหน้านี้
let memoryFallback: PosTileSize | null = null;

export function writeTileSize(size: PosTileSize): void {
  try {
    window.localStorage.setItem(POS_TILE_SIZE_KEY, size);
    memoryFallback = null;
  } catch {
    memoryFallback = size;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getTileSnapshot(): PosTileSize {
  return memoryFallback ?? readTileSize();
}

export function subscribeTileSize(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
