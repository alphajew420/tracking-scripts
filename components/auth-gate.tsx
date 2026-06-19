"use client";

import { LogOut } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type MeResponse = {
  authenticated: boolean;
  user: { email: string; account_name: string | null } | null;
};

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    dashboardFetch("/v1/auth/me")
      .then((result) => setMe(result))
      .catch(() => router.replace(`/login?next=${encodeURIComponent(pathname)}`));
  }, [pathname, router]);

  function logout() {
    startTransition(async () => {
      await dashboardFetch("/v1/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
      router.replace("/login");
    });
  }

  if (!me) {
    return <main className="main"><div className="panel pad"><p>Checking session...</p></div></main>;
  }

  return (
    <>
      <div className="session-bar">
        <span>{me.user?.account_name ?? "Workspace"}</span>
        <strong>{me.user?.email}</strong>
        <button className="button" onClick={logout} disabled={isPending}><LogOut size={15} /> Sign out</button>
      </div>
      {children}
    </>
  );
}
