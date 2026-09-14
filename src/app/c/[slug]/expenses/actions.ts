"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { deleteFile } from "@/lib/storage";
import { z } from "zod";
import type { PoolClient } from "pg";

/** What a clinic can pay a bill with. Not a mirror of how patients pay us —
 *  nobody settles rent by CliQ and nobody writes a patient a cheque. */
const METHODS = ["cash", "cliq", "card", "transfer", "cheque"] as const;

const expenseSchema = z.object({
  id: z.string().uuid().optional(),
  categoryId: z.string().uuid().nullable().default(null),
  amount: z.coerce.number().positive().max(1_000_000),
  vendor: z.string().max(120).optional().default(""),
  note: z.string().max(500).optional().default(""),
  /** A calendar day, not an instant — see the column comment in 0050. */
  spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(METHODS).default("cash"),
});

const categorySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  nameAr: z.string().max(60).optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  active: z.boolean().optional().default(true),
});

const scheduleSchema = z.object({
  id: z.string().uuid().optional(),
  categoryId: z.string().uuid().nullable().default(null),
  amount: z.coerce.number().positive().max(1_000_000),
  vendor: z.string().max(120).optional().default(""),
  note: z.string().max(500).optional().default(""),
  method: z.enum(METHODS).default("transfer"),
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  active: z.boolean().optional().default(true),
});

/**
 * Does this category belong to the clinic doing the writing?
 *
 * By hand rather than left to the foreign key, for the reason `sectionBelongs`
 * exists: FK validation runs as the table owner and bypasses row-level
 * security, so an id forged from another clinic satisfies the constraint.
 */
async function categoryBelongs(
  c: PoolClient,
  clinicId: string,
  categoryId: string | null
): Promise<boolean> {
  if (!categoryId) return true;
  const r = await c.query(`select 1 from expense_categories where id = $1 and clinic_id = $2`, [
    categoryId,
    clinicId,
  ]);
  return !!r.rowCount;
}

/**
 * Returns the id so the caller can attach a receipt to an expense it has just
 * created. The upload is addressed by id and the row has to exist first, which
 * is also the order it happens at a desk: write down what you paid, then pin the
 * bill to it.
 */
export async function saveExpenseAction(
  slug: string,
  data: unknown
): Promise<{ error?: string; id?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };
  const parsed = expenseSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    if (!(await categoryBelongs(c, access.clinicId, d.categoryId))) return { error: "invalid" };

    let id = d.id;
    if (id) {
      /*
        A posted row keeps its `schedule_id` through an edit. The rule produced
        it and that is history; what the clinic actually paid this month is the
        correction being typed now.
      */
      const r = await c.query(
        `update expenses set category_id = $3, amount = $4, vendor = $5, note = $6,
                             spent_on = $7::date, method = $8
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, d.categoryId, d.amount, d.vendor.trim(), d.note.trim(), d.spentOn, d.method]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into expenses (clinic_id, category_id, amount, vendor, note, spent_on, method, created_by)
         values ($1, $2, $3, $4, $5, $6::date, $7, $8) returning id`,
        [access.clinicId, d.categoryId, d.amount, d.vendor.trim(), d.note.trim(), d.spentOn, d.method, access.session.user.id]
      );
      id = r.rows[0].id as string;
    }

    /*
      Audited, unlike a service edit. This is money: somebody deleting or
      rewriting a four-thousand expense leaves no other trace, and "who changed
      the books" is the question an audit log exists to answer.
    */
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "expense.update" : "expense.create",
      entity: "expense",
      entityId: id!,
      detail: { amount: d.amount, vendor: d.vendor.trim(), spentOn: d.spentOn },
    });
    revalidatePath(`/c/${slug}/expenses`);
    return { id };
  });
}

export async function deleteExpenseAction(slug: string, id: string): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    // Amount captured before the row goes, so the audit entry says what was
    // removed rather than only that something was.
    const r = await c.query(
      `delete from expenses where id = $1 and clinic_id = $2
       returning amount, vendor, spent_on, receipt_path`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "not_found" };
    const row = r.rows[0];

    // Row first, bytes second, and only if the row really went — the same order
    // `deletePatientFileAction` uses.
    if (row.receipt_path) await deleteFile(row.receipt_path as string);

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "expense.delete",
      entity: "expense",
      entityId: id,
      detail: { amount: Number(row.amount), vendor: row.vendor },
    });
    revalidatePath(`/c/${slug}/expenses`);
    return {};
  });
}

