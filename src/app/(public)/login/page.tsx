import { redirect } from "next/navigation";
import { connection } from "next/server";
import { one, pool } from "@/lib/db";
import { env } from "@/lib/env";
import { safeNext } from "@/lib/session-cookie";
import { currentStaff } from "@/server/auth/guard";
import { LoginForm } from "./form";
import { quickLogin } from "./actions";

export const metadata = { title: "Sign in" };

const POINTS = [
  ["One record, from the front desk to the ward", "Registration, consultation, pharmacy and billing share the same patient."],
  ["Every action has a name on it", "Each change is recorded against the person who made it."],
  ["Patients are kept informed", "Tokens, receipts and follow-ups go out on WhatsApp without anyone typing them."],
] as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await connection();
  const { next } = await searchParams;
  const target = safeNext(next);
  if (await currentStaff()) redirect(target);

  const e = env();
  const accounts = await one<{ n: number }>(pool(), `SELECT count(*)::int AS n FROM staff_users`);
  const noAccounts = (accounts?.n ?? 0) === 0;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel: a deep wash of the one accent colour, with a quiet grid for texture. */}
      <aside
        className="relative hidden overflow-hidden bg-primary-strong p-12 text-white lg:flex lg:flex-col lg:justify-between"
        style={{
          backgroundImage:
            "radial-gradient(900px 500px at 10% -10%, rgba(255,255,255,0.16), transparent 60%), radial-gradient(700px 500px at 100% 110%, rgba(0,0,0,0.35), transparent 60%), linear-gradient(160deg, #0f766e, #0a4d47)",
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.7) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse at 30% 30%, black, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 30% 30%, black, transparent 75%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/clevo-logo.png" alt="" width={40} height={40} className="h-10 w-10 rounded-xl ring-1 ring-white/25" />
          <span className="text-lg font-semibold tracking-tight">Clevo</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-4xl leading-[1.1] font-semibold tracking-[-0.025em] text-balance">The whole patient journey, in one calm place.</h2>
          <ul className="stagger mt-10 space-y-6">
            {POINTS.map(([title, body]) => (
              <li key={title} className="flex gap-4">
                <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/15 ring-1 ring-white/25">
                  <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m4.5 10.5 3.4 3.4 7.6-8" />
                  </svg>
                </span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="block text-sm text-white/70">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/60">{e.HOSPITAL_NAME}</p>
      </aside>

      <main className="flex items-center justify-center px-6 py-14">
        <div className="page-in w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-white shadow-[var(--shadow-md)]">
              <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                <path d="M10 4v12M4 10h12" />
              </svg>
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.025em]">Sign in</h1>
          <p className="mt-2 text-sm text-muted">{e.HOSPITAL_NAME}</p>

          <div className="mt-8">
            {noAccounts ? (
              <div className="space-y-3 rounded-2xl border border-border bg-surface p-5 text-sm shadow-[var(--shadow-sm)]">
                <p className="font-medium">No staff accounts exist yet.</p>
                <p className="text-muted">Create the first administrator on the server:</p>
                <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
                  npm run user:create -- --role admin --name &quot;Your Name&quot; --email you@hospital.com
                </pre>
              </div>
            ) : (
              <>
                <LoginForm next={target} />
                {e.DEMO_QUICK_LOGIN === "1" && (
                  <form action={quickLogin} className="mt-6 border-t border-border pt-5">
                    <input type="hidden" name="next" value={target} />
                    <p className="mb-2 text-xs text-muted">Demo: sign in without a password as</p>
                    <div className="flex flex-wrap gap-2">
                      {[["reception", "Reception"], ["doctor", "Doctor"], ["nurse", "Nurse"], ["pharmacy", "Pharmacy"], ["billing", "Billing"], ["radiology", "Radiology"]].map(([k, label]) => (
                        <button key={k} name="email" value={`${k}@democare.test`} className="rounded-full border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary">
                          {label}
                        </button>
                      ))}
                    </div>
                  </form>
                )}
              </>
            )}
          </div>
          <p className="mt-10 text-xs text-muted">Authorised staff only. Activity is recorded.</p>
        </div>
      </main>
    </div>
  );
}
