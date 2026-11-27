import {
  Bell,
  Bot,
  Building2,
  Clock,
  DoorOpen,
  FileCheck2,
  FileSignature,
  FlaskConical,
  Link2,
  LifeBuoy,
  ListPlus,
  type LucideIcon,
  MessageCircle,
  MonitorSmartphone,
  Package,
  PenLine,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Tags,
  Users,
  Workflow,
  BadgeCheck,
  Network,
} from "lucide-react";
import { Tooth } from "@/components/ui/tooth-icon";
import type { CapabilityMap } from "@/lib/permissions";
import type { Dict } from "@/lib/i18n/en";

export type SettingsGroup = "clinic" | "team" | "services" | "patients" | "messaging" | "you";

export type SettingsItem = { href: string; label: string; icon: LucideIcon; group: SettingsGroup };

/**
 * Every settings page, once — for the menu that /settings now is and for the
 * side nav beside a page on a wide screen (Yamen, 2026-11-21: reaching Staff
 * meant reading the whole list). An icon and a short name each, in a few
 * groups, in the order a clinic meets them; the team second, because it is the
 * one people come back for.
 *
 * Each item shows for the capability its page guards on, so an item is never
 * a link into a redirect.
 */
export function settingsItems(
  slug: string,
  t: Dict,
  caps: CapabilityMap,
  has: { einvoicing: boolean; dental: boolean; face: boolean; devices: boolean; branches?: boolean }
): SettingsItem[] {
  const base = `/c/${slug}/settings`;
  const all: (SettingsItem & { show?: boolean })[] = [
    { href: `${base}/profile`, label: t.settings.profile, icon: Building2, group: "clinic" },
    { href: `${base}/hours`, label: t.settings.workingHours, icon: Clock, group: "clinic" },
    { href: `${base}/rooms`, label: t.rooms.title, icon: DoorOpen, group: "clinic", show: caps["settings.services"] },
    { href: `${base}/devices`, label: t.devices.tab, icon: MonitorSmartphone, group: "clinic", show: has.devices && caps["settings.clinic"] },
    // What the clinic's subscription includes (lib/plans) — read-only, for anyone in Settings.
    { href: `${base}/plan`, label: t.plans.yourPlan, icon: BadgeCheck, group: "clinic" },
    // The clinic's branches side by side, for whoever reads the takings (lib/branches-report).
    { href: `/c/${slug}/branches`, label: t.branches.title, icon: Network, group: "clinic", show: !!has.branches && caps["invoices.analytics"] },
    { href: `${base}/support-visits`, label: t.supportVisits.tab, icon: LifeBuoy, group: "clinic", show: caps["settings.support_visits"] },
    { href: `${base}/staff`, label: t.settings.staff, icon: Users, group: "team", show: caps["settings.staff"] },
    { href: `${base}/services`, label: t.settings.services, icon: Stethoscope, group: "services", show: caps["settings.services"] },
    { href: `${base}/prices`, label: t.settings.treatmentPrices, icon: Tooth, group: "services", show: has.dental && caps["settings.services"] },
    { href: `${base}/labs`, label: t.settings.dentalLabs, icon: FlaskConical, group: "services", show: has.dental && caps["settings.services"] },
    { href: `${base}/face-prices`, label: t.settings.facePrices, icon: Sparkles, group: "services", show: has.face && caps["settings.services"] },
    { href: `${base}/face-packages`, label: t.settings.facePackages, icon: Package, group: "services", show: has.face && caps["settings.services"] },
    { href: `${base}/insurers`, label: t.insurers.title, icon: ShieldCheck, group: "services", show: caps["insurance.companies"] },
    { href: `${base}/invoicing`, label: t.settings.invoiceSettings, icon: ReceiptText, group: "services" },
    { href: `${base}/einvoicing`, label: t.einvoicing.title, icon: FileCheck2, group: "services", show: has.einvoicing && caps["settings.clinic"] },
    { href: `${base}/fields`, label: t.fields.title, icon: ListPlus, group: "patients", show: caps["settings.clinic"] },
    { href: `${base}/tags`, label: t.tags.title, icon: Tags, group: "patients", show: caps["settings.tags"] },
    // Consent-form templates belong to the documents module (not on the Doctor plan, lib/plans).
    { href: `${base}/documents`, label: t.settings.documentTemplates, icon: FileSignature, group: "patients", show: caps.documents },
    { href: `${base}/whatsapp`, label: t.settings.whatsapp, icon: MessageCircle, group: "messaging", show: caps["settings.whatsapp"] },
    { href: `${base}/booking`, label: t.settings.bookingLinks, icon: Link2, group: "messaging", show: caps["settings.booking"] },
    { href: `/c/${slug}/automations`, label: t.settings.groups.autoMessages, icon: Workflow, group: "messaging", show: caps.automations },
    { href: `/c/${slug}/ai`, label: t.nav.aiAgent, icon: Bot, group: "messaging", show: caps.ai },
    // Personal, not clinic configuration — outside /settings so a member without it still reaches them.
    { href: `/c/${slug}/signature`, label: t.settings.mySignature, icon: PenLine, group: "you" },
    { href: `/c/${slug}/notifications`, label: t.settings.notificationPrefs, icon: Bell, group: "you" },
  ];
  return all.filter((i) => i.show !== false).map(({ show: _show, ...i }) => i);
}

export const SETTINGS_GROUPS: SettingsGroup[] = ["clinic", "team", "services", "patients", "messaging", "you"];