export async function saveExpenseCategoryAction(
  slug: string,
  data: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };
  const parsed = categorySchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const name = d.name.trim().replace(/\s+/g, " ");
  if (!name) return { error: "invalid" };

  return inClinic(access, async (c) => {
    // One spelling per clinic: two categories called "Supplies" are a filing
    // system nobody can use, and a breakdown with the same word twice in it.
    const taken = await c.query(
      `select 1 from expense_categories
        where clinic_id = $1 and lower(name) = lower($2) and ($3::uuid is null or id <> $3)`,
      [access.clinicId, name, d.id ?? null]
    );
    if (taken.rowCount) return { error: "duplicate" };

    let id = d.id;
    if (id) {
      const r = await c.query(
        `update expense_categories set name = $3, name_ar = $4, color = $5, active = $6
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, name, d.nameAr.trim() || null, d.color, d.active]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      const r = await c.query(
        `insert into expense_categories (clinic_id, name, name_ar, color, active, sort)
         values ($1, $2, $3, $4, $5,
           (select coalesce(max(sort), 0) + 10 from expense_categories where clinic_id = $1))
         returning id`,
        [access.clinicId, name, d.nameAr.trim() || null, d.color, d.active]
      );
      id = r.rows[0].id as string;
    }
    revalidatePath(`/c/${slug}/expenses`);
    return {};
  });
}

export async function deleteExpenseCategoryAction(
  slug: string,
  id: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    /*
      The spend survives. `expenses.category_id` is `on delete set null`, so
      removing a category drops its expenses into the unfiled group rather than
      destroying them — the same thing deleting a service section does, and for
      the same reason: filing is a decision about labels, not about money.
    */
    const r = await c.query(`delete from expense_categories where id = $1 and clinic_id = $2`, [
      id,
      access.clinicId,
    ]);
    if (!r.rowCount) return { error: "not_found" };
    revalidatePath(`/c/${slug}/expenses`);
    return {};
  });
}

export async function saveExpenseScheduleAction(
  slug: string,
  data: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };
  const parsed = scheduleSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    if (!(await categoryBelongs(c, access.clinicId, d.categoryId))) return { error: "invalid" };

    let id = d.id;
    if (id) {
      const r = await c.query(
        `update expense_schedules set category_id = $3, amount = $4, vendor = $5, note = $6,
                                      method = $7, day_of_month = $8, active = $9
          where id = $1 and clinic_id = $2`,
        [id, access.clinicId, d.categoryId, d.amount, d.vendor.trim(), d.note.trim(), d.method, d.dayOfMonth, d.active]
      );
      if (!r.rowCount) return { error: "not_found" };
    } else {
      /*
        `last_posted_on` starts at today, which reads as "this month is already
        handled". A rule created on the 14th for "the 1st" would otherwise post
        immediately — a rent the clinic has almost certainly already entered by
        hand, appearing the moment they finish describing it. The editor says
        when it next posts, so the wait is visible rather than surprising.
      */
      const r = await c.query(
        `insert into expense_schedules
           (clinic_id, category_id, amount, vendor, note, method, day_of_month, active, last_posted_on, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 ((now() at time zone (select timezone from clinics where id = $1)))::date, $9)
         returning id`,
        [access.clinicId, d.categoryId, d.amount, d.vendor.trim(), d.note.trim(), d.method, d.dayOfMonth, d.active, access.session.user.id]
      );
      id = r.rows[0].id as string;
    }

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: d.id ? "expense_schedule.update" : "expense_schedule.create",
      entity: "expense_schedule",
      entityId: id!,
      detail: { amount: d.amount, vendor: d.vendor.trim(), dayOfMonth: d.dayOfMonth },
    });
    revalidatePath(`/c/${slug}/expenses`);
    return {};
  });
}

export async function deleteExpenseScheduleAction(
  slug: string,
  id: string
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "expenses")) return { error: "forbidden" };

  return inClinic(access, async (c) => {
    /*
      The rows it already posted stay. `expenses.schedule_id` is
      `on delete set null`: stopping a rule is a statement about the future, not
      a claim that last month's rent never left the account.
    */
    const r = await c.query(
      `delete from expense_schedules where id = $1 and clinic_id = $2 returning vendor, amount`,
      [id, access.clinicId]
    );
    if (!r.rowCount) return { error: "not_found" };

    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "expense_schedule.delete",
      entity: "expense_schedule",
      entityId: id,
      detail: { vendor: r.rows[0].vendor, amount: Number(r.rows[0].amount) },
    });
    revalidatePath(`/c/${slug}/expenses`);
    return {};
  });
}
