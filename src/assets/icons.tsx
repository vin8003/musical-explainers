// Built-in illustration library. Original, code-drawn SVG (owned by this repo,
// no third-party licence), so every video can use them freely. Each icon draws
// in a 100x100 box with a flat-shaded style: base fill, a lighter top plane and
// a darker side so objects read as 3D at small sizes.
import React from "react";
import { Img, staticFile } from "remotion";
import { alpha, Palette } from "../theme";
import { assetFile } from "./registry";

type Draw = (p: Palette) => React.ReactNode;

const S = (d: string, fill: string, extra: React.SVGProps<SVGPathElement> = {}) => <path d={d} fill={fill} {...extra} />;
const stroke = (c: string, w = 4) => ({ stroke: c, strokeWidth: w, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" });

const icons: Record<string, Draw> = {
  laptop: (p) => (
    <>
      <rect x={18} y={20} width={64} height={44} rx={5} fill="#2F3550" />
      <rect x={22} y={24} width={56} height={36} rx={2} fill={p.cool} />
      <rect x={22} y={24} width={56} height={14} fill={alpha("#ffffff", 0.18)} />
      {S("M10 66 H90 L84 76 H16 Z", "#C9CDE0")}
      {S("M10 66 H90 L89 68 H11 Z", "#ffffff", { opacity: 0.6 })}
      <rect x={42} y={68} width={16} height={3} rx={1.5} fill="#9AA0BA" />
    </>
  ),
  phone: (p) => (
    <>
      <rect x={30} y={10} width={40} height={80} rx={8} fill="#2F3550" />
      <rect x={34} y={18} width={32} height={62} rx={3} fill={p.accent} />
      <rect x={34} y={18} width={32} height={24} fill={alpha("#ffffff", 0.2)} />
      <rect x={44} y={13} width={12} height={2.5} rx={1.2} fill="#596080" />
      <circle cx={50} cy={85} r={2.5} fill="#596080" />
    </>
  ),
  router: (p) => (
    <>
      <line x1={30} y1={44} x2={24} y2={18} {...stroke("#596080", 4)} />
      <line x1={70} y1={44} x2={76} y2={18} {...stroke("#596080", 4)} />
      {S("M14 48 L50 36 L86 48 L50 60 Z", "#E2E5F2")}
      {S("M14 48 L50 60 L50 76 L14 64 Z", "#9AA0BA")}
      {S("M50 60 L86 48 L86 64 L50 76 Z", "#BCC1D6")}
      <circle cx={58} cy={66} r={2.4} fill={p.accent} />
      <circle cx={66} cy={63} r={2.4} fill={p.accent} />
      <circle cx={74} cy={60} r={2.4} fill={p.primary} />
    </>
  ),
  server: (p) => (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(0 ${i * 24})`}>
          <rect x={22} y={16} width={56} height={20} rx={4} fill={i === 1 ? "#3A4166" : "#2F3550"} />
          <rect x={22} y={16} width={56} height={6} rx={3} fill={alpha("#ffffff", 0.12)} />
          <circle cx={32} cy={26} r={2.6} fill={i === 2 ? p.primary : p.accent} />
          <rect x={40} y={24.5} width={30} height={3} rx={1.5} fill="#596080" />
        </g>
      ))}
    </>
  ),
  cloud: (p) => (
    <>
      {S("M28 72 a16 16 0 0 1 2 -32 a22 22 0 0 1 42 -4 a18 18 0 0 1 2 36 Z", "#E8ECFF")}
      {S("M28 72 a16 16 0 0 1 -3 -6 H78 a18 18 0 0 1 -4 6 Z", "#B9C1EA")}
      <circle cx={50} cy={40} r={14} fill="#ffffff" opacity={0.5} />
    </>
  ),
  tower: (p) => (
    <>
      {S("M50 22 L36 88 H42 L50 50 L58 88 H64 Z", "#BCC1D6")}
      <line x1={40} y1={70} x2={60} y2={70} {...stroke("#9AA0BA", 3)} />
      <circle cx={50} cy={20} r={5} fill={p.secondary} />
      <path d="M36 12 a20 20 0 0 0 0 18 M64 12 a20 20 0 0 1 0 18" {...stroke(p.accent, 3.5)} />
      <path d="M28 6 a32 32 0 0 0 0 30 M72 6 a32 32 0 0 1 0 30" {...stroke(alpha(p.accent, 0.6), 3)} />
    </>
  ),
  satellite: (p) => (
    <>
      <rect x={6} y={40} width={28} height={20} rx={2} fill={p.cool} />
      <rect x={66} y={40} width={28} height={20} rx={2} fill={p.cool} />
      <path d="M13 40 V60 M20 40 V60 M27 40 V60 M73 40 V60 M80 40 V60 M87 40 V60" {...stroke(alpha("#ffffff", 0.35), 1.5)} />
      <rect x={34} y={47} width={32} height={6} fill="#9AA0BA" />
      <rect x={38} y={34} width={24} height={32} rx={4} fill="#E2E5F2" />
      <rect x={38} y={34} width={10} height={32} rx={3} fill="#ffffff" opacity={0.5} />
      <circle cx={50} cy={74} r={6} fill={p.primary} />
    </>
  ),
  globe: (p) => (
    <>
      <circle cx={50} cy={50} r={38} fill={p.cool} />
      {S("M30 26 C40 22 48 30 44 38 C40 46 30 44 28 52 C26 58 20 56 16 50 C16 40 22 30 30 26 Z", p.accent)}
      {S("M56 44 C64 40 74 46 76 56 C78 66 70 76 62 78 C58 70 62 64 56 58 C52 54 52 48 56 44 Z", p.accent)}
      {S("M58 16 C66 18 74 24 78 32 C70 32 62 28 58 16 Z", p.accent)}
      <circle cx={50} cy={50} r={38} fill="none" stroke={alpha("#ffffff", 0.25)} strokeWidth={2} />
      <path d="M22 30 A38 38 0 0 1 60 13" {...stroke(alpha("#ffffff", 0.5), 4)} />
    </>
  ),
  packet: (p) => (
    <>
      {S("M50 14 L86 32 L50 50 L14 32 Z", p.primary)}
      {S("M14 32 L50 50 L50 88 L14 70 Z", "#D9A21F")}
      {S("M50 50 L86 32 L86 70 L50 88 Z", "#F0B82E")}
      {S("M32 23 L68 41 L68 48 L32 30 Z", alpha("#ffffff", 0.45))}
    </>
  ),
  video: (p) => (
    <>
      <rect x={10} y={20} width={80} height={56} rx={8} fill="#2F3550" />
      <rect x={14} y={24} width={72} height={48} rx={5} fill={p.secondary} />
      <rect x={14} y={24} width={72} height={18} fill={alpha("#ffffff", 0.16)} />
      {S("M43 36 L62 48 L43 60 Z", "#ffffff")}
      <rect x={14} y={80} width={72} height={4} rx={2} fill="#596080" />
      <rect x={14} y={80} width={30} height={4} rx={2} fill={p.primary} />
    </>
  ),
  cat: (p) => (
    <>
      {S("M24 38 L28 12 L44 30 Z", p.warm)}
      {S("M76 38 L72 12 L56 30 Z", p.warm)}
      <ellipse cx={50} cy={52} rx={32} ry={28} fill={p.warm} />
      <ellipse cx={50} cy={60} rx={18} ry={14} fill="#FFE2C4" />
      <ellipse cx={38} cy={48} rx={4.5} ry={6} fill={p.ink} />
      <ellipse cx={62} cy={48} rx={4.5} ry={6} fill={p.ink} />
      <circle cx={39.5} cy={46} r={1.6} fill="#fff" />
      <circle cx={63.5} cy={46} r={1.6} fill="#fff" />
      {S("M46 57 L54 57 L50 61 Z", p.secondary)}
      <path d="M50 61 v4 M50 65 q-5 4 -9 0 M50 65 q5 4 9 0" {...stroke(p.ink, 2)} />
    </>
  ),
  house: (p) => (
    <>
      {S("M16 48 L50 20 L84 48 Z", p.secondary)}
      <rect x={24} y={46} width={52} height={40} fill="#F1E6D2" />
      <rect x={24} y={46} width={52} height={6} fill="#D8CAB0" />
      <rect x={44} y={62} width={12} height={24} rx={2} fill={p.warm} />
      <rect x={30} y={56} width={10} height={10} rx={1.5} fill={p.primary} />
      <rect x={60} y={56} width={10} height={10} rx={1.5} fill={p.primary} />
    </>
  ),
  building: (p) => (
    <>
      <rect x={26} y={14} width={40} height={74} fill="#3A4166" />
      <rect x={26} y={14} width={12} height={74} fill={alpha("#ffffff", 0.08)} />
      <rect x={62} y={34} width={18} height={54} fill="#2F3550" />
      {Array.from({ length: 6 }).map((_, r) =>
        [0, 1, 2].map((c) => <rect key={`${r}-${c}`} x={31 + c * 11} y={20 + r * 11} width={6} height={6} fill={(r + c) % 3 ? p.primary : alpha(p.primary, 0.3)} />)
      )}
    </>
  ),
  wifi: (p) => (
    <>
      <path d="M20 42 a42 42 0 0 1 60 0" {...stroke(p.accent, 7)} />
      <path d="M31 54 a26 26 0 0 1 38 0" {...stroke(p.accent, 7)} />
      <path d="M41 66 a12 12 0 0 1 18 0" {...stroke(p.accent, 7)} />
      <circle cx={50} cy={76} r={5} fill={p.accent} />
    </>
  ),
  lock: (p) => (
    <>
      <path d="M34 44 V32 a16 16 0 0 1 32 0 V44" {...stroke("#BCC1D6", 8)} />
      <rect x={24} y={42} width={52} height={42} rx={8} fill={p.primary} />
      <rect x={24} y={42} width={52} height={12} rx={6} fill={alpha("#ffffff", 0.3)} />
      <circle cx={50} cy={60} r={6} fill={p.ink} />
      <rect x={47.5} y={62} width={5} height={12} rx={2} fill={p.ink} />
    </>
  ),
  cable: (p) => (
    <>
      <circle cx={50} cy={50} r={36} fill="#2F3550" />
      <circle cx={50} cy={50} r={30} fill="#596080" />
      <circle cx={50} cy={50} r={22} fill="#3A4166" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <circle key={a} cx={50 + 12 * Math.cos((a * Math.PI) / 180)} cy={50 + 12 * Math.sin((a * Math.PI) / 180)} r={4.5} fill={p.accent} />
      ))}
      <circle cx={50} cy={50} r={4.5} fill={p.primary} />
    </>
  ),
  cell: (p) => (
    <>
      <ellipse cx={50} cy={50} rx={42} ry={36} fill={alpha(p.secondary, 0.35)} stroke={p.secondary} strokeWidth={3} />
      <circle cx={46} cy={46} r={13} fill={alpha(p.cool, 0.8)} />
      <circle cx={43} cy={43} r={4} fill={alpha("#ffffff", 0.5)} />
      <ellipse cx={70} cy={60} rx={9} ry={5} transform="rotate(-20 70 60)" fill={p.warm} />
      <ellipse cx={30} cy={66} rx={8} ry={4.5} transform="rotate(25 30 66)" fill={p.warm} />
      <ellipse cx={66} cy={34} rx={7} ry={4} transform="rotate(10 66 34)" fill={p.warm} />
    </>
  ),
  mitochondrion: (p) => (
    <>
      <ellipse cx={50} cy={50} rx={44} ry={26} fill={p.warm} />
      <ellipse cx={50} cy={50} rx={38} ry={20} fill="#FFC7A0" />
      <path d="M18 50 C22 34 26 66 30 50 C34 34 38 66 42 50 C46 34 50 66 54 50 C58 34 62 66 66 50 C70 34 74 66 80 50" {...stroke(p.warm, 4.5)} />
      <ellipse cx={42} cy={36} rx={22} ry={6} fill={alpha("#ffffff", 0.35)} />
    </>
  ),
  atp: (p) => (
    <>
      <circle cx={50} cy={50} r={38} fill={p.primary} />
      <circle cx={50} cy={50} r={38} fill="none" stroke="#E0A800" strokeWidth={4} />
      {S("M54 18 L34 54 H48 L44 82 L66 44 H52 Z", "#ffffff")}
      <path d="M26 30 A30 30 0 0 1 52 16" {...stroke(alpha("#ffffff", 0.55), 4)} />
    </>
  ),
  glucose: (p) => (
    <>
      {S("M50 12 L84 31 V69 L50 88 L16 69 V31 Z", p.secondary)}
      {S("M50 22 L75 36 V64 L50 78 L25 64 V36 Z", alpha("#ffffff", 0.2))}
      <circle cx={50} cy={12} r={6} fill="#fff" />
      <circle cx={84} cy={31} r={6} fill="#fff" />
      <circle cx={16} cy={69} r={6} fill="#fff" />
    </>
  ),
  oxygen: (p) => (
    <>
      <circle cx={36} cy={50} r={22} fill={p.cool} />
      <circle cx={64} cy={50} r={22} fill={p.cool} />
      <circle cx={30} cy={42} r={7} fill={alpha("#ffffff", 0.5)} />
      <circle cx={58} cy={42} r={7} fill={alpha("#ffffff", 0.5)} />
    </>
  ),
  dna: (p) => (
    <>
      {Array.from({ length: 9 }).map((_, i) => {
        const y = 10 + i * 10;
        const x = Math.sin(i * 0.8) * 22;
        return <line key={i} x1={50 - x} y1={y} x2={50 + x} y2={y} {...stroke(i % 2 ? p.primary : p.accent, 3.5)} />;
      })}
      <path d={Array.from({ length: 41 }).map((_, i) => `${i ? "L" : "M"}${50 - Math.sin((i / 4) * 0.8) * 22} ${10 + (i / 4) * 10}`).join(" ")} {...stroke(p.secondary, 5)} />
      <path d={Array.from({ length: 41 }).map((_, i) => `${i ? "L" : "M"}${50 + Math.sin((i / 4) * 0.8) * 22} ${10 + (i / 4) * 10}`).join(" ")} {...stroke(p.cool, 5)} />
    </>
  ),
  bacterium: (p) => (
    <>
      <rect x={14} y={34} width={72} height={32} rx={16} fill={p.accent} />
      <rect x={18} y={36} width={64} height={10} rx={5} fill={alpha("#ffffff", 0.35)} />
      <path d="M86 50 C94 44 96 58 100 50" {...stroke(p.accent, 3)} />
      <circle cx={36} cy={54} r={3} fill={alpha(p.ink, 0.5)} />
      <circle cx={56} cy={50} r={3} fill={alpha(p.ink, 0.5)} />
      <circle cx={68} cy={57} r={2.5} fill={alpha(p.ink, 0.5)} />
    </>
  ),
  nucleus: (p) => (
    <>
      <circle cx={50} cy={50} r={36} fill={p.cool} />
      <circle cx={50} cy={50} r={36} fill="none" stroke={alpha("#ffffff", 0.5)} strokeWidth={3} strokeDasharray="6 5" />
      <circle cx={56} cy={56} r={12} fill={alpha(p.ink, 0.35)} />
      <circle cx={40} cy={38} r={9} fill={alpha("#ffffff", 0.4)} />
    </>
  ),
  heart: (p) => (
    <>
      {S("M50 84 C20 62 10 46 14 32 C18 18 38 14 50 30 C62 14 82 18 86 32 C90 46 80 62 50 84 Z", p.secondary)}
      {S("M26 30 C30 22 40 22 44 30", "none", stroke(alpha("#ffffff", 0.6), 5))}
    </>
  ),
  muscle: (p) => (
    <>
      {S("M14 70 C14 52 28 40 42 40 C46 26 56 16 66 20 C74 24 72 34 64 38 C78 40 88 52 86 66 C84 78 70 84 56 82 L20 84 C16 82 14 76 14 70 Z", p.warm)}
      {S("M44 44 C52 40 64 42 70 50", "none", stroke(alpha("#ffffff", 0.5), 4))}
    </>
  ),
  skin: (p) => (
    <>
      {[0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => (
        <rect key={`${r}${c}`} x={10 + c * 20 + (r % 2) * 10} y={22 + r * 18} width={18} height={16} rx={5} fill={r % 2 ? "#F2B8A0" : "#E89F84"} />
      )))}
    </>
  ),
  lightning: (p) => S("M58 8 L24 56 H46 L38 92 L78 40 H56 Z", p.primary),
  sun: (p) => (
    <>
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <line key={i} x1={50 + Math.cos(a) * 30} y1={50 + Math.sin(a) * 30} x2={50 + Math.cos(a) * 44} y2={50 + Math.sin(a) * 44} {...stroke(p.primary, 5)} />;
      })}
      <circle cx={50} cy={50} r={22} fill={p.primary} />
      <circle cx={44} cy={44} r={8} fill={alpha("#ffffff", 0.45)} />
    </>
  ),
  leaf: (p) => (
    <>
      {S("M20 80 C16 40 44 14 86 14 C86 56 60 84 20 80 Z", p.accent)}
      <path d="M20 80 C40 60 56 44 74 26" {...stroke(alpha(p.ink, 0.4), 3)} />
    </>
  ),
  clock: (p) => (
    <>
      <circle cx={50} cy={50} r={38} fill="#F4F5FF" />
      <circle cx={50} cy={50} r={38} fill="none" stroke={p.secondary} strokeWidth={6} />
      <path d="M50 26 V50 L66 60" {...stroke(p.ink, 5)} />
      <circle cx={50} cy={50} r={4} fill={p.ink} />
    </>
  ),
  magnifier: (p) => (
    <>
      <line x1={62} y1={62} x2={86} y2={86} {...stroke("#596080", 10)} />
      <circle cx={42} cy={42} r={26} fill={alpha(p.cool, 0.35)} stroke="#E2E5F2" strokeWidth={7} />
      <path d="M28 34 A16 16 0 0 1 40 24" {...stroke(alpha("#ffffff", 0.7), 4)} />
    </>
  ),
  question: (p) => (
    <>
      <circle cx={50} cy={50} r={40} fill={p.secondary} />
      <path d="M38 38 a12 12 0 1 1 18 10 c-4 3 -6 5 -6 10" {...stroke("#ffffff", 8)} />
      <circle cx={50} cy={72} r={5} fill="#fff" />
    </>
  ),
  star: (p) => S("M50 8 L61 38 L94 39 L68 59 L77 91 L50 72 L23 91 L32 59 L6 39 L39 38 Z", p.primary),
  check: (p) => (
    <>
      <circle cx={50} cy={50} r={40} fill={p.accent} />
      <path d="M30 52 L44 66 L72 36" {...stroke(p.ink, 9)} />
    </>
  ),
  book: (p) => (
    <>
      {S("M10 24 C24 18 38 20 50 28 V86 C38 78 24 76 10 82 Z", "#F1E6D2")}
      {S("M90 24 C76 18 62 20 50 28 V86 C62 78 76 76 90 82 Z", "#E2D3B8")}
      <path d="M18 36 C28 32 36 34 42 38 M18 48 C28 44 36 46 42 50 M58 38 C64 34 72 32 82 36" {...stroke(alpha(p.ink, 0.3), 3)} />
    </>
  ),
  fish: (p) => (
    <>
      {S("M14 50 C30 26 62 26 76 50 C62 74 30 74 14 50 Z", p.warm)}
      {S("M74 50 L94 34 V66 Z", p.warm)}
      <circle cx={30} cy={46} r={4} fill={p.ink} />
    </>
  ),
  ship: (p) => (
    <>
      {S("M8 58 H92 L80 80 H20 Z", p.secondary)}
      <rect x={30} y={40} width={36} height={18} fill="#F1E6D2" />
      <rect x={52} y={26} width={8} height={14} fill="#596080" />
    </>
  ),
  battery: (p) => (
    <>
      <rect x={14} y={30} width={66} height={40} rx={8} fill="#2F3550" />
      <rect x={80} y={42} width={8} height={16} rx={3} fill="#2F3550" />
      <rect x={20} y={36} width={46} height={28} rx={4} fill={p.accent} />
    </>
  ),
  flame: (p) => (
    <>
      {S("M50 90 C26 90 18 70 26 54 C32 42 40 40 40 24 C54 32 60 44 58 56 C64 52 66 46 66 40 C78 52 80 66 74 76 C70 84 62 90 50 90 Z", p.warm)}
      {S("M50 88 C40 88 36 78 40 70 C44 62 50 62 50 54 C58 62 62 72 58 80 C56 86 54 88 50 88 Z", p.primary)}
    </>
  ),
};

export const iconIds = Object.keys(icons);

/** Draws an icon at `size` px. Accepts built-in ids and "file:<asset-id>" references. */
export const Icon: React.FC<{ id: string; p: Palette; size: number; style?: React.CSSProperties }> = ({ id, p, size, style }) => {
  if (id.startsWith("file:")) {
    const file = assetFile(id.slice(5));
    if (file) return <Img src={staticFile(file)} style={{ width: size, height: size, objectFit: "contain", ...style }} />;
    return <MissingAsset size={size} label={id} style={style} />;
  }
  const draw = icons[id];
  if (!draw) return <MissingAsset size={size} label={id} style={style} />;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: "visible", ...style }}>
      {draw(p)}
    </svg>
  );
};

/** Deliberately loud placeholder so a missing asset never looks finished. */
const MissingAsset: React.FC<{ size: number; label: string; style?: React.CSSProperties }> = ({ size, label, style }) => (
  <div style={{ width: size, height: size, border: "6px dashed #ff3355", color: "#ff3355", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.12, fontFamily: "monospace", textAlign: "center", ...style }}>
    MISSING {label}
  </div>
);
