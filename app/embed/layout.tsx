import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "StreamPay Stream Widget",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function EmbedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="min-h-screen bg-transparent">
      {children}
    </div>
  );
}