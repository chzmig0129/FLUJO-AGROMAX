import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgroMax · Ingesta',
  description: 'Etapa 1 del pipeline AgroMax: ingesta de videos crudos (ZIP → job estructurado)',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            <Image
              src="/agromax-logo.png"
              alt="AgroMax"
              width={36}
              height={36}
              className="brand-logo"
              priority
            />
            <span className="brand-text">
              <span className="brand-name">AgroMax</span>
              <span className="brand-subtitle">Ingesta de cursos</span>
            </span>
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
