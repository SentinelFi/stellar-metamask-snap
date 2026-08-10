/**
 * The Stellar Soroban Snap mark: the snap's icon (Stellar slashed-circle in
 * gold on navy), matching packages/snap/images/icon.svg.
 *
 * @param props - Component props.
 * @param props.size - Rendered size in pixels.
 * @returns The logo SVG.
 */
export const SnapLogo = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 100 100"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="snap-logo-bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#101d3c" />
        <stop offset="1" stopColor="#1c1240" />
      </linearGradient>
      <mask id="snap-logo-cut">
        <rect x="0" y="0" width="100" height="100" fill="white" />
        <rect
          x="4"
          y="39"
          width="92"
          height="22"
          fill="black"
          transform="rotate(-30 50 50)"
        />
      </mask>
    </defs>
    <circle cx="50" cy="50" r="50" fill="url(#snap-logo-bg)" />
    <circle
      cx="50"
      cy="50"
      r="24"
      fill="none"
      stroke="#f5b32a"
      strokeWidth="5.5"
      mask="url(#snap-logo-cut)"
    />
    <g transform="rotate(-30 50 50)">
      <rect x="8" y="41.5" width="84" height="5.5" rx="2.75" fill="#f5b32a" />
      <rect x="8" y="53" width="84" height="5.5" rx="2.75" fill="#f5b32a" />
    </g>
  </svg>
);
