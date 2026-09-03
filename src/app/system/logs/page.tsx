import { requireSystemAccess } from "@/modules/auth/guards";
import {
  buildAiLogReport,
  getSystemLogDay,
  shiftDay,
  todayInBangkok,
} from "@/modules/system/event-log-repository";
import type { SystemLogLevel } from "@/modules/system/event-log";
import { SystemLogView } from "./SystemLogView";

export const dynamic = "force-dynamic";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseLevel(value: string | undefined): SystemLogLevel | "all" {
  return value === "error" || value === "warn" || value === "info" ? value : "all";
}

export default async function SystemLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; level?: string }>;
}) {
  await requireSystemAccess();
  const { day: dayParam, level: levelParam } = await searchParams;

  const today = todayInBangkok();
  const day = dayParam && DAY_PATTERN.test(dayParam) ? dayParam : today;
  const level = parseLevel(levelParam);

  const result = await getSystemLogDay(day, { level });
  const data = result.data ?? { day, counts: { error: 0, warn: 0, info: 0 }, groups: [], recent: [] };

  return (
    <SystemLogView
      data={data}
      level={level}
      today={today}
      prevDay={shiftDay(day, -1)}
      nextDay={shiftDay(day, 1)}
      loadError={result.error?.userMessage ?? null}
      aiReport={buildAiLogReport(data)}
    />
  );
}
