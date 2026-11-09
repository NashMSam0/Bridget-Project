# Supabase migration — in progress

This directory is the new TypeScript backend. It is not a complete replacement
for the C# API yet. The frontend still uses the existing API until route parity
and Supabase integration are verified.

Implemented: PostgreSQL profiles with row-level security, safe default student
roles, verified Supabase sessions, profile reads and preferences, Gemini coach,
atomic daily AI quotas, and student project CRUD with database version history.
The frontend can opt into Supabase email/password Auth and bearer sessions using
VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY. Leave these unset until
the remaining feature routes are migrated. Gemini credentials belong only in
Supabase Edge Function secrets.

Still required: username login
compatibility; game and curriculum catalog import; mission validation and rewards;
classes, assignments, reports, admin and audit routes;
Google sign-in migration; Python execution replacement; existing learner import.

Do not point production at this function until those routes and access controls
are implemented and tested. No existing SQL Server data has been changed.

Once connected to the intended Supabase project, review and apply migrations,
set ALLOWED_ORIGINS to the exact Vercel origin, set GEMINI_API_KEY and GEMINI_MODEL
as function secrets, and deploy codebloom-api. The handler verifies bearer tokens
with Supabase Auth and queries PostgreSQL using the caller's RLS permissions.
