import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NIT Care Ops", template: "%s · NIT Care Ops" },
  description: "Hospital patient-lifecycle automation console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
