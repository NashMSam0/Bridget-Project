# CodeBloom Supabase backend

The production backend is the codebloom-api Edge Function in Supabase project
fhfcmhaveodizblvidel. PostgreSQL holds profiles, projects, versions, guided mission
progress, game attempts, rewards, classes, assignments, submissions, settings and
audit records. Supabase Auth manages passwords and sessions.

The frontend uses VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.
Only the public project key belongs in the frontend. GEMINI_API_KEY,
GEMINI_MODEL and ALLOWED_ORIGINS are Edge Function secrets. Supabase injects
server-side project credentials. Never commit service-role keys.

Deploy with supabase functions deploy codebloom-api --remote=fhfcmhaveodizblvidel --use-api.
Review and apply numbered SQL migrations in order. The first two migrations were
applied through the dashboard and subsequent migrations through the authenticated
CLI. Do not reset the database. SQL Server learner data remains untouched and is
not automatically imported; existing learners need a planned identity/data import.

New accounts default to student. Administrators approve instructor roles through
the application. The first administrator must be an existing Supabase Auth user
whose profile role is set deliberately in the Supabase dashboard.
Email confirmation follows the Supabase project's Auth settings.

Firebase is replaced by Supabase Auth. Google sign-in requires Google OAuth
credentials and Supabase provider configuration. Python execution remains disabled,
as in the original optional-runner setup; the Python logic curriculum is available.

Validation:
- deno test --config supabase/functions/deno.json supabase/functions/codebloom-api/mission-engine_test.ts
- deno check --config supabase/functions/deno.json supabase/functions/codebloom-api/index.ts
- supabase db query --remote=fhfcmhaveodizblvidel --file supabase/verify-access.sql
- node supabase/verify-api.mjs <path-to-private-project-keys-json>
- npm run build and npm run lint

Database checks run in a rolled-back transaction. Live API checks create temporary
accounts, exercise student/instructor/admin flows, and clean up. Game missions retain
the original client-reported score/stars contract; reward amounts are fixed by the
server and cannot be duplicated on replay. Guided coding missions are executed
and scored on the server.
