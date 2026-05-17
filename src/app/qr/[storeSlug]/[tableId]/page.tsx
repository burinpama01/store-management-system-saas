interface QrOrderPageProps {
  params: Promise<{ storeSlug: string; tableId: string }>;
}

export default async function QrOrderPage({ params }: QrOrderPageProps) {
  const { storeSlug, tableId } = await params;

  return (
    <main className="min-h-screen bg-white px-4 py-6 max-w-sm mx-auto">
      <h1 className="text-lg font-semibold text-gray-900 mb-2">Order Menu</h1>
      <p className="text-sm text-gray-500 mb-4">
        Store: {storeSlug} · Table: {tableId}
      </p>
      {/* QR ordering UI — Package I */}
      <p className="text-sm text-gray-400">QR order flow coming in Package I</p>
    </main>
  );
}
