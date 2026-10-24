-- Security review (F1/F4): a company that adds an EXISTING account only invites it. The membership
-- stays `invited` (no access, not listed as a company of the account) until the person accepts it
-- themselves; a pending invitation gives the inviting company no say over the account.

-- Only memberships the person accepted make an account "shared" between companies: a pending
-- invitation from another company must not stop the account's own company from resetting its
-- password or correcting its name.
CREATE OR REPLACE FUNCTION app_user_membership_count(p_user uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int FROM memberships WHERE user_id = p_user AND status <> 'invited'
$$;
--> statement-breakpoint

-- The signed-in user's pending invitations with the inviting company's and role's names. RLS lets a
-- user read their own membership rows, but tenants and roles only of companies they are an active
-- member of, so this narrow definer function returns exactly what the invitee needs to decide.
CREATE OR REPLACE FUNCTION app_my_invitations()
RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_name text, role_name text, invited_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, t.id, t.name, r.name, m.created_at
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    JOIN roles r ON r.id = m.role_id
   WHERE m.user_id = app_current_user() AND m.status = 'invited' AND t.status = 'active'
   ORDER BY m.created_at
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_my_invitations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_my_invitations() TO autohub_app;
--> statement-breakpoint
SELECT app_apply_tenant_fks();
--> statement-breakpoint
SELECT app_apply_privileges();
