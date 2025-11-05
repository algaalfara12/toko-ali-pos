// apps/web/src/components/icons.tsx
export function IconShop({ size = 26, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 7h18l-1 10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2L3 7z"
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth="1.5"
      />
    </svg>
  );
}
export function IconCart({ size = 18, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 5h2l2.5 10h9l2-7H7" stroke={color} strokeWidth="1.5" />
      <circle cx="10" cy="20" r="1" fill={color} />
      <circle cx="17" cy="20" r="1" fill={color} />
    </svg>
  );
}
export function IconReturn({ size = 18, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M9 10l-4 4 4 4"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 14h9a5 5 0 1 0 0-10h-2" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
export function IconDoor({ size = 18, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect
        x="6"
        y="3"
        width="12"
        height="18"
        rx="2"
        stroke={color}
        strokeWidth="1.5"
      />
      <circle cx="14" cy="12" r="1" fill={color} />
    </svg>
  );
}
export function IconLogout({ size = 18, color = "#2563eb" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M16 17l5-5-5-5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M21 12h-9" stroke={color} strokeWidth="1.5" />
      <path d="M7 3h4a2 2 0 0 1 2 2v3" stroke={color} strokeWidth="1.5" />
      <path d="M7 21h4a2 2 0 0 0 2-2v-3" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
