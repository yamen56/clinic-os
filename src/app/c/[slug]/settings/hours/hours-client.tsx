"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { Card, CardHeader } from "@/components/ui/card";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { WeeklyHoursEditor } from "@/components/weekly-hours-editor";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function HoursClient({
  slug,
  isOwner,
  initialHours,
  initialBlocked,
}: {
  slug: string;
  isOwner: boolean;
  initialHours: Record<string, [string, string][]>;
  initialBlocked: string[];
}) {
  const { t } = useI18n();
  const [hours, setHours] = useState(initialHours);
  const [blocked, setBlocked] = useState<string[]>(initialBlocked ?? []);
  const [newDate, setNewDate] = useState("");
  const { patch, state } = useAutosave({ url: `/api/c/${slug}/clinic`, entityKey: `hours:${slug}` });

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card>
        <CardHeader title={t.hours.title} sub={t.hours.sub} action={<SaveIndicator state={state} />} />
        <div className="p-5">
          <WeeklyHoursEditor
            value={hours}
            disabled={!isOwner}
            onChange={(v) => {
              setHours(v);
              patch({ working_hours: v });
            }}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title={t.hours.blockedDates} sub={t.hours.blockedSub} />
        <div className="flex flex-wrap items-center gap-2 p-5">
          {blocked.map((d) => (
            <span key={d} className="flex items-center gap-1.5 rounded-full bg-danger-soft px-3 py-1 text-[13px] font-medium text-danger tnum">
              {d}
              {isOwner && (
                <button
                  aria-label={t.common.delete}
                  onClick={() => {
                    const next = blocked.filter((x) => x !== d);
                    setBlocked(next);
                    patch({ blocked_dates: next });
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          ))}
          {isOwner && (
            // A native date input plus its button is wider than a 320px phone
            // once the day chips are beside them, so let the pair wrap.
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="!w-auto min-w-0 max-w-full"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!newDate || blocked.includes(newDate)}
                onClick={() => {
                  const next = [...blocked, newDate].sort();
                  setBlocked(next);
                  setNewDate("");
                  patch({ blocked_dates: next });
                }}
              >
                {t.hours.addBlocked}
              </Button>
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
