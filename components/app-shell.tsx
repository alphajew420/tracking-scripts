import Link from "next/link";
import { BarChart3, BellRing, CreditCard, KeyRound, LayoutDashboard, Mail, PackageSearch, Radio, Users, Webhook } from "lucide-react";
import { AuthGate } from "./auth-gate";

const nav = [
  { href: "/dashboard", label: "Trackings", icon: LayoutDashboard },
  { href: "/dashboard/keys", label: "API keys", icon: KeyRound },
  { href: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/dashboard/email", label: "Email", icon: Mail },
  { href: "/dashboard/usage", label: "Usage", icon: BarChart3 },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard },
  { href: "/dashboard/team", label: "Team", icon: Users },
  { href: "/dashboard/white-label", label: "Tracking page", icon: PackageSearch },
  { href: "/dashboard/realtime", label: "Realtime", icon: Radio },
  { href: "/dashboard/alerts", label: "Alerts", icon: BellRing },
];

export function AppShell({ children, active = "/dashboard" }: { children: React.ReactNode; active?: string }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand" aria-label="Trackified dashboard">
          <span className="mark"><PackageSearch size={19} /></span>
          Trackified
        </Link>
        <nav className="nav" aria-label="Dashboard navigation">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} data-active={active === item.href}>
                <Icon size={17} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <AuthGate><main className="main">{children}</main></AuthGate>
    </div>
  );
}
