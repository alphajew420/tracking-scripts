"use client";

import { Send } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { dashboardFetch } from "@/lib/dashboard-api";

type TeamState = {
  users: { id: string; email: string; name: string | null; email_verified_at: string | null; created_at: string }[];
  invites: { id: string; email: string; role: string; expires_at: string; created_at: string }[];
};

export function DashboardTeam() {
  const [team, setTeam] = useState<TeamState>({ users: [], invites: [] });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  async function loadTeam() {
    const result = await dashboardFetch("/v1/account/team");
    setTeam(result);
  }

  useEffect(() => {
    loadTeam().catch((err) => setError(err.message));
  }, []);

  function invite(formData: FormData) {
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await dashboardFetch("/v1/account/team/invites", {
          method: "POST",
          body: JSON.stringify({
            email: String(formData.get("email") ?? ""),
            role: String(formData.get("role") ?? "member"),
          }),
        });
        setMessage(result.token ? `Invite created. Dev token: ${result.token}` : "Invite created.");
        await loadTeam();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <>
      <form action={invite} className="panel pad span-4">
        <h2>Invite teammate</h2>
        <label className="field">Email<input name="email" type="email" placeholder="ops@example.com" required /></label>
        <label className="field">Role<select name="role"><option>member</option><option>admin</option></select></label>
        <button className="button primary" type="submit" disabled={isPending}><Send size={16} /> Send invite</button>
        {message ? <p className="form-success">{message}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </form>
      <div className="panel span-8 table-wrap">
        <table className="table">
          <thead><tr><th>User</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {team.users.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.name ?? user.email}</strong><br />{user.email}</td>
                <td>{user.email_verified_at ? "Verified" : "Unverified"}</td>
                <td>{new Date(user.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel span-12 table-wrap">
        {team.invites.length ? (
          <table className="table">
            <thead><tr><th>Invite</th><th>Role</th><th>Expires</th></tr></thead>
            <tbody>
              {team.invites.map((invite) => (
                <tr key={invite.id}>
                  <td><strong>{invite.email}</strong><br />{invite.id}</td>
                  <td>{invite.role}</td>
                  <td>{new Date(invite.expires_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state compact"><p>No pending invites.</p></div>
        )}
      </div>
    </>
  );
}
