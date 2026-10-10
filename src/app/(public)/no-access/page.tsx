import Link from "next/link";

export const metadata = { title: "No access" };

export default function NoAccessPage() {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="max-w-sm rounded-2xl border border-border bg-surface p-6 text-center">
        <h1 className="text-lg font-semibold">You do not have access to that page</h1>
        <p className="mt-2 text-sm text-muted">Your role does not include it. If you need it, ask an administrator.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-primary underline">
          Back to your home page
        </Link>
      </div>
    </div>
  );
}
