# Wabot

WhatsApp instance manager backed by Supabase.

## Environment variables

Set these values in a local `.env` file or in the deployment environment:

```env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
PORT=3000
```

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY` are required. The dashboard uses Supabase Auth for account creation and sign-in; accounts are managed in the Supabase project's Authentication users list. The service role key is used only by the server and must never be exposed in browser code or committed to Git.

Configure the same variables in Render's environment settings. The app serves the sign-in page first, then sets an HTTP-only session cookie after Supabase Auth accepts the credentials.

## Run

```sh
npm install
npm start
```
