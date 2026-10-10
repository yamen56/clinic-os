/**
 * Who typed a patient in, as the desk knows them.
 *
 * "الموظفون" — the staff — told nobody anything: a clinic wants to know
 * whether the doctor or the receptionist opened the file, and which one. The
 * honorific goes before the name the way the clinic set it ("د. سارة"), and
 * the job after it ("طبيب", "موظف استقبال"); an owner with neither job title
 * is named as the clinic's manager. Someone who no longer works at the clinic
 * keeps their name and loses the job, which they no longer hold.
 */

export type AddedBy = {
  name: string;
  title: string | null;
  role: string | null;
  owner: boolean;
};

type Words = {
  staff: { roles: Record<string, string>; owner: string };
};

export function addedByName(a: AddedBy): string {
  const title = a.title?.trim();
  return title ? `${title} ${a.name}` : a.name;
}

export function addedByRole(a: AddedBy, t: Words): string | null {
  if (a.role === "doctor" || a.role === "receptionist") return t.staff.roles[a.role] ?? null;
  return a.owner ? t.staff.owner : null;
}

/** "د. سارة · طبيب", or just the name when they hold no job here. */
export function addedByLabel(a: AddedBy, t: Words): string {
  const role = addedByRole(a, t);
  return role ? `${addedByName(a)} · ${role}` : addedByName(a);
}
