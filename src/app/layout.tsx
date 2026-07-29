import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import localFont from 'next/font/local';
import './globals.css';

/**
 * Poppins cargada LOCAL desde los .ttf versionados en remotion/fonts (los
 * mismos de la intro de las clases): la UI no depende de internet y usa la
 * misma tipografía de marca que el video.
 */
const poppins = localFont({
  src: [
    { path: '../../remotion/fonts/Poppins-Regular.ttf', weight: '400' },
    { path: '../../remotion/fonts/Poppins-SemiBold.ttf', weight: '600' },
    { path: '../../remotion/fonts/Poppins-Bold.ttf', weight: '700' },
  ],
  variable: '--font-poppins',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AgroMax · Estudio de cursos',
  description:
    'Pipeline AgroMax: del ZIP de videos crudos al curso entregado, paso a paso',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={poppins.variable}>
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            <Image
              src="/agromax-logo.png"
              alt="AgroMax"
              width={38}
              height={38}
              className="brand-logo"
              priority
            />
            <span className="brand-text">
              <span className="brand-name">AgroMax</span>
              <span className="brand-subtitle">Estudio de cursos</span>
            </span>
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
