/**
 * Unlike a layout, a template remounts on every navigation, so the entrance animation in
 * globals.css plays each time a page changes rather than only on first load.
 */
export default function StaffTemplate({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
