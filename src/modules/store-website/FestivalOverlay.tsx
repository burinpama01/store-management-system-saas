import type { FestivalDecoration, FestivalView } from "./festivals";

/**
 * ชั้นตกแต่งเทศกาล: แถบทักทายด้านบน + สัญลักษณ์ลอย (เบา ๆ ด้วย CSS)
 * - ตำแหน่ง/จังหวะกำหนดตายตัว (ไม่สุ่ม) เพื่อให้ HTML ฝั่ง server กับ client ตรงกัน
 * - calm (วันพระ/วันชาติ) = ไม่มีอนิเมชัน แสดงสัญลักษณ์นิ่งข้างข้อความเท่านั้น
 * - ผู้ใช้ตั้ง "ลดการเคลื่อนไหว" → ปิดอนิเมชันทั้งหมด
 * - pointer-events: none ไม่บังปุ่มของหน้าเว็บ
 */

const SYMBOL: Record<FestivalDecoration, string> = {
  lanterns: "🏮",
  pumpkins: "🎃",
  fireworks: "🎆",
  krathong: "🪷",
  water: "💧",
  snow: "❄️",
  hearts: "❤️",
  moon: "🥮",
  lotus: "🪷",
  balloons: "🎈",
  flowers: "🌸",
  sale: "🏷️",
  jay: "🟡",
  incense: "🕯️",
  flag: "🇹🇭",
  jasmine: "🤍",
  canna: "💛",
};

/** รูปแบบการเคลื่อนไหวของแต่ละสัญลักษณ์ */
const MOTION: Record<FestivalDecoration, "fall" | "rise" | "sway" | "burst" | "float" | "none"> = {
  lanterns: "sway",
  pumpkins: "float",
  fireworks: "burst",
  krathong: "float",
  water: "fall",
  snow: "fall",
  hearts: "rise",
  moon: "float",
  lotus: "none",
  balloons: "rise",
  flowers: "fall",
  sale: "float",
  jay: "float",
  incense: "none",
  flag: "none",
  jasmine: "none",
  canna: "none",
};

const SPOTS = [
  { left: 6, delay: 0, size: 22 },
  { left: 22, delay: 1.4, size: 18 },
  { left: 38, delay: 0.6, size: 24 },
  { left: 54, delay: 2.1, size: 18 },
  { left: 70, delay: 0.9, size: 22 },
  { left: 86, delay: 1.8, size: 20 },
];

export function FestivalOverlay({ festival }: { festival: FestivalView }) {
  const symbol = SYMBOL[festival.decoration];
  const motion = festival.calm ? "none" : MOTION[festival.decoration];
  return (
    <>
      <style>{`
        .wf-layer{position:absolute;left:0;right:0;top:37px;height:300px;overflow:hidden;pointer-events:none;z-index:3}
        .wf-sym{position:absolute;top:-30px;opacity:.9;will-change:transform}
        .wf-fall{animation:wf-fall 7s linear infinite}
        .wf-rise{top:auto;bottom:-30px;animation:wf-rise 8s linear infinite}
        .wf-sway{top:6px;transform-origin:top center;animation:wf-sway 3s ease-in-out infinite}
        .wf-float{top:auto;bottom:16px;animation:wf-float 4s ease-in-out infinite}
        .wf-burst{top:40px;animation:wf-burst 2.6s ease-out infinite}
        @keyframes wf-fall{to{transform:translateY(340px) rotate(25deg)}}
        @keyframes wf-rise{to{transform:translateY(-340px)}}
        @keyframes wf-sway{50%{transform:rotate(10deg)}}
        @keyframes wf-float{50%{transform:translateY(-8px)}}
        @keyframes wf-burst{0%{transform:scale(.2);opacity:0}30%{opacity:1}100%{transform:scale(1.5);opacity:0}}
        @media (prefers-reduced-motion: reduce){.wf-sym{animation:none!important;display:none}}
      `}</style>
      <div
        role="note"
        aria-label={`เทศกาล${festival.name}`}
        style={{
          position: "relative",
          zIndex: 4,
          background: festival.color,
          color: "#fff",
          textAlign: "center",
          fontWeight: 700,
          fontSize: 14,
          padding: "8px 12px",
        }}
      >
        <span aria-hidden="true">{symbol} </span>
        {festival.greeting}
        <span aria-hidden="true"> {symbol}</span>
      </div>
      {motion !== "none" && (
        <div className="wf-layer" aria-hidden="true">
          {SPOTS.map((spot) => (
            <span
              key={spot.left}
              className={`wf-sym wf-${motion}`}
              style={{ left: `${spot.left}%`, fontSize: spot.size, animationDelay: `${spot.delay}s` }}
            >
              {symbol}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
