-- D-047: supplier national IDs are stored only encrypted (national_id_enc, AES-GCM), with a keyed
-- hash (national_id_hash) for duplicate checks and the last 4 characters for display, like customers
-- (B-023). The key lives in the application, so SQL cannot encrypt the existing plain-text values:
-- after the API has been rolled, `node dist/cli.js encrypt-supplier-ids` moves them (OPERATIONS.md §1).
-- The application no longer writes suppliers.national_id. No CHECK constraint is added in this release:
-- the previous release, still serving while migrations run, writes that column, and every migration
-- must stay compatible with it. The next release drops the column after verifying it is empty.
--
-- Existing companies get the new permission on the system roles that new companies receive it on
-- (SYSTEM_ROLES): the owner role, which always holds every permission, and the branch-manager role
-- when it may also reveal customer national IDs (a company that removed customers.view_sensitive from
-- it keeps its choice). Custom roles are left to the company. Safe to run again.
UPDATE roles
   SET permissions = array_append(permissions, 'suppliers.view_sensitive'), updated_at = now()
 WHERE is_system
   AND (key = 'owner' OR (key = 'branch_manager' AND 'customers.view_sensitive' = ANY (permissions)))
   AND NOT ('suppliers.view_sensitive' = ANY (permissions));
--> statement-breakpoint
SELECT app_apply_tenant_fks();
--> statement-breakpoint
SELECT app_apply_privileges();
