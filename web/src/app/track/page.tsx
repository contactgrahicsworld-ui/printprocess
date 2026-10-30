import TrackForm from "@/components/track/TrackForm";

export default function TrackPage() {
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-bold">Track order / Order dekhein</h1>
      <p className="mb-4 text-slate-600">Enter the order number and the tracking code from your confirmation.</p>
      <TrackForm />
    </main>
  );
}
