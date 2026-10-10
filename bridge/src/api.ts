import type { Item, UploadResult } from "./outbox";

/**
 * The Bridge's side of /api/devices/v1. Every call carries the device key as
 * a Bearer token; pairing is the one call that does not, because pairing is
 * how the key is obtained.
 */

export type WorkItem = {
  /** The appointment or the doctor's request ("Take x-ray", "Request from device") this came from. */
  id: string;
  startsAt: string | null;
  doctor: string | null;
  description: string;
  patient: { id: string; fileNo: number | null; name: string; birthDate: string | null; sex: "M" | "F" | null };
};

export type WaitingRequest = {
  id: string;
  /** xray and photo come from a tooth on the dental chart; file is "Request from device", any result. */
  kind: string;
  teeth: string[];
  /** What the doctor wants, in their words — "12-lead ECG", "both eyes". Empty when they said nothing. */
  note?: string;
  createdAt: string;
  requestedBy: string | null;
  patient: WorkItem["patient"];
};

/** What a waiting request is for, in the words the window and the notification use. */
export function requestLabel(r: Pick<WaitingRequest, "kind">): string {
  return r.kind === "xray" ? "X-ray" : r.kind === "photo" ? "Photo" : "Result";
}

export class Api {
  constructor(
    public server: string,
    public key: string | null,
    private version: string
  ) {}

  private url(p: string) {
    return `${this.server.replace(/\/+$/, "")}/api/devices/v1${p}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.key ?? ""}`, "x-clinicti-bridge": this.version };
  }

  async pair(code: string, host: string) {
    const res = await fetch(this.url("/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, host, version: this.version }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      key?: string;
      device?: { id: string; name: string; kind: string };
      clinic?: { name: string };
      error?: string;
    };
    if (!res.ok || !body.key) return { ok: false as const, error: body.error ?? `http_${res.status}` };
    return { ok: true as const, key: body.key, device: body.device!, clinic: body.clinic! };
  }

  async upload(item: Item, data: Buffer): Promise<UploadResult> {
    const fd = new FormData();
    fd.set("file", new Blob([new Uint8Array(data)]), item.name);
    for (const [k, v] of Object.entries(item.fields)) if (v) fd.set(k, v);
    const res = await fetch(this.url("/images"), {
      method: "POST",
      headers: this.headers(),
      body: fd,
      // A CBCT slice over a slow clinic line: generous, but not forever.
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json().catch(() => ({}))) as { placed?: string; patientId?: string | null; error?: string };
    if (res.ok) return { ok: true, placed: body.placed ?? "patient", patientId: body.patientId ?? null };
    const error = body.error ?? `http_${res.status}`;
    if (res.status === 401) return { ok: false, retry: false, unpaired: true, error };
    // Refused for what the file is, not for when it was sent: trying again changes nothing.
    if ([400, 404, 409, 413, 415].includes(res.status)) return { ok: false, retry: false, error };
    return { ok: false, retry: true, error };
  }

  async status(report: unknown) {
    const res = await fetch(this.url("/status"), {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { device?: { name: string; kind: string }; clinic?: { name: string } };
    return { status: res.status, device: body.device ?? null, clinic: body.clinic ?? null };
  }

  /** Who a doctor is waiting on an image for, oldest first. */
  async requests(): Promise<WaitingRequest[]> {
    const res = await fetch(this.url("/requests"), { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) throw Object.assign(new Error("unpaired"), { unpaired: true });
    if (!res.ok) throw new Error(`requests_http_${res.status}`);
    return ((await res.json()) as { requests: WaitingRequest[] }).requests;
  }

  /** Today's booked patients and anyone a doctor is waiting on a result for. */
  async worklist(date?: string): Promise<WorkItem[]> {
    const q = date ? `?date=${date}` : "";
    const [wl, rq] = await Promise.all([
      fetch(this.url(`/worklist${q}`), { headers: this.headers(), signal: AbortSignal.timeout(15_000) }),
      fetch(this.url("/requests"), { headers: this.headers(), signal: AbortSignal.timeout(15_000) }),
    ]);
    if (!wl.ok || !rq.ok) throw new Error(`worklist_http_${wl.status}_${rq.status}`);
    const a = (await wl.json()) as { appointments: { id: string; startsAt: string; doctor: string | null; service: string | null; patient: WorkItem["patient"] }[] };
    const r = (await rq.json()) as { requests: WaitingRequest[] };
    const items: WorkItem[] = [
      // Somebody in the chair, waiting on the picture, first.
      ...r.requests.map((x) => ({
        id: x.id,
        startsAt: x.createdAt,
        doctor: x.requestedBy,
        description: [requestLabel(x), x.teeth.join(" "), x.note].filter(Boolean).join(" "),
        patient: x.patient,
      })),
      ...a.appointments.map((x) => ({ id: x.id, startsAt: x.startsAt, doctor: x.doctor, description: x.service ?? "Appointment", patient: x.patient })),
    ];
    // One line per patient: the machine needs the person, not every reason they came.
    const seen = new Set<string>();
    return items.filter((i) => (seen.has(i.patient.id) ? false : (seen.add(i.patient.id), true)));
  }
}
