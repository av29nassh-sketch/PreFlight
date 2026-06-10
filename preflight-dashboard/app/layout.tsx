import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
