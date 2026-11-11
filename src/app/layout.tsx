import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

// واجهة عربية RTL من أول لحظة مع خط عربي جيد
const cairo = Cairo({ subsets: ["arabic", "latin"], variable: "--font-cairo", display: "swap" });

export const metadata: Metadata = {
  title: "مولّد الوسائط — خادم MCP",
  description: "توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — خادم MCP مع لوحة إدارة عربية",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className={`${cairo.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
