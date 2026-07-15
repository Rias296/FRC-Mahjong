import type { Metadata } from "next";
import { Russo_One, Chakra_Petch, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const russoOne = Russo_One({
  weight: "400",
  variable: "--font-russo-one",
  subsets: ["latin"],
});

const chakraPetch = Chakra_Petch({
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-chakra-petch",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Taiwan Mahjong FRC",
  description: "Taiwanese 16-tile mahjong, FRC-robotics themed, realtime multiplayer.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${russoOne.variable} ${chakraPetch.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
