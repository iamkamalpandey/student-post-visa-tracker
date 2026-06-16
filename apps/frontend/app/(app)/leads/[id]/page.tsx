import type { Metadata } from 'next';
import DetailClient from './DetailClient';

type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: 'Lead',
};

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  return <DetailClient id={id} />;
}
