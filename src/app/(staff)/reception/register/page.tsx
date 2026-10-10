import Link from "next/link";
import { connection } from "next/server";
import { Card, PageHeader } from "@/components/ui";
import { pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { requireStaff } from "@/server/auth/guard";
import { listActiveDoctors } from "@/server/clinic/directory";
import { RegisterForm } from "./form";

export const metadata = { title: "Register patient" };

export default async function RegisterPage() {
  await connection();
  const user = await requireStaff("patients.register");
  const doctors = can(user.role, "queue.manage") ? await listActiveDoctors(pool()) : [];

  return (
    <>
      <PageHeader
        title="Register patient"
        description="A mobile number already on file opens that patient instead of making a duplicate; only blank details are filled in."
        actions={
          <Link href="/reception" className="text-sm text-muted hover:text-text">
            Back to reception
          </Link>
        }
      />
      <Card className="max-w-3xl">
        <div className="p-5">
          <RegisterForm doctors={doctors} />
        </div>
      </Card>
    </>
  );
}
