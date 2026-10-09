import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WindowFusion",
  description: "Multi-window 3D particle simulation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" style={{ background: "#000000" }}>
      <body style={{ margin: 0, padding: 0, background: "#000000", overflow: "hidden" }}>
        {children}
      </body>
    </html>
  );
}
