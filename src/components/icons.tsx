import type { SVGProps } from "react";

/**
 * A small, consistent icon set: 20px grid, 1.6 stroke, round caps. Drawn for this product
 * rather than borrowed, so the metaphors fit a hospital (a bed, a pill, a receipt).
 */
type P = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  home: (p: P) => (
    <Icon {...p}>
      <path d="M3.5 9.2 10 3.8l6.5 5.4" />
      <path d="M5 8.4V16h10V8.4" />
      <path d="M8.5 16v-4h3v4" />
    </Icon>
  ),
  desk: (p: P) => (
    <Icon {...p}>
      <rect x="3" y="4" width="14" height="9" rx="2" />
      <path d="M7 16.5h6M10 13v3.5" />
      <path d="M6.5 8h4" />
    </Icon>
  ),
  stethoscope: (p: P) => (
    <Icon {...p}>
      <path d="M6 3.5v4.2a3.2 3.2 0 0 0 6.4 0V3.5" />
      <path d="M9.2 10.9v1.5a3.2 3.2 0 0 0 6.4 0v-1" />
      <circle cx="15.6" cy="9.6" r="1.4" />
    </Icon>
  ),
  pill: (p: P) => (
    <Icon {...p}>
      <rect x="2.8" y="7.2" width="14.4" height="5.6" rx="2.8" transform="rotate(-35 10 10)" />
      <path d="m7.7 7.7 4.6 4.6" />
    </Icon>
  ),
  receipt: (p: P) => (
    <Icon {...p}>
      <path d="M5 3.5h10v13l-2-1.3-1.5 1.3-1.5-1.3-1.5 1.3-1.5-1.3L5 16.5z" />
      <path d="M7.7 7.5h4.6M7.7 10.5h3" />
    </Icon>
  ),
  bed: (p: P) => (
    <Icon {...p}>
      <path d="M3 15.5V5M3 11.5h14v4M17 11.5v-1.8A2.2 2.2 0 0 0 14.8 7.5H9.5v4" />
      <circle cx="6.2" cy="8.7" r="1.5" />
    </Icon>
  ),
  inbox: (p: P) => (
    <Icon {...p}>
      <path d="M3.5 11.5 5.6 5a1.5 1.5 0 0 1 1.4-1h6a1.5 1.5 0 0 1 1.4 1l2.1 6.5" />
      <path d="M3.5 11.5V15a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-3.5h-3.6L11.5 13h-3L7.1 11.5z" />
    </Icon>
  ),
  calendar: (p: P) => (
    <Icon {...p}>
      <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
      <path d="M3.5 8.5h13M7 3v3M13 3v3" />
    </Icon>
  ),
  discharge: (p: P) => (
    <Icon {...p}>
      <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
      <path d="M12 6.5 15.5 10 12 13.5M15.5 10H8.5" />
    </Icon>
  ),
  bell: (p: P) => (
    <Icon {...p}>
      <path d="M5.5 8a4.5 4.5 0 0 1 9 0c0 3.2 1.2 4.4 1.7 5H3.8c.5-.6 1.7-1.8 1.7-5z" />
      <path d="M8.3 16a1.8 1.8 0 0 0 3.4 0" />
    </Icon>
  ),
  heart: (p: P) => (
    <Icon {...p}>
      <path d="M10 16.2S3.8 12.4 3.8 8a3 3 0 0 1 5.3-1.9L10 7l.9-.9A3 3 0 0 1 16.2 8c0 4.4-6.2 8.2-6.2 8.2z" />
    </Icon>
  ),
  chart: (p: P) => (
    <Icon {...p}>
      <path d="M3.5 16.5h13" />
      <path d="M5.5 16.5V11M10 16.5V5.5M14.5 16.5V9" />
    </Icon>
  ),
  document: (p: P) => (
    <Icon {...p}>
      <path d="M5.5 3.5h5.8L15 7.2v9.3H5.5z" />
      <path d="M11 3.7v3.8h3.8M8 11h4M8 13.5h4" />
    </Icon>
  ),
  alert: (p: P) => (
    <Icon {...p}>
      <path d="M10 4 3.7 15h12.6z" />
      <path d="M10 8.5v3M10 13.4v.1" />
    </Icon>
  ),
  chat: (p: P) => (
    <Icon {...p}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H5.5A1.5 1.5 0 0 1 4 11.5z" />
    </Icon>
  ),
  users: (p: P) => (
    <Icon {...p}>
      <circle cx="8" cy="7.5" r="2.7" />
      <path d="M3 16c.4-2.6 2.4-4 5-4s4.6 1.4 5 4" />
      <path d="M13 5.2a2.4 2.4 0 0 1 0 4.6M14.6 12.4c1.3.5 2.1 1.6 2.4 3.6" />
    </Icon>
  ),
  link: (p: P) => (
    <Icon {...p}>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l.8-.8" />
    </Icon>
  ),
  empty: (p: P) => (
    <Icon {...p}>
      <rect x="3.5" y="5" width="13" height="10.5" rx="2" />
      <path d="M3.5 9.5h4l1 1.8h3l1-1.8h4" />
    </Icon>
  ),
  check: (p: P) => (
    <Icon {...p}>
      <path d="m4.5 10.5 3.4 3.4 7.6-8" />
    </Icon>
  ),
} as const;

export type IconName = keyof typeof Icons;
