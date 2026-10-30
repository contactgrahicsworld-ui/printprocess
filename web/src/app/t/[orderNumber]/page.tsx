import TrackView from "@/components/track/TrackView";

export const dynamic = "force-dynamic";

export default async function TrackOrderPage({ params, searchParams }: { params: Promise<{ orderNumber: string }>; searchParams: Promise<{ k?: string; new?: string }> }) {
  const { orderNumber } = await params;
  const sp = await searchParams;
  return <TrackView orderNumber={decodeURIComponent(orderNumber)} token={sp.k ?? ""} isNew={sp.new === "1"} />;
}
