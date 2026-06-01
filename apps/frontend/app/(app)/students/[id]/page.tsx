import type { Metadata } from 'next';
import StudentDetailClient from '@/features/students/StudentDetailClient';

// Next 15: dynamic route segment props (params, searchParams) are Promises.
type PageProps = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: 'Student',
};

export default async function StudentDetailPage({ params }: PageProps) {
  const { id } = await params;
  return <StudentDetailClient id={id} />;
}
