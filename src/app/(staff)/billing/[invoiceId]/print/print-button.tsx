"use client";

export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 print:hidden">
      Print
    </button>
  );
}
