\set ON_ERROR_STOP on

-- The first migration creates this least-privileged login with a local-only
-- development password. Replace it on every staging deployment without placing
-- the cloud password in migration history.
SELECT format('ALTER ROLE pethotel_app PASSWORD %L', :'app_password') \gexec
