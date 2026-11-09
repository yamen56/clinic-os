import type { WeeklyHours } from "@/lib/hours";
import type { IntakeAnswer } from "@/lib/booking-intake";
import type { VisitLine } from "@/lib/charts/dental/treatment";
import type { MedicalFlags } from "@/lib/medical-history";

/** One appointment, as GET /api/c/[slug]/appointments returns it. */
export type Appt = {
  id: string;
  patient_id: string;
  doctor_member_id: string | null;
  service_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  notes: string;
  /** Answers to the clinic's booking questions, frozen at booking time. */
  intake_answers: IntakeAnswer[];
  patient_name: string;
  patient_phone: string | null;
  service_name: string | null;
  service_name_ar: string | null;
  service_color: string | null;
  service_section_id: string | null;
  service_location?: string | null;
  doctor_color: string | null;
  doctor_name: string | null;
  /** The room it takes (migration 0078), and the patient's way through the clinic today. */
  room_id?: string | null;
  room_name?: string | null;
  room_name_ar?: string | null;
  room_color?: string | null;
  arrived_at?: string | null;
  seated_at?: string | null;
  finished_at?: string | null;
  /** What Finish or Didn't come replaced — set means the board can undo it. */
  flow_prev_status?: string | null;
  walk_in?: boolean;
  first_visit?: boolean;
  /** The planned treatments this visit is for. */
  items?: PlannedItem[];
  /** What was done at this visit, from the dental chart: one line per treatment, with its steps done there. */
  done?: VisitLine[];
  /** What the patient still owes on their invoices — sent only to a member who may see invoices, and only when above 0. */
  balance_due?: number;
  /** Allergies and the conditions that change what may be done; null when there are none. */
  medical?: MedicalFlags | null;
  /** The invoice that bills a finished visit — sent only to a member who may see invoices. */
  invoice?: { id: string; number: string; paid: boolean };
  /** The doctor's hand-off on finishing (migration 0088): when, how long and with whom next, and a line for the desk. */
  next_visit_days?: number | null;
  next_visit_min?: number | null;
  next_visit_member_id?: string | null;
  desk_note?: string;
  handed_off_at?: string | null;
  /** Finish said no further visit is needed (0103). */
  next_visit_none?: boolean;
  /** The patient's next visit after this one, if one is booked — what a finished card reports. */
  next_booked_at?: string | null;
  /** The booked service's length — what a next visit takes unless the hand-off says otherwise. */
  service_duration_min?: number | null;
  /** How late the patient said they would be, or were (migration 0089). */
  late_min?: number | null;
  /** When this patient was told the doctor's day is running behind. */
  delay_notice_at?: string | null;
};

/** A treatment on the patient's plan, as a visit carries it. */
export type PlannedItem = { markId: string; site: string; label: string; labelAr?: string; next?: string | null };

export type Doctor = {
  id: string;
  name: string;
  color: string;
  title: string | null;
  specialty: string | null;
  working_hours: WeeklyHours | null;
  default_room_id?: string | null;
};

export type Service = {
  id: string;
  name: string;
  name_ar: string | null;
  duration_min: number;
  price: string;
  color: string;
  buffer_after_min: number;
  section_id: string | null;
  location_kind?: string | null;
};

export type Section = { id: string; name: string; name_ar: string | null };

export type Room = { id: string; name: string; name_ar: string | null; color: string; serviceIds: string[] };

export type CalendarData = {
  appointments: Appt[];
  doctors: Doctor[];
  services: Service[];
  sections: Section[];
  rooms: Room[];
  clinicHours: WeeklyHours;
  blockedDates: string[];
  /** Upcoming in-person visits with no room, in a clinic that has rooms. */
  unroomed: number;
  /** The clinic's currency, for what a patient owes on the board. */
  currency?: string;
  serverNow: string;
};

/** The shared parts of CalendarData every tab and the panel need. */
export type CalendarMeta = Omit<CalendarData, "appointments" | "serverNow">;

export type ScheduleView = "day" | "week" | "month" | "list";

/** The Schedule tab's own state, kept by the page so a tab switch does not lose it. */
export type ScheduleState = {
  view: ScheduleView;
  anchor: string;
  doctorFilter: string;
  serviceFilter: string;
  sectionFilter: string;
  colorBy: "service" | "doctor";
  /** Day view columns: one per doctor, or one per room. */
  groupBy: "doctor" | "room";
  /** Only the visits nobody has confirmed yet — the list reception calls through. */
  unconfirmedOnly: boolean;
};

/** Booked but not confirmed: what "unconfirmed" means on the dashboard, the evening alert and the Schedule. */
export const UNCONFIRMED = new Set(["scheduled", "pending_approval"]);

export type Tab = "today" | "schedule" | "waitlist";

/** What the person looking at the page may also open, to keep dead ends out of menus. */
export type PageCaps = {
  patients: boolean;
  invoices: boolean;
  conversations: boolean;
  settingsRooms: boolean;
};
