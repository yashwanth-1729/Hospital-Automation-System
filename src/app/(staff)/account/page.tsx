import { connection } from "next/server";
import { Card, PageHeader } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/rbac";
import { requireStaff } from "@/server/auth/guard";
import { PasswordForm } from "./form";

export const metadata = { title: "My account" };

export default async function AccountPage() {
  await connection();
  const user = await requireStaff(undefined, { allowPasswordChange: true });

  return (
    <>
      <PageHeader title="My account" description={`${user.full_name} · ${ROLE_LABEL[user.role]} · ${user.email}`} />
      {user.must_change_password && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          You are using a temporary password. Choose your own to continue.
        </div>
      )}
      <Card title="Change password" className="max-w-md">
        <div className="p-4">
          <PasswordForm />
        </div>
      </Card>
    </>
  );
}
