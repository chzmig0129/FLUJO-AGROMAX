import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgroMax Ingesta',
  description: 'Etapa 1 del pipeline AgroMax: ingesta de videos crudos (ZIP → job estructurado)',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
