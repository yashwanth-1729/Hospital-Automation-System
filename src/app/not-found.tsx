import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="max-w-sm text-center">
        <div className="num text-6xl font-semibold tracking-tight text-primary">404</div>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">That page is not here</h1>
        <p className="mt-2 text-sm text-muted">The link may be old, or the record may have been removed.</p>
        <Link href="/" className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white">
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}
