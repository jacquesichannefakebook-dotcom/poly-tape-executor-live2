import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Poly Tape Executor",
  description: "Console privée de configuration, de contrôle et de suivi de l’exécution autonome Poly Tape.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body className="antialiased">{children}</body>
    </html>
  );
}
