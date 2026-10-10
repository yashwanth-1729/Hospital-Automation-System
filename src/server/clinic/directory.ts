import { many, type Db } from "@/lib/db";

export interface DoctorOption {
  doctor_id: string;
  full_name: string;
  department_id: string;
  department: string;
}

/** Doctors currently seeing patients, grouped sensibly for a select box. */
export async function listActiveDoctors(db: Db): Promise<DoctorOption[]> {
  return many<DoctorOption>(
    db,
    `SELECT d.doctor_id, d.full_name, d.department_id, dep.name AS department
       FROM doctors d JOIN departments dep ON dep.department_id = d.department_id
      WHERE d.active AND dep.active
      ORDER BY dep.name, d.full_name`,
  );
}
