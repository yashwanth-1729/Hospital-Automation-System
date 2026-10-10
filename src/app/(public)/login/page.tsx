import { redirect } from "next/navigation";
import { connection } from "next/server";
import { one, pool } from "@/lib/db";
import { env } from "@/lib/env";
import { safeNext } from "@/lib/session-cookie";
import { currentStaff } from "@/server/auth/guard";
import { LoginForm } from "./form";

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
    <div className="min-h-screen bg-gradient-to-b from-primary-soft to-bg">
      <div className="mx-auto max-w-sm px-4 py-16">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-primary text-xl font-bold text-white">N</div>
          <h1 className="text-xl font-semibold tracking-tight">NIT Care Ops</h1>
          <p className="mt-1 text-sm text-muted">{e.HOSPITAL_NAME}</p>
        </header>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          {noAccounts ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium">No staff accounts exist yet.</p>
              <p className="text-muted">Create the first administrator on the server:</p>
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
                npm run user:create -- --role admin --name &quot;Your Name&quot; --email you@hospital.com
              </pre>
            </div>
          ) : (
            <LoginForm next={target} />
          )}
        </div>
        <p className="mt-6 text-center text-xs text-muted">Authorised staff only. Activity is recorded.</p>
      </div>
    </div>
  );
}
