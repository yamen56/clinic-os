"use client";

/*
  The desk's To do: what the clinic's automations asked a person to do — call
  back a patient who replied "2" to a reminder, chase one who never confirmed,
  approve a booking. Ticked off here; a new one appears on its own.
*/

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ListTodo } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card, CardHeader } from "@/components/ui/card";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { fmtRelative } from "@/lib/dates";
import { completeTaskAction } from "./tasks-actions";

export type TodoRow = { id: string; title: string; body: string; patient_id: string | null; patient_name: string | null; created_at: string };

export function TodoCard({ slug, rows, canOpenPatient }: { slug: string; rows: TodoRow[]; canOpenPatient: boolean }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  // A ticked task stays hidden while the page re-reads; the fresh list no longer has it.
  useRealtimeRefresh(slug, ["tasks"], () => router.refresh());
  const shown = rows.filter((r) => !gone.has(r.id));
  if (shown.length === 0) return null;

  const done = async (id: string) => {
    setGone((g) => new Set(g).add(id));
    const r = await completeTaskAction(slug, id);
    if (r.error) {
      setGone((g) => {
        const n = new Set(g);
        n.delete(id);
        return n;
      });
      toast(t.common.genericError, "error");
    }
  };

  return (
    <div data-todo-card>
      <Card>
        <CardHeader title={`${t.dashboard.todo} · ${shown.length}`} />
        <ul className="divide-y divide-line">
          {shown.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-5 py-3" data-todo={r.id}>
              <ListTodo className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
              <div className="min-w-0 flex-1">
                <div dir="auto" className="text-sm font-medium">
                  {r.title}
                </div>
                <div className="flex flex-wrap gap-x-2 text-[12.5px] text-ink-500">
                  {r.body && <span dir="auto">{r.body}</span>}
                  {r.patient_id && r.patient_name && canOpenPatient && (
                    <Link href={`/c/${slug}/patients/${r.patient_id}`} className="font-semibold text-brand-700 hover:underline">
                      {r.patient_name}
                    </Link>
                  )}
                  <span suppressHydrationWarning>{fmtRelative(r.created_at, locale)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void done(r.id)}
                className="inline-flex h-9 shrink-0 touch-manipulation items-center gap-1 rounded-full border border-line-strong px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-sunken"
                data-todo-done
              >
                <Check className="h-3.5 w-3.5" />
                {t.dashboard.todoDone}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
