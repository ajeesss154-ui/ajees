import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AURA · Your personal operating space",
  description:
    "A private, purposeful workspace for your ideas, tasks, and personal AI.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
