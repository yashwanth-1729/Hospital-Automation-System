import { connection } from "next/server";
import { Badge, Card, PageHeader, Td, Th } from "@/components/ui";
import { many, pool } from "@/lib/db";
import { ROLE_LABEL } from "@/lib/rbac";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/guard";
import { listStaff } from "@/server/auth/users";
import { CreateUserForm, UserRowActions } from "./forms";

export const metadata = { title: "Staff accounts" };

export default async function UsersPage() {
  await connection();
  const me = await requireStaff("users.manage");
  const [staff, doctors] = await Promise.all([
    listStaff(pool()),
    many<{ doctor_id: string; full_name: string; department: string }>(
      pool(),
      `SELECT d.doctor_id, d.full_name, dep.name AS department
         FROM doctors d JOIN departments dep ON dep.department_id = d.department_id
        WHERE d.active ORDER BY dep.name, d.full_name`,
    ),
  ]);
  const taken = new Set(staff.filter((s) => s.doctor_id).map((s) => s.doctor_id));

  return (
    <>
      <PageHeader
        title="Staff accounts"
        description="Everyone signs in as themselves. What they can see and do follows their role, and what they do is recorded under their name."
      />
      <div className="grid gap-6">
        <Card title="Add a person">
          <CreateUserForm doctors={doctors.map((d) => ({ ...d, taken: taken.has(d.doctor_id) }))} />
        </Card>
        <Card title={`${staff.length} account${staff.length === 1 ? "" : "s"}`}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Person</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Last sign-in</Th>
                  <Th>Manage</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {staff.map((u) => (
                  <tr key={u.user_id} className="hover:bg-surface-2">
                    <Td>
                      <div className="font-medium">{u.full_name}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </Td>
                    <Td>
                      {ROLE_LABEL[u.role]}
                      {u.doctor_name && <div className="text-xs text-muted">{u.doctor_name}</div>}
                    </Td>
                    <Td>
                      {u.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Deactivated</Badge>}{" "}
                      {u.must_change_password && <Badge tone="warn">Temporary password</Badge>}
                    </Td>
                    <Td className="num text-xs text-muted">{u.last_login_at ? formatDateTime(u.last_login_at) : "never"}</Td>
                    <Td>
                      <UserRowActions userId={u.user_id} email={u.email} role={u.role} active={u.active} isSelf={u.user_id === me.user_id} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
