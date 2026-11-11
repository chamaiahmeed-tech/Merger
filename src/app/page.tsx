"use client";

/**
 * الصفحة الرئيسية للوحة إدارة «مولّد الوسائط — خادم MCP».
 * تُظهر شارة صحة النظام (تُحدَّث كل 10 ثوانٍ) وتجمع بطاقات: المفاتيح، المهام، الربط.
 */

import { useCallback, useEffect, useState } from "react";
import ConnectCard from "../components/ConnectCard";
import KeysManager from "../components/KeysManager";
import TasksPanel from "../components/TasksPanel";
import { Badge, fetchJson, type HealthInfo } from "../components/shared";

function HealthBadge({ health, failed }: { health: HealthInfo | null; failed: boolean }) {
  const connected = !failed && health !== null && health.ok === true && health.database === "turso-connected";

  if (health === null && !failed) {
    return (
      <Badge tone="slate" className="animate-pulse">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-slate-400" />
        جارٍ التحقق من الحالة…
      </Badge>
    );
  }

  if (connected) {
    return (
      <Badge tone="green">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-400" />
        <span dir="ltr" className="font-bold">Turso</span>
        <span>متصل</span>
      </Badge>
    );
  }

  return (
    <Badge tone="red">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-red-400" />
      غير متصل
    </Badge>
  );
}

export default function Page() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const data = await fetchJson<HealthInfo>("/api/health");
      setHealth(data);
      setHealthFailed(false);
    } catch {
      setHealthFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    const intervalId = window.setInterval(() => void loadHealth(), 10_000);
    return () => window.clearInterval(intervalId);
  }, [loadHealth]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-4 sm:mb-10 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="bg-gradient-to-l from-cyan-400 to-violet-500 bg-clip-text text-2xl font-extrabold leading-snug text-transparent sm:text-3xl">
            مولّد الوسائط — خادم MCP
          </h1>
          <p className="mt-2 text-sm text-slate-400">توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HealthBadge health={health} failed={healthFailed} />
          {health !== null && health.merger && health.merger.healthy === false ? (
            <Badge tone="amber">
              <span aria-hidden="true">⚠</span>
              خدمة الدمج غير متصلة
            </Badge>
          ) : null}
        </div>
      </header>

      <div className="space-y-6">
        <KeysManager />
        <TasksPanel />
        <ConnectCard authRequired={health?.authRequired === true} />
      </div>
    </main>
  );
}
