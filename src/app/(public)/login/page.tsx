import { redirect } from "next/navigation";
import { connection } from "next/server";
import { one, pool } from "@/lib/db";
import { env } from "@/lib/env";
import { safeNext } from "@/lib/session-cookie";
import { currentStaff } from "@/server/auth/guard";
import { LoginForm } from "./form";
import { quickLogin } from "./actions";

export const metadata = { title: "Sign in" };


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
        className="relative hidden overflow-hidden bg-primary-strong text-white lg:block"
        style={{ backgroundImage: "url(/clevo-brand.webp)", backgroundSize: "cover", backgroundPosition: "center" }}
        aria-label="Clevo hospital automation"
      >
        <div className="brand-float absolute inset-0" />
        <p className="absolute bottom-8 left-0 right-0 text-center text-xs tracking-wide text-white/75">{e.HOSPITAL_NAME}</p>
      </aside>

      <main className="flex items-center justify-center px-6 py-14">
        <div className="page-in w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/clevo-logo.png" alt="Clevo" width={48} height={48} className="logo-pop h-12 w-12" />
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
                      {[...(e.DEMO_QUICK_ADMIN_EMAIL ? [[e.DEMO_QUICK_ADMIN_EMAIL, "Admin"]] : []), ["reception@democare.test", "Reception"], ["doctor@democare.test", "Doctor"], ["nurse@democare.test", "Nurse"], ["pharmacy@democare.test", "Pharmacy"], ["billing@democare.test", "Billing"], ["radiology@democare.test", "Radiology"]].map(([k, label]) => (
                        <button key={k} name="email" value={k} className="rounded-full border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary">
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
