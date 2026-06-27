import "./globals.css";
import { Analytics } from "@vercel/analytics/next";

export const metadata = {
  title: "PreFlight Dashboard",
  description: "Governance dashboard for PreFlight telemetry."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
